package authn

import (
	"context"
	"net/http"
	"strings"
)

type User struct {
	Name, Email string
	Groups      []string
}

type ctxKey struct{}

func From(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(ctxKey{}).(User)
	return u, ok
}

func (u User) In(group string) bool {
	for _, g := range u.Groups {
		if g == group {
			return true
		}
	}
	return false
}

// FromRequest reads the identity Authelia forwards in request headers. It
// reports false when no user is present. Only safe if the app is reachable
// exclusively through Caddy (bind to localhost or a private docker network).
func FromRequest(r *http.Request) (User, bool) {
	name := r.Header.Get("Remote-User")
	if name == "" {
		return User{}, false
	}
	u := User{Name: name, Email: r.Header.Get("Remote-Email")}
	if g := r.Header.Get("Remote-Groups"); g != "" {
		u.Groups = strings.Split(g, ",")
	}
	return u, true
}

// Middleware trusts Authelia's headers; see FromRequest for the caveat.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := FromRequest(r)
		if !ok {
			http.Error(w, "unauthenticated", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, u)))
	})
}

func RequireGroup(group string, next http.Handler) http.Handler {
	return Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, _ := From(r.Context()); !u.In(group) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	}))
}
