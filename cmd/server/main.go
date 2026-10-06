// Command server runs the Pianizer HTTP server: the static frontend plus
// the /api/ project-storage routes, backed by MariaDB. Authentication is
// Authelia's job: the server trusts the Remote-User header and so must be
// reachable only through the reverse proxy (see pkg/authn).
package main

import (
	"context"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	assets "pianizer"
	"pianizer/internal/api"
	"pianizer/internal/store"
)

func main() {
	addr := flag.String("addr", envOr("PIANIZER_ADDR", ":6789"), "address to listen on")
	dsn := flag.String("dsn", os.Getenv("PIANIZER_DB_DSN"), "MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true")
	devAssets := flag.String("dev-assets", os.Getenv("PIANIZER_DEV_ASSETS"), "serve frontend assets live from this directory instead of the embedded copy (dev only)")
	devUser := flag.String("dev-user", os.Getenv("PIANIZER_DEV_USER"), "act as this user when no Remote-User header is present (local dev without Authelia; never set in production)")
	adopt := flag.String("adopt-orphans", "", "assign projects saved before per-user storage (no owner) to this user, then exit")
	flag.Parse()

	if *dsn == "" {
		log.Fatal("no database DSN: set -dsn or PIANIZER_DB_DSN")
	}

	db, err := store.OpenMariaDB(*dsn)
	if err != nil {
		log.Fatalf("connect to database: %v", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = db.Migrate(ctx)
	cancel()
	if err != nil {
		log.Fatalf("migrate database: %v", err)
	}

	if *adopt != "" {
		n, err := db.AdoptOrphans(context.Background(), *adopt)
		if err != nil {
			log.Fatalf("adopt orphans: %v", err)
		}
		log.Printf("assigned %d project(s) to %q", n, *adopt)
		return
	}

	var assetFS fs.FS = assets.FS
	if *devAssets != "" {
		assetFS = os.DirFS(*devAssets)
		log.Printf("serving frontend assets live from %s (dev mode)", *devAssets)
	}

	var mux http.Handler = api.NewMux(db, assetFS)
	if *devUser != "" {
		log.Printf("WARNING: unauthenticated requests are treated as user %q (dev mode)", *devUser)
		inner := mux
		mux = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Remote-User") == "" {
				r.Header.Set("Remote-User", *devUser)
			}
			inner.ServeHTTP(w, r)
		})
	}

	srv := &http.Server{Addr: *addr, Handler: mux}

	go func() {
		log.Printf("listening on %s", *addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop

	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
