# Engine — State, MIDI, MusicXML

## Architecture

**State** (`state.js`) is the single source of truth. It extends `EventTarget`
and dispatches custom events when data changes. The canvas engine and the toolbar
custom element both listen to these events.

**Communication flow:**
- State → Canvas/toolbar: custom events (`loaded`, `selectionchanged`, `playbackchanged`,
  `playheadmoved`, `snapchanged`, `pedalchanged`, `tempochanged`, `midiportschanged`,
  `undochanged`, `bookmarkschanged`, `velocitycurvechanged`, `playspeedchanged`)
- Keyboard shortcuts wired in `roll.js` `_bindEvents`; Space dispatches
  `toggle-playback` on `document` for the app layer to handle
- `user-seek` bubbling event dispatched from roll canvas when playhead is dragged;
  caught in `index.html` to restart MIDI scheduling from the new position
- Tool windows ([1]/[2]/[3]/[4]) and the velocity-curve editor are plain DOM elements
  created in `index.html`; capture-phase keydown intercepts shortcuts before
  roll.js handlers

**Note data shape:**
```js
{
  pitch: 0-127,
  velocity: 1-127,        // editable via tools [1], [2], or [4]
  startTick: int,
  endTick: int,
  track: int,
  channel: int,
}
```
Notes are sorted by `startTick` on load (both MusicXML and project). Editing methods
that mutate notes (`setNoteVelocities`, `setNoteVelocitiesMap`, `scaleNoteDurations`,
`addNote`, `deleteNotes`, `moveNotes`/`moveNotesStart`/`moveNotesLive`,
`resizeNote`/`resizeNoteLeft`/`resizeNoteStart`, `setSelection`) dispatch
`selectionchanged` so the roll re-renders. Curve drag begins call
`beginCurvePointMove()` to push undo once at drag start.

**State fields of note:**
- `state.loaded` — boolean, true once a MusicXML or project file has been loaded
- `state.pieceId` — UUID assigned per loaded score / project; used to key per-piece view state in localStorage
- `state.selectedNoteIndices` — `Set<int>`, indices into `state.notes`
- `state.bookmarks` — `[tick]` sorted; ruler markers + `← / →` navigation; not part of undo
- `state.pedalPoints` — `[{tick, value}]` sorted by tick, value 0–1; drives CC64
- `state.tempoPoints` — `[{tick, value}]` sorted by tick, value 0.8–1.2; tempo ratio curve
- `state.velocityCurve` — 88-entry `int[]` (pitch 21–108 → index 0–87), per-key MIDI velocity offset (range −22…+22) applied at scheduling time; persisted independent of project
- `state.playSpeed` — playback speed multiplier (0.25–2.0); piece-specific view setting, persisted in `pianizer-view-${pieceId}`

**Lane ↔ roll sync:** `roll.onPostRender` hook — the roll calls it at the end of every
`render()`, which triggers `tempoLane.render()`, `pedalLane.render()`, `miniMap.render()`,
and a debounced view save. All three lanes stay locked to the roll's scroll/zoom with
zero extra wiring.

**Bar boundaries:** `state.barBoundaries(tickStart, tickEnd)` returns `[{tick, bar}]` for
every bar line in the visible tick range, walking `state.timeSignatures` segments and
accumulating 1-based bar numbers across changes. Used by `_drawGrid` and `_drawRuler` in
`roll.js` and `_drawGrid` in `curve-lane.js`.

---

## Undo / Redo

Snapshot-based: deep copies of `notes`, `pedalPoints`, `tempoPoints`, plus the selection.
100-entry stack. Drag interactions (note resize, note move, curve-point move) push undo
**once** at drag start via `resizeNoteStart` / `moveNotesStart` / `beginCurvePointMove`;
per-frame updates mutate live without pushing. Bookmarks and the velocity curve are NOT
part of undo.

---

## Snap Grid

Snap resolutions: `1/1`, `1/2`, `1/4`, `1/8`, `1/8T`, `1/16`, `1/16T`, `1/32`, `1/32T`
Triplet grids (`T`) are `tpb * 2/3` (`1/8T`), `tpb / 3` (`1/16T`), and `tpb / 6` (`1/32T`).
`state.snapTick(tick)` returns the nearest snapped tick for a given value.
Grid renders: sub-beat lines (faint `#222`), beat lines (`#2a2a2a`), bar lines (`#3a3a3a`).

---

## Tempo Curve — Tick ↔ Time

Within each sub-segment (bounded by `tempoMap` and `tempoPoints` breakpoints) baseBpm is
constant and ratio is piecewise-linear, yielding the closed-form integral
`scale * ln(r1/r0) / (r1-r0)` where `scale = D*60/(tpb*baseBpm)`. `timeToTick` uses
binary search over this. The curve affects playback scheduling, playhead position, and
project duration.

