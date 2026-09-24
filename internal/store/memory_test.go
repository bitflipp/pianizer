package store

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryCreateProjectDuplicateName(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	if _, err := m.CreateProject(ctx, "Nocturne"); err != nil {
		t.Fatalf("first create: %v", err)
	}
	if _, err := m.CreateProject(ctx, "Nocturne"); !errors.Is(err, ErrDuplicateName) {
		t.Fatalf("want ErrDuplicateName, got %v", err)
	}
}

func TestMemoryRevisionSequencingIsPerProject(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	a, _ := m.CreateProject(ctx, "A")
	b, _ := m.CreateProject(ctx, "B")

	for i, want := range []int{1, 2, 3} {
		rev, err := m.CreateRevision(ctx, a.ID, "{}")
		if err != nil {
			t.Fatalf("create revision %d for A: %v", i, err)
		}
		if rev.RevisionNo != want {
			t.Fatalf("A revision %d: got RevisionNo=%d, want %d", i, rev.RevisionNo, want)
		}
	}

	rev, err := m.CreateRevision(ctx, b.ID, "{}")
	if err != nil {
		t.Fatalf("create revision for B: %v", err)
	}
	if rev.RevisionNo != 1 {
		t.Fatalf("B's first revision: got RevisionNo=%d, want 1", rev.RevisionNo)
	}
}

func TestMemoryListRevisionsNewestFirst(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	p, _ := m.CreateProject(ctx, "A")
	m.CreateRevision(ctx, p.ID, "one")
	m.CreateRevision(ctx, p.ID, "two")
	m.CreateRevision(ctx, p.ID, "three")

	revs, err := m.ListRevisions(ctx, p.ID)
	if err != nil {
		t.Fatalf("list revisions: %v", err)
	}
	if len(revs) != 3 {
		t.Fatalf("got %d revisions, want 3", len(revs))
	}
	for i, want := range []int{3, 2, 1} {
		if revs[i].RevisionNo != want {
			t.Fatalf("revs[%d].RevisionNo = %d, want %d", i, revs[i].RevisionNo, want)
		}
	}
}

func TestMemoryNotFoundErrors(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	if _, err := m.ListRevisions(ctx, 999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ListRevisions unknown project: got %v, want ErrNotFound", err)
	}
	if _, err := m.GetRevision(ctx, 999, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetRevision unknown project: got %v, want ErrNotFound", err)
	}
	if _, err := m.CreateRevision(ctx, 999, "{}"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateRevision unknown project: got %v, want ErrNotFound", err)
	}

	p, _ := m.CreateProject(ctx, "A")
	if _, err := m.GetRevision(ctx, p.ID, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetRevision unknown revision: got %v, want ErrNotFound", err)
	}
}

func TestMemoryGetRevisionRoundTrips(t *testing.T) {
	m := NewMemory()
	ctx := context.Background()

	p, _ := m.CreateProject(ctx, "A")
	m.CreateRevision(ctx, p.ID, `{"notes":[]}`)

	rev, err := m.GetRevision(ctx, p.ID, 1)
	if err != nil {
		t.Fatalf("get revision: %v", err)
	}
	if rev.Data != `{"notes":[]}` {
		t.Fatalf("got Data=%q", rev.Data)
	}
}
