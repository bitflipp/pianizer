package store

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Memory is an in-memory Store, used by Go tests (internal/api and this
// package) so they don't need a live MariaDB, and usable as a standalone
// no-DB demo mode.
type Memory struct {
	mu        sync.Mutex
	nextID    int64
	projects  map[int64]*Project
	revisions map[int64][]Revision // projectID -> revisions, in append order
}

// NewMemory returns an empty in-memory Store.
func NewMemory() *Memory {
	return &Memory{
		projects:  make(map[int64]*Project),
		revisions: make(map[int64][]Revision),
	}
}

func (m *Memory) ListProjects(ctx context.Context) ([]Project, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	out := make([]Project, 0, len(m.projects))
	for _, p := range m.projects {
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool {
		li, lj := out[i].LastSavedAt, out[j].LastSavedAt
		if li == nil && lj == nil {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		if li == nil {
			return false
		}
		if lj == nil {
			return true
		}
		return li.After(*lj)
	})
	return out, nil
}

func (m *Memory) CreateProject(ctx context.Context, name string) (Project, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for _, p := range m.projects {
		if p.Name == name {
			return Project{}, ErrDuplicateName
		}
	}

	m.nextID++
	p := &Project{ID: m.nextID, Name: name, CreatedAt: time.Now().UTC()}
	m.projects[p.ID] = p
	return *p, nil
}

func (m *Memory) ListRevisions(ctx context.Context, projectID int64) ([]RevisionMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.projects[projectID]; !ok {
		return nil, ErrNotFound
	}
	revs := m.revisions[projectID]
	out := make([]RevisionMeta, len(revs))
	for i, r := range revs {
		out[len(revs)-1-i] = r.RevisionMeta // newest first
	}
	return out, nil
}

func (m *Memory) GetRevision(ctx context.Context, projectID int64, revisionNo int) (Revision, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.projects[projectID]; !ok {
		return Revision{}, ErrNotFound
	}
	for _, r := range m.revisions[projectID] {
		if r.RevisionNo == revisionNo {
			return r, nil
		}
	}
	return Revision{}, ErrNotFound
}

func (m *Memory) CreateRevision(ctx context.Context, projectID int64, data string) (RevisionMeta, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	p, ok := m.projects[projectID]
	if !ok {
		return RevisionMeta{}, ErrNotFound
	}

	next := len(m.revisions[projectID]) + 1
	rev := Revision{
		RevisionMeta: RevisionMeta{
			RevisionNo: next,
			CreatedAt:  time.Now().UTC(),
			SizeBytes:  len(data),
		},
		Data: data,
	}
	m.revisions[projectID] = append(m.revisions[projectID], rev)

	p.RevisionCount = next
	t := rev.CreatedAt
	p.LastSavedAt = &t

	return rev.RevisionMeta, nil
}
