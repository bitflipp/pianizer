package authn

import (
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestFromRequest(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    User
		ok      bool
	}{
		{"missing user", map[string]string{"Remote-Groups": "admins"}, User{}, false},
		{"no groups", map[string]string{"Remote-User": "clara", "Remote-Email": "c@example.com"}, User{Name: "clara", Email: "c@example.com"}, true},
		{"groups", map[string]string{"Remote-User": "clara", "Remote-Groups": "family,admins"}, User{Name: "clara", Groups: []string{"family", "admins"}}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/", nil)
			for k, v := range tt.headers {
				r.Header.Set(k, v)
			}
			got, ok := FromRequest(r)
			if ok != tt.ok || !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestUserIn(t *testing.T) {
	u := User{Groups: []string{"a", "b"}}
	if !u.In("b") || u.In("c") {
		t.Fatal("In reported wrong membership")
	}
}
