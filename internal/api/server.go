// Package api implements the HTTP surface for server-side project storage:
// projects and their append-only revision history. Auth is not handled
// here — the app is single-user and trusts a reverse proxy to gate access
// to this server entirely.
package api

import (
	"io/fs"
	"net/http"

	"pianizer/internal/store"
)

// maxRevisionBytes caps the size of a single POSTed revision body.
const maxRevisionBytes = 32 << 20 // 32 MiB

// NewMux builds the full HTTP handler: the JSON API under /api/, and the
// frontend (assets) for everything else.
func NewMux(st store.Store, assets fs.FS) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/projects", handleListProjects(st))
	mux.HandleFunc("POST /api/projects", handleCreateProject(st))
	mux.HandleFunc("GET /api/projects/{id}/revisions", handleListRevisions(st))
	mux.HandleFunc("POST /api/projects/{id}/revisions", handleCreateRevision(st))
	mux.HandleFunc("GET /api/projects/{id}/revisions/{no}", handleGetRevision(st))

	mux.Handle("/", http.FileServerFS(assets))

	return mux
}
