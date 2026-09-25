// Package store defines the persistence contract for projects and their
// revision history, plus a MariaDB-backed implementation and an in-memory
// fake used by tests and the API package's own tests.
package store

import (
	"context"
	"errors"
	"time"
)

// ErrNotFound is returned when a requested project or revision doesn't exist.
var ErrNotFound = errors.New("not found")

// ErrDuplicateName is returned by CreateProject when the name is already taken.
var ErrDuplicateName = errors.New("project name already exists")

// Project is a named container for a sequence of revisions.
type Project struct {
	ID            int64
	Name          string
	CreatedAt     time.Time
	RevisionCount int
	LastSavedAt   *time.Time // nil if the project has no revisions yet
}

// RevisionMeta describes one saved revision without its (potentially large) data.
type RevisionMeta struct {
	RevisionNo int
	CreatedAt  time.Time
	SizeBytes  int
}

// Revision is a RevisionMeta plus the full project JSON it was saved with.
type Revision struct {
	RevisionMeta
	Data string
}

// Store is the persistence contract. Revisions are immutable and numbered
// per-project starting at 1, and are never renumbered — there is no update,
// only append and delete-by-number. A deleted revision's number is not
// reused while sibling revisions remain, since CreateRevision always numbers
// off the current max; it can only be reused once every revision of a
// project has been deleted.
type Store interface {
	ListProjects(ctx context.Context) ([]Project, error)
	CreateProject(ctx context.Context, name string) (Project, error)
	ListRevisions(ctx context.Context, projectID int64) ([]RevisionMeta, error)
	GetRevision(ctx context.Context, projectID int64, revisionNo int) (Revision, error)
	CreateRevision(ctx context.Context, projectID int64, data string) (RevisionMeta, error)
	DeleteRevision(ctx context.Context, projectID int64, revisionNo int) error
}
