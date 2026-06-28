# Engine — State, MIDI, MusicXML

## Architecture

**State** (`state.js`) is the single source of truth. It extends `EventTarget`
and dispatches custom events when data changes. The canvas engine and the toolbar
custom element both listen to these events.

**Communication flow:**
- State → Canvas/toolbar: custom events (`loaded`, `selectionchanged`, `playbackchanged`,
  `playheadmoved`, `snapchanged`, `pedalchanged`, `tempochanged`, `softpedalchanged`,
  `midiportschanged`, `undochanged`, `bookmarkschanged`, `playspeedchanged`,
  `restrikegapchanged`)
- Keyboard shortcuts wired in `roll.js` `_bindEvents`; Space dispatches
  `toggle-playback` on `document` for the app layer to handle
- `user-seek` bubbling event dispatched from roll canvas when playhead is dragged;
  caught in `index.html` to restart MIDI scheduling from the new position
- Tool windows ([1]/[2]/[3]) and the velocity-curve editor are plain DOM elements
  created in `index.html`; capture-phase keydown intercepts shortcuts before
  roll.js handlers

**Note data shape:**
```js
{
  id: int,                // stable, assigned on load / mint on add
  pitch: 0-127,
  velocity: 1-127,        // editable via the velocity [1] / curve [2] / velocity-delta [3] tools
  startTick: int,
  endTick: int,
  track: int,
  channel: int,
  muted: bool,            // toggled via M (state.toggleNoteMutes); skipped at playback, drawn with a diagonal hatch
  group: 0-4,             // 0/absent = ungrouped; 1-4 assigned via the [4] Group tool (state.setNoteGroups); shown as a badge on the note box
}
```
Notes are sorted by `startTick` on load (both MusicXML and project). Editing methods
that mutate notes (`setNoteVelocities`, `setNoteVelocitiesMap`, `setNoteGroups`, `toggleNoteMutes`,
`addNote`, `deleteNotes`, `moveNotes`/`moveNotesStart`/`moveNotesLive`,
`resizeNotesRight`/`resizeNotesLeft`/`resizeNoteStart`, `setSelection`) dispatch
`selectionchanged` so the roll re-renders. (The single-note `resizeNote`/`resizeNoteLeft`
remain for unit tests; the roll drives the multi-note `resizeNotesRight`/`resizeNotesLeft`.) Curve drag begins call
`beginCurvePointMove()` to push undo once at drag start.

**Curve tool** (`applyVelocityCurve(indices, from, to, shape)`): a **one-shot** velocity
shaper invoked by tool [2]. Bakes a start→end ramp (eased by `shape`, one of `SCALE_EASINGS`,
defined and exported here in `state.js`) across the selection by onset time so a chord gets one
value, then stops — it sets velocities directly, a one-shot edit with nothing persisted. Pushes
undo, dispatches `selectionchanged`.

**State fields of note:**
- `state.loaded` — boolean, true once a MusicXML or project file has been loaded
- `state.pieceId` — UUID assigned per loaded score / project; used to key per-piece view state in localStorage
- `state.selectedNoteIndices` — `Set<int>`, indices into `state.notes`
- `state.bookmarks` — `[tick]` sorted; ruler markers + `← / →` navigation; not part of undo
- `state.pedalPoints` — `[{tick, value}]` sorted by tick, value 0–1; drives CC64
- `state.tempoPoints` — `[{tick, value}]` sorted by tick, value 0.8–1.2; tempo ratio curve
- `state.softPedalRegions` — `[{startTick, endTick}]` sorted by startTick, disjoint & merged; binary una corda, drives CC67. Edited via the region lane; `addSoftPedalRegion` (paint commit), `removeSoftPedalRegionAt`, and the drag trio `beginSoftPedalEdit` / `resizeSoftPedalRegion` / `moveSoftPedalRegion` / `endSoftPedalEdit` (the live resize/move may overlap; `normalizeRegions` merges on commit). Dispatches `softpedalchanged`
- `state.velocityCurve` — 88-entry `int[]` (pitch 21–108 → index 0–87), per-key MIDI velocity offset (range −22…+22) applied at scheduling time; persisted independent of project
- `state.playSpeed` — playback speed multiplier (0.25–2.0); piece-specific view setting, persisted in `pianizer-view-${pieceId}`. Set via `setPlaySpeed()` (dispatches `playspeedchanged`); `snapGrid` likewise via `setSnapGrid()` (dispatches `snapchanged`)
- `state.restrikeGapMs` — re-strike gap in ms (clamped 0–200 by `setRestrikeGap`, default 60, `0` = off); output-instrument property, persisted device-level in `pianizer-restrike-gap`; dispatches `restrikegapchanged`

