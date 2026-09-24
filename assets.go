// Package assets embeds the static frontend so the compiled server binary
// can serve the whole app without the source tree present on disk.
package assets

import "embed"

//go:embed index.html icon.svg engine ui
var FS embed.FS
