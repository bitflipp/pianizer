package api

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"pianizer/internal/store"
)

type projectJSON struct {
	ID            int64      `json:"id"`
	Name          string     `json:"name"`
	CreatedAt     time.Time  `json:"createdAt"`
	RevisionCount int        `json:"revisionCount"`
	LastSavedAt   *time.Time `json:"lastSavedAt"`
}

func toProjectJSON(p store.Project) projectJSON {
	return projectJSON{
		ID:            p.ID,
		Name:          p.Name,
		CreatedAt:     p.CreatedAt,
		RevisionCount: p.RevisionCount,
		LastSavedAt:   p.LastSavedAt,
	}
}

func handleListProjects(st store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		projects, err := st.ListProjects(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		out := make([]projectJSON, len(projects))
		for i, p := range projects {
			out[i] = toProjectJSON(p)
		}
		writeJSON(w, http.StatusOK, map[string]any{"projects": out})
	}
}

func handleCreateProject(st store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if !decodeJSON(w, r, &body, 4<<10) {
			return
		}
		name := strings.TrimSpace(body.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "name must not be empty")
			return
		}

		p, err := st.CreateProject(r.Context(), name)
		switch {
		case errors.Is(err, store.ErrDuplicateName):
			writeError(w, http.StatusConflict, "a project named \""+name+"\" already exists")
		case err != nil:
			writeError(w, http.StatusInternalServerError, err.Error())
		default:
			writeJSON(w, http.StatusCreated, toProjectJSON(p))
		}
	}
}
