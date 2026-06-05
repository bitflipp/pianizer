# Engine — State, MIDI, MusicXML

## Architecture

**State** (`state.js`) is the single source of truth. It extends `EventTarget`
and dispatches custom events when data changes. The canvas engine and the toolbar
custom element both listen to these events.

**Communication flow:**
- State → Canvas/toolbar: custom events (`loaded`, `selectionchanged`, `playbackchanged`,
  `playheadmoved`, `snapchanged`, `pedalchanged`, `tempochanged`, `midiportschanged`,
  `undochanged`, `bookmarkschanged`, `velocitycurvechanged`, `playspeedchanged`,
  `restrikegapchanged`, `groupschanged`)
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
  id: int,                // stable, assigned on load / mint on add; curve groups reference notes by id
  pitch: 0-127,
  velocity: 1-127,        // editable via tools [1], [2], or [4]; frozen when the note is in a curve group
  startTick: int,
  endTick: int,
  track: int,
  channel: int,
}
```
Notes are sorted by `startTick` on load (both MusicXML and project). Editing methods
that mutate notes (`setNoteVelocities`, `setNoteVelocitiesMap`, `scaleNoteDurations`,
`addNote`, `deleteNotes`, `moveNotes`/`moveNotesStart`/`moveNotesLive`,
`resizeNotesRight`/`resizeNotesLeft`/`resizeNoteStart`, `setSelection`) dispatch
`selectionchanged` so the roll re-renders. (The single-note `resizeNote`/`resizeNoteLeft`
remain for unit tests; the roll drives the multi-note `resizeNotesRight`/`resizeNotesLeft`.) Curve drag begins call
`beginCurvePointMove()` to push undo once at drag start.

**Curve groups** (`state.curveGroups`): `[{id, members:[noteId], from, to, shape}]`. The
curve-group tool [1] bakes a start→end velocity ramp (eased by `shape`, one of
`SCALE_EASINGS` — now defined and exported here in `state.js`) across the selection,
indexed by onset time so a chord gets one value, and records it as a group when the
selection spans ≥2 distinct onsets (a single-onset selection just sets a flat velocity, no
group). Member velocities are **frozen scalars** baked from the ramp; `from/to/shape` are
kept so the roll's endpoint handles can re-derive. API: `createCurveGroup` / `dissolveCurveGroup`
(leaves velocities intact) / `reshapeCurveGroup` (re-bakes; clamps `from/to`; does **not**
push undo — the caller pushes via `beginCurvePointMove`, e.g. the curve-group menu's
two-click ramp re-pick, one step per re-pick). `isLocked(note)` /
`groupOfNote(note)` / `groupMembers(g)` read a `noteId→group` index rebuilt on every group
change. All mutators dispatch `groupschanged`. Member notes are locked in the roll: immovable,
unresizable, undeletable, and not editable by the velocity/duration tools — change them only by
reshaping the group's handles or dissolving it.

**State fields of note:**
- `state.loaded` — boolean, true once a MusicXML or project file has been loaded
- `state.pieceId` — UUID assigned per loaded score / project; used to key per-piece view state in localStorage
- `state.selectedNoteIndices` — `Set<int>`, indices into `state.notes`
- `state.bookmarks` — `[tick]` sorted; ruler markers + `← / →` navigation; not part of undo
- `state.pedalPoints` — `[{tick, value}]` sorted by tick, value 0–1; drives CC64
- `state.tempoPoints` — `[{tick, value}]` sorted by tick, value 0.8–1.2; tempo ratio curve
- `state.curveGroups` — `[{id, members:[noteId], from, to, shape}]`; locked velocity-ramp groups (see above)
- `state.velocityCurve` — 88-entry `int[]` (pitch 21–108 → index 0–87), per-key MIDI velocity offset (range −22…+22) applied at scheduling time; persisted independent of project
- `state.playSpeed` — playback speed multiplier (0.25–2.0); piece-specific view setting, persisted in `pianizer-view-${pieceId}`
- `state.restrikeGapMs` — re-strike gap in ms (clamped 0–200 by `setRestrikeGap`, default 60, `0` = off); output-instrument property, persisted device-level in `pianizer-restrike-gap`; dispatches `restrikegapchanged`

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

Snapshot-based: deep copies of `notes`, `pedalPoints`, `tempoPoints`, `curveGroups`, plus the selection.
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

The tempo ratio follows a **monotone cubic (PCHIP / Fritsch–Carlson) spline** through the
`tempoPoints`, not straight segments — `monotoneTangents` / `evalMonotoneCubic` in
`state.js`. Monotone tangents (zero slope at local extrema and equal-valued runs) keep
flats exactly flat and prevent overshoot beyond the points' own value range, so a run of
baseline-1.0 points still maps to base time (the rubato-balance feature relies on this)
and the ratio never escapes `[min, max]` of its neighbours. Outside the point range the
ratio holds flat at the nearest endpoint.

Because the integrand `1/ratio(tick)` has no closed form under a cubic, `curvedTickToTime`
integrates each break sub-segment (bounded by `tempoMap` baseBpm steps and `tempoPoints`
knots) numerically with composite Simpson (`TEMPO_INTEGRATION_PANELS = 16`); Simpson is
exact on a constant integrand, so a flat ratio still resolves to base time to machine
precision. Tangents are computed once per `curvedTickToTime` call and reused across all
samples. `timeToTick` binary-searches over this monotonic mapping. The curve affects
playback scheduling, playhead position, and project duration. The pedal curve is unrelated
and stays piecewise-linear (`interpolateCurveAtTick`).

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
- **Re-strike gap** (`state.restrikeGapMs`, default 60 ms, `0` disables): each note's
  off is pulled in so the same key (pitch+channel) is released at least that many ms
  (wall-clock) before its next strike, giving a real grand's hammer/jack/damper time
  to reset — a held-until-re-strike note otherwise yields a weak or dropped repeat.
  `nextStartByEntry` precomputes each note's next same-key onset once per
  `schedulePlayback` (single backward pass); the gap value is read **live** inside the
  schedule tick so a toolbar change applies to notes scheduled from then on without
  restarting playback. Applied independent of pedal state (the hammer must fall back
  regardless of the damper) and of playSpeed (gap is wall-clock). The `safeOffMs`
  floor still guarantees a minimum note length when the repeat is very close.
  Device-scoped (a property of the output instrument, not the score) — see persistence
  below.
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
totalTime, notes (with `id`), pedalPoints, tempoPoints, curveGroups, bookmarks. On
load, notes are re-sorted by startTick and `loaded` is dispatched so the roll
resets and re-renders. Curve groups load after notes: members referencing missing
note ids are dropped, emptied groups discarded, and the group-id counter reseeded. `totalTime` is written for forward compatibility but
always recomputed from the tempo curve on load (the stored value is ignored).

---

## Auto-save / view restore (localStorage)

Three independent localStorage entries, all best-effort (errors swallowed):
- `pianizer-autosave` — full project JSON, debounced 1 s after any
  `loaded`/`selectionchanged`/`pedalchanged`/`tempochanged`/`groupschanged`, and flushed on `beforeunload`.
  Auto-loaded on page open.
- `pianizer-view-${pieceId}` — `{pixelsPerTick, scrollX, scrollY, snapGrid, playSpeed}`, debounced
  500 ms after each `roll.render()` via the `onPostRender` hook; restored after `fitView()`
  on every load.
- `pianizer-vel-curve` — the 88-element `state.velocityCurve` (clamped to −22…+22 on load),
  written on every edit. Device-scoped, not score-scoped.
- `pianizer-restrike-gap` — `state.restrikeGapMs` (clamped 0–200 via `setRestrikeGap` on
  load), written on every `restrikegapchanged`. Device-scoped, not score-scoped.
