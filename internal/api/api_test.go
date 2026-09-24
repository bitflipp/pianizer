package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"pianizer/internal/store"
)

func newTestServer() *httptest.Server {
	assets := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")},
	}
	return httptest.NewServer(NewMux(store.NewMemory(), assets))
}

func postJSON(t *testing.T, url string, body string) *http.Response {
	t.Helper()
	res, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return res
}

func decode(t *testing.T, res *http.Response, v any) {
	t.Helper()
	defer res.Body.Close()
	if err := json.NewDecoder(res.Body).Decode(v); err != nil {
		t.Fatalf("decode response: %v", err)
	}
}

func TestCreateAndListProjects(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res := postJSON(t, srv.URL+"/api/projects", `{"name":"Nocturne"}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create: got status %d", res.StatusCode)
	}
	var created projectJSON
	decode(t, res, &created)
	if created.Name != "Nocturne" || created.ID == 0 {
		t.Fatalf("unexpected created project: %+v", created)
	}

	res = postJSON(t, srv.URL+"/api/projects", `{"name":"Nocturne"}`)
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate create: got status %d, want 409", res.StatusCode)
	}
	res.Body.Close()

	res = postJSON(t, srv.URL+"/api/projects", `{"name":"  "}`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank name: got status %d, want 400", res.StatusCode)
	}
	res.Body.Close()

	res, err := http.Get(srv.URL + "/api/projects")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var listed struct {
		Projects []projectJSON `json:"projects"`
	}
	decode(t, res, &listed)
	if len(listed.Projects) != 1 || listed.Projects[0].ID != created.ID {
		t.Fatalf("unexpected project list: %+v", listed.Projects)
	}
}

func TestRevisionLifecycle(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res := postJSON(t, srv.URL+"/api/projects", `{"name":"Etude"}`)
	var proj projectJSON
	decode(t, res, &proj)
	base := srv.URL + "/api/projects/" + itoa(proj.ID)

	res = postJSON(t, base+"/revisions", `{"version":1,"notes":[]}`)
	if res.StatusCode != http.StatusCreated {
		t.Fatalf("create revision: got status %d", res.StatusCode)
	}
	var meta revisionMetaJSON
	decode(t, res, &meta)
	if meta.RevisionNo != 1 {
		t.Fatalf("first revision number = %d, want 1", meta.RevisionNo)
	}

	postJSON(t, base+"/revisions", `{"version":1,"notes":[{"id":1}]}`).Body.Close()

	res, _ = http.Get(base + "/revisions")
	var listed struct {
		Revisions []revisionMetaJSON `json:"revisions"`
	}
	decode(t, res, &listed)
	if len(listed.Revisions) != 2 || listed.Revisions[0].RevisionNo != 2 {
		t.Fatalf("unexpected revisions list: %+v", listed.Revisions)
	}

	res, err := http.Get(base + "/revisions/1")
	if err != nil {
		t.Fatalf("get revision 1: %v", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if strings.TrimSpace(string(body)) != `{"version":1,"notes":[]}` {
		t.Fatalf("revision 1 body = %q", body)
	}

	res, err = http.Get(base + "/revisions/99")
	if err != nil {
		t.Fatalf("get missing revision: %v", err)
	}
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("missing revision: got status %d, want 404", res.StatusCode)
	}
	res.Body.Close()
}

func TestUnknownProjectIs404(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res, _ := http.Get(srv.URL + "/api/projects/999/revisions")
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("list revisions for unknown project: got %d, want 404", res.StatusCode)
	}
	res.Body.Close()

	res = postJSON(t, srv.URL+"/api/projects/999/revisions", `{}`)
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("create revision for unknown project: got %d, want 404", res.StatusCode)
	}
	res.Body.Close()
}

func TestInvalidRevisionBody(t *testing.T) {
	srv := newTestServer()
	defer srv.Close()

	res := postJSON(t, srv.URL+"/api/projects", `{"name":"Prelude"}`)
	var proj projectJSON
	decode(t, res, &proj)

	res = postJSON(t, srv.URL+"/api/projects/"+itoa(proj.ID)+"/revisions", `not json`)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid JSON body: got %d, want 400", res.StatusCode)
	}
	res.Body.Close()
}

func itoa(id int64) string {
	return strconv.FormatInt(id, 10)
}
