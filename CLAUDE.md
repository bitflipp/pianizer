# Piano Humanizer — Project Context

## Purpose

Transform a mechanically quantized score (MusicXML exported from MuseScore or similar)
into a musically expressive MIDI rendition. The user selects notes and shapes their
velocity and articulation directly on a piano roll, then plays the result back through
an external synth via Web MIDI (e.g. FluidSynth or a hardware piano).

The core philosophy: expression comes from **deliberate editing**, not randomness.
There is no auto-humanization magic — the tool is an instrument, not an algorithm.

---

## Stack

- **Vanilla JS + Canvas 2D** for the piano roll (no framework overhead; Canvas gives
  full control for high-performance rendering and precise pointer interaction)
- **Plain custom element** for the toolbar — shadow DOM for style encapsulation,
  manual patch-on-event updates (no framework)
- **Web MIDI API** (`navigator.requestMIDIAccess`) for playback output — sends note
  on/off and CC64 (sustain pedal) to a user-selected MIDI port (e.g. FluidSynth).
  Scheduling uses `performance.now()` timestamps with a 30ms/150ms lookahead interval.
- **No build step** — ES modules loaded directly in the browser, served with
  `python3 -m http.server`. Everything must work by opening index.html via localhost.
- **No runtime dependencies** — no CDN imports, nothing the browser fetches beyond
  the source tree. MusicXML parsed with browser `DOMParser`. The shipped app stays
  dep-free; the only npm presence is the test harness (Vitest + Playwright,
  devDependencies only).

---

## File Structure

```
pianizer/
  index.html                 ← entry point, layout, app wiring, tool windows, velocity curve editor, autosave
  engine/
    state.js                 ← AppState (EventTarget), single source of truth
    musicxml.js              ← MusicXML score-partwise parser
    midi-out.js              ← Web MIDI output: MidiOut class, lookahead scheduler
  ui/
    roll.js                  ← PianoRoll canvas: render, rect selection, hover, pan, note editing
    curve-lane.js            ← CurveLane base class: shared pedal/tempo lane logic
    pedal-lane.js            ← PedalLane extends CurveLane (sustain pedal, value 0–1)
    tempo-lane.js            ← TempoLane extends CurveLane (tempo ratio 0.8–1.2)
    minimap.js               ← MiniMap lane: full-piece overview, viewport indicator, click-to-pan
    toolbar.js               ← <ph-toolbar> custom element
    dom-utils.js             ← shared layout constants (KEY_WIDTH, HEADER_HEIGHT, PITCH_MIN/MAX/RANGE) + canvasPos/isFormFocused helpers
```

---

## Architecture

**State** (`engine/state.js`) is the single source of truth. It extends `EventTarget`
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
  articulation: string|null,  // 'stacc' | 'staccatiss' | 'legato' | 'legatissimo' | null
}
```
Notes are sorted by `startTick` on load (both MusicXML and project). Editing methods
that mutate notes (`setNoteVelocities`, `setNoteVelocitiesMap`, `setNoteArticulations`,
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
- `state.velocityCurve` — 88-entry `int[]` (pitch 21–108 → index 0–87), per-key MIDI velocity offset (range −23…+21) applied at scheduling time; persisted independent of project
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

## UI / Interaction Model

### Piano Roll (canvas)
- Vertical axis: pitch (MIDI 21–108, A0–C8), fixed note height 16 px/semitone
- Horizontal axis: time in ticks, scrollable and zoomable
- Left strip (36 px, `KEY_WIDTH`): piano keyboard, all 88 keys labeled
- Top strip (24 px, `HEADER_HEIGHT`): bar/beat ruler, click/drag to seek playhead

**Controls (roll canvas):**
- `Scroll` — pan horizontal
- `Ctrl+scroll` — zoom horizontal (toward cursor tick); browser zoom is blocked
- `Ctrl+left drag` — pan (horizontal + vertical); cursor shows `grab`/`grabbing`
- `Home` — scroll to tick 0
- `End` — scroll to show last note at right edge
- `Space` — toggle playback
- `Escape` — clear selection (also cancels in-progress rect if one is active)
- `Click ruler` / `drag ruler` — seek playhead
- `Ctrl+click ruler` — add bookmark; `Ctrl+right-click bookmark` — remove
- `← / →` — seek to previous / next bookmark (wraps)
- `Alt+left click empty` — insert new note (1-beat duration, velocity 64, tick snapped, immediately selected)
- `Left drag note body` — move selection horizontally
- `Shift+left drag note body` — move horizontally + pitch
- `Left drag note left/right edge` — resize start / end (snapped to grid)
- `Delete` / `Backspace` — delete selected notes
- `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) — undo / redo