**Lane ↔ roll sync:** `roll.onPostRender` hook — the roll calls it at the end of every
`render()`, but **gated on a view signature** so it only triggers `tempoLane.render()`,
`pedalLane.render()`, `softPedalLane.render()`, `minimap.render()` and a debounced view
save when the scroll/zoom actually changed. The lanes and minimap also subscribe directly
to the state events they each draw, so the hook covers only the roll-internal view transform
(see ui/CLAUDE.md → Render wiring for the full split).

**Bar boundaries:** `state.barBoundaries(tickStart, tickEnd)` returns `[{tick, bar}]` for
every bar line in the visible tick range, walking `state.timeSignatures` segments and
accumulating 1-based bar numbers across changes. Used by `_drawGrid` and `_drawRuler` in
`roll.js` and `_drawGrid` in `curve-lane.js`.

---

## Undo / Redo

Snapshot-based: deep copies of `notes`, `pedalPoints`, `tempoPoints`, `softPedalRegions`,
plus the selection. 100-entry stack. **Selection-only changes push light entries**: `setSelection` calls
`_pushUndo(false)`, which snapshots just `{selection}` — no deep copies. That is safe
because any later mutation of notes or curves pushes its own full snapshot before touching
them, so when a light entry is popped the live arrays already equal their state at push
time. Undo/redo banks a twin of the same shape (`_applyHistory`), so click-around
selection churn never stacks up full copies of a large score. Drag interactions (note
resize, note move, curve-point move, soft-pedal region resize/move) push undo **once**
at drag start via `resizeNoteStart` / `moveNotesStart` / `beginCurvePointMove` /
`beginSoftPedalEdit`; per-frame updates mutate live without pushing. Bookmarks and the velocity curve are NOT part of undo.

---

## Snap Grid

Snap resolutions: `1/1`, `1/2`, `1/4`, `1/8`, `1/8T`, `1/16`, `1/16T`, `1/32`, `1/32T`, `1/64`, `1/64T`
Triplet grids (`T`) are `tpb * 2/3` (`1/8T`), `tpb / 3` (`1/16T`), `tpb / 6` (`1/32T`), and `tpb / 12` (`1/64T`).
`state.snapTick(tick)` returns the nearest snapped tick for a given value.
Grid renders: sub-beat lines (faint `#222`), beat lines (`#2a2a2a`), bar lines (`#3a3a3a`).

---

## Tempo Curve — Tick ↔ Time

The tempo ratio follows a **monotone cubic (PCHIP / Fritsch–Carlson) spline** through the
`tempoPoints`, not straight segments — `monotoneTangents` / `evalMonotoneCubic` in
`state.js`. Monotone tangents (zero slope at local extrema and equal-valued runs) keep
flats exactly flat and prevent overshoot beyond the points' own value range, so an anchor
placed to return to a tempo actually holds it (a run of baseline-1.0 points maps cleanly
to base time, no wobble approaching the flat) and the ratio never escapes `[min, max]` of
its neighbours — the curve never injects a tempo bump you didn't draw. Outside the point
range the ratio holds flat at the nearest endpoint.

Because the integrand `1/ratio(tick)` has no closed form under a cubic, `curvedTickToTime`
integrates each break sub-segment (bounded by `tempoMap` baseBpm steps and `tempoPoints`
knots) numerically with composite Simpson (`TEMPO_INTEGRATION_PANELS = 16`); Simpson is
exact on a constant integrand, so a flat ratio still resolves to base time to machine
precision. Tangents are computed once per `curvedTickToTime` call and reused across all
samples. `timeToTick` binary-searches over this monotonic mapping. The curve affects
playback scheduling, playhead position, and project duration. The pedal curve is unrelated
and stays piecewise-linear (`interpolateCurveAtTick`).