---

## Velocity Curve (applied at scheduling time only)

Applied in `midi-out.js` at scheduling time — stored note data is never mutated.

`vel = clamp(note.velocity + state.velocityCurve[pitch-21], 1, 127)`.
Per-device calibration, not per-score.

---

## MusicXML Import (`musicxml.js`)

Parses `score-partwise` documents using the browser `DOMParser`. Key decisions:
- First `<divisions>` element encountered becomes the global `ticksPerBeat`; all
  subsequent note durations are scaled: `Math.round(durRaw * tpb / divisions)`
- Ties tracked by pitch → noteIndex map; tied notes extend `endTick` of the first note
- Tempo from `<sound tempo="">` in the first part only
- Dynamics (`pp`/`p`/`mp`/`mf`/`f`/`ff`) converted to velocity values
- Grace notes skipped (`<grace/>` element present)
- `<backup>` / `<forward>` supported for multi-voice measures
- `<multiple-rest>N</multiple-rest>`: MuseScore omits the intermediate N−1 measures
  from the XML. After processing the measure, tick is snapped forward to
  `measureStartTick + N * ticksPerMeasure` if the rest duration didn't already cover it.
- **Tremolo expansion** at parse time (notes appear in the piano roll and are fully editable):
  - Stroke speed is absolute: N slashes = stroke duration `tpb / 2^N` (1 slash = 8th,
    2 = 16th, 3 = 32nd), regardless of written note value or time-modification tuplets.
  - `type="single"`: `round(durTick / strokeDur)` rapid repetitions
  - `type="start"/"stop"`: two-note tremolo buffered across notes; `round(combinedDur / strokeDur)`
    alternating strokes, alternating pitch/velocity between the two written notes
  - `type="unmeasured"`: treated as a normal note (no deterministic expansion)

---

## Web MIDI Output (`midi-out.js`)

`MidiOut` class — connects to a browser MIDI output port and schedules note on/off
and CC64 messages using `performance.now()` timestamps.

**Lookahead scheduler:**
- `setInterval(tick, 30)` — every 30ms, schedule events up to 150ms ahead
- `safeOnMs = Math.max(onMs, nowMs + 5)` — prevents scheduling in the past
- Notes already ended (offMs + 200 ≤ nowMs) are skipped
- CC64 sent on all channels that have notes; initial value interpolated at seek point
  so pedal state is correct when starting mid-piece

**`stopPlayback()`** calls `out.clear()` then sends CC64=0, All Notes Off (CC 123),
All Sound Off (CC 120) on all 16 channels for a clean stop.

**Port management:** `requestAccess()` opens MIDI access, auto-selects first port,
dispatches `midiportschanged`. `onstatechange` handles hot-plug; if the selected port
disappears, falls back to the first available.

**Playback timing:** `getPieceTime()` in `index.html` uses `performance.now()` (not
`AudioContext.currentTime`). `startPlayback()` is synchronous — no async needed.

**Play-from anchor:** `playAnchor` in `index.html` records the position to start
playback from. Set by `user-seek` events (ruler click/drag, bookmark seeks);
cleared by Stop (■) and on file load. Each Play snaps the playhead back to the
anchor before scheduling so the same passage can be replayed. Natural end-of-piece
pauses (rather than stops) so the anchor survives.

---

## Project Save/Load

`state.saveProject()` / `state.loadProject(data)` — versioned JSON (version: 1).
Includes: pieceId, ticksPerBeat, tempoMap, timeSignatures, totalTicks,
totalTime, notes, pedalPoints, tempoPoints, bookmarks. On
load, notes are re-sorted by startTick and `loaded` is dispatched so the roll
resets and re-renders. `totalTime` is written for forward compatibility but
always recomputed from the tempo curve on load (the stored value is ignored).

---

## Auto-save / view restore (localStorage)

Three independent localStorage entries, all best-effort (errors swallowed):
- `pianizer-autosave` — full project JSON, debounced 1 s after any
  `loaded`/`selectionchanged`/`pedalchanged`/`tempochanged`, and flushed on `beforeunload`.
  Auto-loaded on page open.
- `pianizer-view-${pieceId}` — `{pixelsPerTick, scrollX, scrollY, snapGrid, playSpeed}`, debounced
  500 ms after each `roll.render()` via the `onPostRender` hook; restored after `fitView()`
  on every load.
- `pianizer-vel-curve` — the 88-element `state.velocityCurve` (clamped to −22…+22 on load),
  written on every edit. Device-scoped, not score-scoped.