**Controls (tempo lane and pedal lane canvases — identical interaction model):**
- `Scroll` / `Ctrl+scroll` — horizontal pan / zoom (forwarded to roll)
- `Left-click empty` — add control point (tick snapped to grid; Y snapped to nearest neighbor within ±10 px, or to 25%/50%/75% reference lines and the lane baseline)
- `Left-drag point` — move an existing control point (same tick + Y snap; hold Ctrl to disable both)
- `Right-click` — remove nearest control point
- `Ctrl+left-click` — add control point without any snapping

**Right mouse button** is disabled globally (`window contextmenu` prevention) except
on the two curve lane canvases (point removal).

### Selection
- **Left click note** — select only that note; if it is already the sole selected note, clear the selection
- **Left click empty** — seek playhead to the click x-position and clear selection
- **Shift+click note** — toggle note in/out of selection without affecting others
- **Left drag** — draws a teal rubber-band rectangle; overlapping notes **replace** the current selection on release
- **Shift+left drag** — same rect, but **adds** to the current selection on release
- **Escape** — clears the selection (also cancels an in-progress rect drag)
- **Right mouse** — does nothing on the roll canvas

During a rect drag, `_rectHitSet` is updated each frame. Notes newly entering via the rect (not yet in the committed selection) preview at highlighted brightness; notes already in the committed selection render at normal brightness. Hovering a note outside a drag also shows highlighted. `_rectExtend` (set from `e.shiftKey` at drag start) controls add-vs-replace on release.

The rect drag threshold is 6 px (`DRAG_THRESHOLD`). Below threshold the mouseup
is treated as a click (handled by the `click` event, not `mouseup`). `_didRectSel`
and `_didPan` suppress the `click` event after a completed drag or pan.

**Canvas coordinate scaling:** `_canvasPos(e)` scales mouse CSS coordinates by
`canvas.width / r.width` (and height). Without this, hit testing drifts at non-1:1
CSS/logical pixel ratios. Canvas is sized via `ResizeObserver` on `#roll-container`.

### Note Coloring
Fill color is velocity-mapped (`noteHSL` in `roll.js`): hue fixed at 213° (blue),
saturation 65–80%, lightness 8–62%, both scaled linearly with velocity. Three display
states adjust the base lightness:
- **Normal**: notes in the current selection, or all notes when nothing is selected
- **Dimmed**: unselected notes when a selection exists (lightness × 0.55)
- **Highlighted**: hovered note, or notes being added by an in-progress rect drag (lightness + 16, capped at 78%)

Selected notes are distinguished by border weight: 2 px solid white vs 1 px semi-transparent
white for others. Label text is always white `#fff`. Each note has a 1 px top gap
(`y+1`, `h = noteHeight−1`), visually separating adjacent pitches.

Each note box shows its velocity number (top-left) and articulation symbol (top-right),
clipped to the note interior.

### Tool Windows
Floating DOM panels spawned at the cursor position, closed by clicking outside or Escape.
Keyboard shortcuts work when no `<input>`/`<select>` is focused.

- **[1] Note velocity** — 5–120 grid in steps of 5; click sets all selected notes
- **[2] Linear velocity scale** — two-click: first click sets start velocity (the
  first note by time gets this value), second sets end; interpolated across selection
  sorted by startTick
- **[3] Articulations** — stacc. (×0.50) / staccatiss. (×0.25) / legato / legatissimo;
  clicking the current value clears it (sets to null)
- **[4] Velocity delta** — `−10 / −5 / −1 / +1 / +5 / +10` buttons; offsets every
  selected note's velocity by the chosen amount (clamped 1–127)

Articulation factors are applied only at MIDI scheduling time; `endTick` is unchanged.

### Status Bar (20 px, bottom)
Shows state only — note count, selection count, and a `Press [?] for help` prompt.
Driven by a single `updateStatus()` called on `loaded` and `selectionchanged`.

### Help Overlay
Press `?` (Shift+/) to open a centered modal listing all keyboard and mouse
shortcuts grouped by section (Selection / Editing / View / Playback / Curve lanes).
Press `?` again, Escape, or click outside to dismiss. The shortcut table lives
in `HELP_SECTIONS` in `index.html` — keep it in sync when adding or changing
shortcuts.

### Tempo Lane (100 px, above pedal lane)
Linear tempo ratio curve. Control points are `{tick, value}` pairs (value 0.8–1.2).
- Centre of lane = ratio 1.0 (baseline tempo); top = ×1.2, bottom = ×0.8
- Curve is drawn as a connected amber polyline; control points shown as small squares
- Hovering shows a dashed vertical reticle in the roll; same Y-snap and snap indicator as pedal lane
- Curve is integrated into tick↔time conversion via closed-form ln formula; affects playback scheduling, playhead position, and project duration

