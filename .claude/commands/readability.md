---
description: Readability/maintainability pass on the codebase, then sync CLAUDE.md with any deviations
---

Run a readability pass and a CLAUDE.md sync on: $ARGUMENTS (if empty, pick the
most-recently-edited source file for the readability scope; always scan everything
for the doc sync).

## Pass 1 — Readability

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

Cross-check categories (work through them in order):

1. **File structure** — list everything under `engine/` and `components/` and
   confirm each file is named in CLAUDE.md's tree with an accurate one-line
   description.
2. **State** (`engine/state.js`) — every public field, mutation method, and
   dispatched event should appear in CLAUDE.md's "State fields", editing-methods
   list, and "Communication flow" events list. Look for additions AND for stale
   names that no longer exist.
3. **UI interactions** — every keyboard shortcut and mouse interaction in
   `roll.js` `_onKeyDown` / `_bindEvents`, in the curve lanes, and in the
   minimap should be reflected in CLAUDE.md's "Controls" section and in
   `HELP_SECTIONS` in `index.html`. The doc and the in-app help must agree.
4. **Tool windows** ([1]/[2]/[3]/[4] + velocity curve editor in `index.html`)
   — descriptions match.
5. **Toolbar** (`components/toolbar.js`) — the layout line in CLAUDE.md lists
   the same buttons in the same order.
6. **Project save/load** — `saveProject()` in `state.js` and the field list in
   CLAUDE.md's "Project Save/Load" enumerate the same keys.
7. **MIDI scheduling** — `midi-out.js` against CLAUDE.md's "Web MIDI Output"
   and the velocity/articulation/pedal notes in "Implementation Notes".
8. **Snap grid** — `SNAP_GRIDS` constant against the doc's grid list and
   triplet-ratio note.
9. **localStorage keys** — every `localStorage.setItem` / `getItem` in
   `index.html` against CLAUDE.md's "Auto-save / view restore" section.

## Process

1. Read the scope. List all candidate findings in two groups — **Readability**
   and **CLAUDE.md sync** — citing file:line for each. Do NOT edit yet.
2. Wait for confirmation (I may trim or add).
3. Apply all changes in one pass — source files first, then CLAUDE.md.
4. Summarize what changed in one or two sentences. Don't commit unless I ask.

## Style reminders

**Code:**
- Vanilla JS, no framework, no build step, no dependencies
- 12px monospace UI; manual column alignment in object/struct literals is
  deliberate — preserve it
- Default to NO comments. Only add one when the WHY is non-obvious (hidden
  constraint, subtle invariant, workaround). Never explain WHAT the code does.
- Commit message convention: `Readability pass: <changes, comma-separated>`

**CLAUDE.md:**
- Explains intent and non-obvious decisions, not API surface. Skip facts that
  are trivially re-derivable from the code.
- Keep section order and headings stable — easier to diff.
- Prefer updating an existing line over adding a new one.
