package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/go-sql-driver/mysql"
)

// MariaDB is a Store backed by a MariaDB (or MySQL-compatible) database.
// The DSN must include parseTime=true so DATETIME columns scan into
// time.Time directly (e.g. "user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true").
type MariaDB struct {
	db *sql.DB
}

// OpenMariaDB opens and pings a connection pool for dsn.
func OpenMariaDB(dsn string) (*MariaDB, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &MariaDB{db: db}, nil
}

// Close closes the underlying connection pool.
func (m *MariaDB) Close() error { return m.db.Close() }

// Migrate applies the schema, creating tables that don't already exist.
func (m *MariaDB) Migrate(ctx context.Context) error {
	if _, err := m.db.ExecContext(ctx, ddlProjects); err != nil {
		return fmt.Errorf("create projects table: %w", err)
	}
	if _, err := m.db.ExecContext(ctx, ddlProjectRevisions); err != nil {
		return fmt.Errorf("create project_revisions table: %w", err)
	}
	return nil
}

func (m *MariaDB) ListProjects(ctx context.Context) ([]Project, error) {
	rows, err := m.db.QueryContext(ctx, `
		SELECT p.id, p.name, p.created_at, COUNT(r.id), MAX(r.created_at)
		FROM projects p
		LEFT JOIN project_revisions r ON r.project_id = p.id
		GROUP BY p.id, p.name, p.created_at
		ORDER BY MAX(r.created_at) IS NULL, MAX(r.created_at) DESC, p.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var projects []Project
	for rows.Next() {
		var p Project
		var lastSaved sql.NullTime
		if err := rows.Scan(&p.ID, &p.Name, &p.CreatedAt, &p.RevisionCount, &lastSaved); err != nil {
			return nil, err
		}
		if lastSaved.Valid {
			t := lastSaved.Time
			p.LastSavedAt = &t
		}
		projects = append(projects, p)
	}
	return projects, rows.Err()
}

func (m *MariaDB) CreateProject(ctx context.Context, name string) (Project, error) {
	res, err := m.db.ExecContext(ctx, `INSERT INTO projects (name) VALUES (?)`, name)
	if err != nil {
		var mysqlErr *mysql.MySQLError
		if errors.As(err, &mysqlErr) && mysqlErr.Number == 1062 {
			return Project{}, ErrDuplicateName
		}
		return Project{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Project{}, err
	}
	var p Project
	err = m.db.QueryRowContext(ctx, `SELECT id, name, created_at FROM projects WHERE id=?`, id).
		Scan(&p.ID, &p.Name, &p.CreatedAt)
	return p, err
}

func (m *MariaDB) projectExists(ctx context.Context, projectID int64) (bool, error) {
	var exists bool
	err := m.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)`, projectID).Scan(&exists)
	return exists, err
}

func (m *MariaDB) ListRevisions(ctx context.Context, projectID int64) ([]RevisionMeta, error) {
	ok, err := m.projectExists(ctx, projectID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrNotFound
	}

	rows, err := m.db.QueryContext(ctx, `
		SELECT revision_no, created_at, size_bytes
		FROM project_revisions WHERE project_id=?
		ORDER BY revision_no DESC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []RevisionMeta
	for rows.Next() {
		var r RevisionMeta
		if err := rows.Scan(&r.RevisionNo, &r.CreatedAt, &r.SizeBytes); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (m *MariaDB) GetRevision(ctx context.Context, projectID int64, revisionNo int) (Revision, error) {
	var rev Revision
	err := m.db.QueryRowContext(ctx, `
		SELECT revision_no, created_at, size_bytes, data
		FROM project_revisions WHERE project_id=? AND revision_no=?`, projectID, revisionNo).
		Scan(&rev.RevisionNo, &rev.CreatedAt, &rev.SizeBytes, &rev.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return Revision{}, ErrNotFound
	}
	return rev, err
}

// CreateRevision assigns the next revision_no for projectID and inserts data
// as a new immutable revision. The read-modify-write of the next number and
// the insert happen inside one transaction with FOR UPDATE locks, so
// concurrent saves to the same project can't race onto the same number.
func (m *MariaDB) CreateRevision(ctx context.Context, projectID int64, data string) (RevisionMeta, error) {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return RevisionMeta{}, err
	}
	defer tx.Rollback()

	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=? FOR UPDATE)`, projectID).Scan(&exists); err != nil {
		return RevisionMeta{}, err
	}
	if !exists {
		return RevisionMeta{}, ErrNotFound
	}

	var next int
	if err := tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(revision_no), 0) + 1 FROM project_revisions WHERE project_id=? FOR UPDATE`,
		projectID).Scan(&next); err != nil {
		return RevisionMeta{}, err
	}

	size := len(data)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO project_revisions (project_id, revision_no, data, size_bytes) VALUES (?, ?, ?, ?)`,
		projectID, next, data, size); err != nil {
		return RevisionMeta{}, err
	}

	var createdAt time.Time
	if err := tx.QueryRowContext(ctx,
		`SELECT created_at FROM project_revisions WHERE project_id=? AND revision_no=?`,
		projectID, next).Scan(&createdAt); err != nil {
		return RevisionMeta{}, err
	}

	if err := tx.Commit(); err != nil {
		return RevisionMeta{}, err
	}
	return RevisionMeta{RevisionNo: next, CreatedAt: createdAt, SizeBytes: size}, nil
}