`curvedTickToTime` re-derives the tangents and re-integrates from tick 0 on **every**
call — fine for one-offs, O(N·breaks) when converting many ticks. `buildTickToTime()`
is the batched form: it builds the break timeline once (cumulative time per break +
per-segment seconds-per-tick), then each `tick → seconds` query is a binary search plus
one partial-segment Simpson — O(breaks + queries). **Every conversion is routed through
one cached instance**: `tickToTime()` / `timeToTick()` call `_timeline()`, which lazily
builds the closure and reuses it until `_invalidateTimeline()` tears it down (load,
tempo-point add/remove/move, undo restore). This matters because the playhead draws
(roll + both lanes + minimap) convert time→tick every frame during playback, and
`timeToTick` alone is up to 64 conversions per call — uncached, that was a full
re-integration from tick 0 each time. The MIDI scheduler's per-note start/end conversion
rides the same cache.

---

## Velocity Curve (applied at scheduling time only)

Applied in `midi-out.js` at scheduling time — stored note data is never mutated.

`vel = clamp(note.velocity + state.velocityCurve[pitch-21], 1, 127)`.
Per-device calibration, not per-score.

---

## MusicXML Import (`musicxml.js`)

Parses `score-partwise` documents using the browser `DOMParser`. Key decisions:
- First `<divisions>` element encountered seeds the global `ticksPerBeat`, scaled up by
  an integer factor to at least 480 (low-divisions files from tools other than MuseScore
  would otherwise quantize snap grids, triplets, and tremolo strokes to a uselessly
  coarse tick); all note durations are scaled: `Math.round(durRaw * tpb / divisions)`
- Ties tracked by `voice|pitch` → noteIndex map (per part), so two voices holding ties
  on the same pitch don't collide; tied notes extend `endTick` of the first note
- Tempo from `<sound tempo="">` in the first part only
- Dynamics from `<sound dynamics="">` (numeric, tracked per part) used directly
  as the running note velocity (clamped 1–127)
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

`MidiOut` class — connects to a browser MIDI output port and schedules note on/off,
CC64 (sustain) and CC67 (soft pedal / una corda) messages using `performance.now()`
timestamps.

**Lookahead scheduler:**
- `setInterval(tick, 30)` — every 30ms, schedule events up to 150ms ahead
- `safeOnMs = Math.max(onMs, nowMs + 5)` — prevents scheduling in the past
- Notes already ended (offMs + 200 ≤ nowMs) are skipped
- **Note chasing**: notes that started before the start point but are still sounding
  there (`noteEnd > startTime`) are kept and fire immediately (their past `onMs` clamps
  to `nowMs+5`), so starting playback in the middle of a held note still sounds it —
  consistent with the pedal level, which is likewise chased (asserted) at the start
- **Muted notes** (`n.muted`) are filtered out of `sortedNotes`, so they never sound; the flag is per-note, toggled with `M` (`state.toggleNoteMutes`), and persisted in project JSON
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
- CC64 sent on all channels that have notes. The held pedal value at the start point
  (interpolated from the curve) is asserted **immediately/untimed** in `schedulePlayback`,
  right after `stopPlayback`'s CC64=0 reset and on the same direct path — so the held
  value can't lose a delivery race with the reset on backends that reorder a queued
  (slightly-future) send behind an immediate one (Linux/ALSA → FluidSynth). The lookahead
  loop (`buildPedalEvents`) then schedules everything *after* the start point — the
  control points **plus ramp samples between them**: the lane draws a linear ramp
  between points, so `buildPedalEvents` emits one event per integer CC64 step the ramp
  crosses (the densest stream that changes the output, self-thinning for slow ramps).
  Without that, a drawn half-pedal ramp would play as a single jump at each point.
  This keeps pedal state correct both at tick 0 and when starting mid-piece.
- CC67 soft pedal (una corda) is **binary**, so it needs no ramp: each
  `softPedalRegions` span emits CC67=127 at its start tick and 0 at its end
  (`buildSoftPedalEvents`). The held value at the start point is asserted
  immediately/untimed alongside the CC64 assertion (127 if `startTick` falls inside a
  region, else 0), same race-avoidance path; the lookahead loop schedules only
  transitions strictly after the start point. Sent on the same active channels as CC64.
  `stopPlayback` releases it (CC67=0) along with CC64.

