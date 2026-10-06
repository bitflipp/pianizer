// Package api implements the HTTP surface for server-side project storage:
// projects and their append-only revision history, scoped per user. The
// user is whoever Authelia (via the reverse proxy) says it is, read from the
// Remote-User header by pkg/authn; the server must be reachable only through
// that proxy.
package api

import (
	"io/fs"
	"net/http"

	"pianizer/internal/store"
	"pianizer/pkg/authn"
)

// maxRevisionBytes caps the size of a single POSTed revision body.
const maxRevisionBytes = 32 << 20 // 32 MiB

// maxProjectBodyBytes caps the size of a POSTed create-project body (just a name).
const maxProjectBodyBytes = 4 << 10 // 4 KiB

// owner returns the authenticated user's name. Only valid behind
// authn.Middleware, which rejects requests without a user.
func owner(r *http.Request) string {
	u, _ := authn.From(r.Context())
	return u.Name
}

// NewMux builds the full HTTP handler: the JSON API under /api/ (requires an
// authenticated user), and the frontend (assets) for everything else.
func NewMux(st store.Store, assets fs.FS) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/projects", handleListProjects(st))
	mux.HandleFunc("POST /api/projects", handleCreateProject(st))
	mux.HandleFunc("GET /api/projects/{id}/revisions", handleListRevisions(st))
	mux.HandleFunc("POST /api/projects/{id}/revisions", handleCreateRevision(st))
	mux.HandleFunc("GET /api/projects/{id}/revisions/{no}", handleGetRevision(st))
	mux.HandleFunc("DELETE /api/projects/{id}/revisions/{no}", handleDeleteRevision(st))

	root := http.NewServeMux()
	root.Handle("/api/", authn.Middleware(mux))
	root.Handle("/", http.FileServerFS(assets))

	return root
}