### Pedal Lane (100 px, below tempo lane)
Linear sustain pedal curve. Control points are `{tick, value}` pairs (value 0–1).
- Top of lane = CC64 127 (fully depressed), bottom = CC64 0 (fully released)
- Curve is drawn as a connected teal polyline; control points shown as small squares
- Hovering the lane shows a dashed vertical reticle in the roll at the cursor tick
- Y-snap: new/dragged points snap to the nearest neighbor within ±10 px (up to 2
  preceding and 2 following by tick) **or** to the 25%, 50%, 75% reference lines and
  the lane's baseline `config.emptyValue` (1.0 for tempo, 0 for pedal); hold Ctrl to disable

Both lanes share the `CurveLane` base class (`ui/curve-lane.js`), parameterised via a config object (label, colors, value range, data accessors, add/remove/move callbacks, optional `drawAnnotations` hook). Lane-specific reticle colors are read from `lane.config.reticleColor/reticleHotColor` by `roll.js`.

### Rubato balance labels (tempo lane only)
`tempo-lane.js` supplies a `drawAnnotations` callback that finds every span
between two consecutive control points with value exactly 1.0 and at least one
non-baseline point between them. For each such span it computes
`(curvedTime − baseTime) × 1000` and draws the rounded ms delta next to **every**
inner non-baseline point in the region (same value, repeated per point — so the
delta stays visible even if other points in the same gesture are scrolled off).
Each label flips to the lane edge opposite its own point's value (point above
1.0 → label at bottom, point below → label at top). Green within ±1 ms, amber
otherwise. A balanced rubato gesture reads `0 ms`.

### Toolbar
Load MusicXML | Load project | Save project | Undo | Redo |
Stop | Play/Pause | Speed | Time | Snap grid | Vel. curve |
MIDI out: Connect button (hidden once connected) + port dropdown

### Mini-map (75 px, below pedal lane)
Full-piece overview rendered by `MiniMap` (`ui/minimap.js`). Shows all notes
scaled to fit the canvas, the used pitch range as a faint band, bookmark verticals,
the playhead, and a translucent viewport indicator that brightens on hover/drag.
Left-click or left-drag pans the roll so the clicked tick centers in the viewport.

### Velocity Curve editor
Opened by the toolbar's "Vel. curve" button (no keyboard shortcut). A dedicated
window with an 88-column × 45-row grid (one column per piano key, rows for
delta −22…+22 with row 23 = 0). Left-click paints a cell; left-drag interpolates
between cells across the drag path; right-click resets a column to 0. The window
is closed by clicking outside, pressing Escape, or the title-bar ✕. Curve values
are stored in `state.velocityCurve` and persisted to `localStorage` under
`pianizer-vel-curve` independent of the loaded project (device-level calibration).
Applied at MIDI scheduling time: `vel = clamp(note.velocity + curve[pitch-21], 1, 127)`.

### Bookmarks
`state.bookmarks` is a sorted tick array, drawn on the ruler as orange upward triangles
that brighten on hover. Added/removed via Ctrl+click and Ctrl+right-click on the
ruler; `← / →` seek to previous/next bookmark (wrapping). Bookmarks are persisted
in project JSON but are **not** part of undo.

### Project Save/Load
`state.saveProject()` / `state.loadProject(data)` — versioned JSON (version: 1).
Includes: pieceId, ticksPerBeat, tempoMap, timeSignatures, totalTicks,
totalTime, notes (with articulation), pedalPoints, tempoPoints, bookmarks. On
load, notes are re-sorted by startTick and `loaded` is dispatched so the roll
resets and re-renders. `totalTime` is written for forward compatibility but
always recomputed from the tempo curve on load (the stored value is ignored).

### Auto-save / view restore (localStorage)
Three independent localStorage entries, all best-effort (errors swallowed):
- `pianizer-autosave` — full project JSON, debounced 1 s after any
  `loaded`/`selectionchanged`/`pedalchanged`/`tempochanged`, and flushed on `beforeunload`.
  Auto-loaded on page open.
- `pianizer-view-${pieceId}` — `{pixelsPerTick, scrollX, scrollY, snapGrid, playSpeed}`, debounced
  500 ms after each `roll.render()` via the `onPostRender` hook; restored after `fitView()`
  on every load.
- `pianizer-vel-curve` — the 88-element `state.velocityCurve` (clamped to −23…+21 on load),
  written on every edit. Device-scoped, not score-scoped.

---

## MusicXML Import (`engine/musicxml.js`)

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

## Web MIDI Output (`engine/midi-out.js`)

`MidiOut` class — connects to a browser MIDI output port and schedules note on/off
and CC64 messages using `performance.now()` timestamps.