**`stopPlayback(channels = null)`** calls `out.clear()` then sends CC64=0, CC67=0, All
Notes Off (CC 123), All Sound Off (CC 120) on each channel in `channels`,
defaulting to all 16 for a clean standalone Stop. `schedulePlayback` passes just
the channels actually carrying notes: a full 16-channel reset there would push
~48 untimed messages onto the pipe ahead of the note-ons it schedules next, and
on a serial/USB-MIDI port (or ALSA → FluidSynth, which floats immediate sends
ahead of slightly-future ones) that head-of-line drain stalls the first ~100ms
of output — the playhead advances in silence and the backlog then fires
compressed before catching up. Scoping the reset (one channel for a piano score)
keeps the start tight. For the same reason, the mid-playback reschedule paths in
`index.html` (`user-seek`, `play-speed`) do **not** call `stopPlayback()` before
`scheduleFrom` — `schedulePlayback`'s own scoped reset is the only one on the pipe.

**Port management:** `requestAccess()` opens MIDI access, auto-selects first port,
dispatches `midiportschanged`. `onstatechange` handles hot-plug; if the selected port
disappears, falls back to the first available.

**Playback timing:** `getPieceTime()` in `index.html` uses `performance.now()` (not
`AudioContext.currentTime`). `startPlayback()` is synchronous — no async needed.

**Clock baselining (`onReady`):** `schedulePlayback(startTime, getPieceTime, onReady)`
builds `sortedNotes` by calling `state.tickToTime()` twice per note, and that
numerical tempo-curve integration can take ~100ms on a large score. The playback
clock origin (`playStartPerfMs`) must therefore be set *after* that prep, not before:
`schedulePlayback` invokes `onReady()` once, right before its first `schedule()` tick,
and each `index.html` caller uses it to `playStartPerfMs = performance.now()`. If the
origin were set before the prep, `getPieceTime()` would already read ~100ms by the
first tick — every note in that gap would clamp to `nowMs+5` and fire bunched while the
playhead (same clock) jumped ahead, i.e. "silence then a compressed catch-up" at the
start of playback.

**Play-from anchor:** `playAnchor` in `index.html` records the position to start
playback from. Set by `user-seek` events (ruler click/drag, bookmark seeks);
cleared by Stop (■) and on file load. Each Play snaps the playhead back to the
anchor before scheduling so the same passage can be replayed. Natural end-of-piece
pauses (rather than stops) so the anchor survives.

---

## Project Save/Load

`state.saveProject()` / `state.loadProject(data)` — versioned JSON (version: 1).
Includes: pieceId, ticksPerBeat, tempoMap, timeSignatures, totalTicks,
totalTime, notes (with `id` and `group`), pedalPoints, tempoPoints, softPedalRegions
(re-normalized on load via `normalizeRegions`), bookmarks. On
load, notes are re-sorted by startTick and `loaded` is dispatched so the roll
resets and re-renders. `totalTicks` and `totalTime` are written for forward
compatibility but always recomputed from the notes / tempo curve on load (the
stored values are ignored) — and re-derived (`_refreshTotals`) after every note
edit that can change ticks (add/delete/move/resize, undo restore), since playback's
natural end and the scrollable range both depend on them.

---

## Auto-save / view restore (localStorage)

Four independent localStorage entries, all best-effort (errors swallowed):
- `pianizer-autosave` — full project JSON, debounced 1 s after any
  `loaded`/`selectionchanged`/`pedalchanged`/`tempochanged`/`softpedalchanged`, and flushed
  on `beforeunload`. Auto-loaded on page open.
- `pianizer-view-${pieceId}` — `{pixelsPerTick, scrollX, scrollY, snapGrid, playSpeed}`, debounced
  500 ms after each `roll.render()` via the `onPostRender` hook; restored after `fitView()`
  on every load.
- `pianizer-vel-curve` — the 88-element `state.velocityCurve` (clamped to −22…+22 on load),
  written on every edit. Device-scoped, not score-scoped.
- `pianizer-restrike-gap` — `state.restrikeGapMs` (clamped 0–200 via `setRestrikeGap` on
  load), written on every `restrikegapchanged`. Device-scoped, not score-scoped.
