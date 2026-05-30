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

## Process

1. Read the scope. List all candidate findings in two groups — **Code** and
   **CLAUDE.md sync** — citing file:line for each. Do NOT edit yet.
2. Wait for confirmation (I may trim or add).
3. Apply all changes in one pass — source files first, then CLAUDE.md.
4. Summarize what changed in one or two sentences. Don't commit unless asked.

## Notes

- No Prettier — manual column alignment is deliberate, preserve it.
- CLAUDE.md should explain intent and non-obvious decisions, not API surface. Skip
  facts trivially re-derivable from the code; prefer updating existing lines over
  adding new ones.
- Commit message convention: `Maintainability pass: <changes, comma-separated>`
