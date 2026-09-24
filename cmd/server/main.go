// Command server runs the Pianizer HTTP server: the static frontend plus
// the /api/ project-storage routes, backed by MariaDB. Auth is not handled
// here — the app is single-user and expects to sit behind an
// already-authenticating reverse proxy.
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
	addr := flag.String("addr", envOr("PIANIZER_ADDR", ":8080"), "address to listen on")
	dsn := flag.String("dsn", os.Getenv("PIANIZER_DB_DSN"), "MariaDB DSN, e.g. user:pass@tcp(127.0.0.1:3306)/pianizer?parseTime=true")
	devAssets := flag.String("dev-assets", os.Getenv("PIANIZER_DEV_ASSETS"), "serve frontend assets live from this directory instead of the embedded copy (dev only)")
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

	var assetFS fs.FS = assets.FS
	if *devAssets != "" {
		assetFS = os.DirFS(*devAssets)
		log.Printf("serving frontend assets live from %s (dev mode)", *devAssets)
	}

	mux := api.NewMux(db, assetFS)

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