**Lookahead scheduler:**
- `setInterval(tick, 30)` — every 30ms, schedule events up to 150ms ahead
- `safeOnMs = Math.max(onMs, nowMs + 5)` — prevents scheduling in the past
- Notes already ended (offMs + 200 ≤ nowMs) are skipped
- CC64 sent on all channels that have notes; initial value interpolated at seek point
  so pedal state is correct when starting mid-piece
- Articulation applied at scheduling time only — `endTick` in state is never mutated

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

## Snap Grid

Snap resolutions: `1/1`, `1/2`, `1/4`, `1/8`, `1/8T`, `1/16`, `1/16T`, `1/32`, `1/32T`
Triplet grids (`T`) are `tpb * 2/3` (`1/8T`), `tpb / 3` (`1/16T`), and `tpb / 6` (`1/32T`).
`state.snapTick(tick)` returns the nearest snapped tick for a given value.
Grid renders: sub-beat lines (faint `#222`), beat lines (`#2a2a2a`), bar lines (`#3a3a3a`).

---

## Design Principles

- **High contrast dark theme** — background `#1a1a1a`, UI panels `#111`, text `#fff`,
  control borders `#666`. Monospace font throughout (`12px monospace`).
- **5 px padding** on all control panels. Use a `.inner` wrapper div inside custom
  elements rather than `:host { padding }` — the wrapper approach is immune to
  shadow DOM padding quirks in some browsers.
- **No rounded corners, drop shadows, or decorative glows.**
- **No dependencies** — no npm, no CDN imports. If something can be done in vanilla
  JS, do it there; otherwise write it ourselves.
- **No build step** — ever. ES modules loaded directly by the browser.
- **On file load**: auto-fit horizontal zoom (entire piece visible), scroll to show
  the top of the used pitch range. Note height is fixed at 16 px.

---

## Implementation Notes

Non-obvious details worth knowing before touching the code:

- **Rect selection click suppression:** `_didRectSel` and `_didPan` flags prevent the `click` event firing after a completed drag or pan. Drag threshold is 6 px (`DRAG_THRESHOLD`, shared by rect-select and note-drag activation).
- **Canvas coordinate scaling:** `_canvasPos(e)` scales CSS pixels by `canvas.width / r.width`. Without this, hit testing drifts when canvas logical size differs from its CSS-rendered size. Dimensions are driven by `ResizeObserver`.
- **Tempo curve tick↔time:** within each sub-segment (bounded by `tempoMap` and `tempoPoints` breakpoints) baseBpm is constant and ratio is piecewise-linear, yielding the closed-form integral `scale * ln(r1/r0) / (r1-r0)` where `scale = D*60/(tpb*baseBpm)`. `timeToTick` uses binary search over this.
- **Pedal CC64 scheduling:** sent on all channels that have notes; initial value is interpolated at the seek point so pedal state is correct when starting mid-piece.
- **Articulation** is applied at MIDI scheduling time only — `endTick` in state is never mutated. `stacc` ×0.50, `staccatiss` ×0.25. `legato`/`legatissimo` extend to the next note's `startTick` on the same channel plus a fixed overlap of `tpb/16` / `tpb/8` ticks respectively; if no next note exists on that channel, `endTick` is used unchanged.
- **Velocity curve** is applied at MIDI scheduling time too — `vel = clamp(note.velocity + state.velocityCurve[pitch-21], 1, 127)`. Stored note velocity is never mutated; the curve is per-device calibration, not per-score.
- **Undo/redo** is snapshot-based (deep copies of `notes`, `pedalPoints`, `tempoPoints`, plus the selection), 100-entry stack. Drag interactions (note resize, note move, curve-point move) push undo **once** at drag start via `resizeNoteStart` / `moveNotesStart` / `beginCurvePointMove`; per-frame updates mutate live without pushing. Bookmarks and the velocity curve are NOT part of undo.
- **Alt+click note insertion:** duration fixed at 1 beat, velocity 64, tick snapped to grid, note immediately selected.

---

## Testing

Two suites, both run by `npm test`:

- **Vitest engine tests** (`tests/engine/test.js`, `test.state.js`,
  `test.musicxml.js`) cover `engine/state.js` and `engine/musicxml.js` in
  isolation — pure JS, no DOM beyond `DOMParser`. Coverage is collected for
  those two files only (`vitest.config.js`). Run alone with `npm run test:engine`.
- **Playwright UI tests** (`tests/ui/smoke.test.js`, `notes.test.js`, helpers
  in `helpers.js`, fixture in `fixtures/project.json`) drive the real page via
  a `python3 -m http.server` web server started by `playwright.config.js`. Run
  alone with `npm run test:ui`. Single worker, serial — these tests share the
  static server.
