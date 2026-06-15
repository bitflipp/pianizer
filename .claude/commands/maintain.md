---
description: Maintainability pass on the codebase, then sync CLAUDE.md with any deviations
---

Run a maintainability pass and a CLAUDE.md sync on: $ARGUMENTS (if empty, pick the
most-recently-edited source file for the code scope; always scan everything for the
doc sync).

## Pass 1 — Code

What counts as a finding (in rough priority order):
- Long functions worth splitting, with a clear seam
- Magic numbers/strings that should be named constants
- Duplicated logic that wants a small helper (only if used 2+ times — no
  premature abstraction)
- Unclear identifiers (loop vars, params, fields)
- Naming inconsistency — one concept spelled multiple ways across the tree. Pick a
  root and grep its variants: abbreviation drift (`velCurve`/`VCL`/`velocityCurve`,
  `Win`/`Window`), American vs British (`color`/`colour`), and casing of compound
  words (`MiniMap`/`miniMap`/`minimap`). Comments count too, not just identifiers.
  Converge on one spelling (full word for identifiers; a short prefix is fine for
  constants). Exempt: compatibility contracts — storage keys, event/`data-action`
  and DOM-id strings, and the public state API — renaming those breaks data or wiring,
  so leave them and note the divergence instead.
- Dead code, unreachable branches, unused exports
- Inconsistent ordering or grouping (e.g. event handlers scattered)
- Comments that explain WHAT instead of WHY (delete them)

Out of scope:
- Adding features or behavior changes
- Adding error handling / fallbacks / validation for impossible cases
- Reformatting (no Prettier; manual column alignment is deliberate)

## Pass 2 — CLAUDE.md sync

For each section in each CLAUDE.md file (`CLAUDE.md`, `engine/CLAUDE.md`,
`ui/CLAUDE.md`), identify the source files it describes, read them, and verify
accuracy — look for additions AND stale names. Update the doc to match the code,
not the other way around.

One cross-file dependency to check explicitly: every keyboard shortcut and mouse
interaction documented in `ui/CLAUDE.md` must also appear in `HELP_SECTIONS` in
`index.html`, and vice versa. The doc and the in-app help must agree.

## Pass 3 — README.md sync

`README.md` is the public-facing feature doc. Keep three sections accurate:

- **Features list** — each bullet must reflect what the code actually does today;
  remove or rewrite bullets for removed features, add bullets for new ones
- **Keyboard shortcuts tables** — must match `HELP_SECTIONS` in `index.html`
  exactly (key names, descriptions, ordering)
- **Project structure** — file names and one-line descriptions must match the
  actual files on disk and their current roles

README.md explains WHAT the tool does for a new user; CLAUDE.md explains WHY and
HOW for a contributor. Keep that separation: README stays at feature/usage level,
no internal implementation details.

## Process

1. Read the scope. Identify findings in two groups — **Code** and **CLAUDE.md sync**.
2. Apply all changes directly, in one pass — source files first, then CLAUDE.md.
   Do not wait for approval.
3. Summarize what changed, grouped Code / CLAUDE.md sync, citing file:line for each
   change so I can spot-check and revert anything I disagree with. The pass never
   commits, so a `git restore` undoes any single change. Don't commit unless asked.

## Notes

- No Prettier — manual column alignment is deliberate, preserve it.
- CLAUDE.md should explain intent and non-obvious decisions, not API surface. Skip
  facts trivially re-derivable from the code; prefer updating existing lines over
  adding new ones.
- Commit message convention: `Maintainability pass: <changes, comma-separated>`
