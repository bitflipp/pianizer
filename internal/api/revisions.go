package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"pianizer/internal/store"
)

type revisionMetaJSON struct {
	RevisionNo int       `json:"revisionNo"`
	CreatedAt  time.Time `json:"createdAt"`
	SizeBytes  int       `json:"sizeBytes"`
}

func toRevisionMetaJSON(r store.RevisionMeta) revisionMetaJSON {
	return revisionMetaJSON{RevisionNo: r.RevisionNo, CreatedAt: r.CreatedAt, SizeBytes: r.SizeBytes}
}

func pathInt64(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	v, err := strconv.ParseInt(r.PathValue(name), 10, 64)
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return 0, false
	}
	return v, true
}

func pathInt(w http.ResponseWriter, r *http.Request, name string) (int, bool) {
	v, err := strconv.Atoi(r.PathValue(name))
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return 0, false
	}
	return v, true
}

func handleListRevisions(st store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		projectID, ok := pathInt64(w, r, "id")
		if !ok {
			return
		}

		revs, err := st.ListRevisions(r.Context(), projectID)
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "no such project")
		case err != nil:
			writeError(w, http.StatusInternalServerError, err.Error())
		default:
			out := make([]revisionMetaJSON, len(revs))
			for i, rv := range revs {
				out[i] = toRevisionMetaJSON(rv)
			}
			writeJSON(w, http.StatusOK, map[string]any{"revisions": out})
		}
	}
}

func handleCreateRevision(st store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		projectID, ok := pathInt64(w, r, "id")
		if !ok {
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxRevisionBytes)
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "body too large or unreadable")
			return
		}
		if !json.Valid(body) {
			writeError(w, http.StatusBadRequest, "body is not valid JSON")
			return
		}

		meta, err := st.CreateRevision(r.Context(), projectID, string(body))
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "no such project")
		case err != nil:
			writeError(w, http.StatusInternalServerError, err.Error())
		default:
			writeJSON(w, http.StatusCreated, toRevisionMetaJSON(meta))
		}
	}
}

func handleGetRevision(st store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		projectID, ok := pathInt64(w, r, "id")
		if !ok {
			return
		}
		revisionNo, ok := pathInt(w, r, "no")
		if !ok {
			return
		}

		rev, err := st.GetRevision(r.Context(), projectID, revisionNo)
		switch {
		case errors.Is(err, store.ErrNotFound):
			writeError(w, http.StatusNotFound, "no such project or revision")
		case err != nil:
			writeError(w, http.StatusInternalServerError, err.Error())
		default:
			// Verbatim, unwrapped — the client feeds this straight into
			// state.loadProject(await res.json()), same as a local file load.
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(rev.Data))
		}
	}
}
