# UI — Piano Roll, Lanes, Toolbar

## Piano Roll (`roll.js`)

- Vertical axis: pitch (MIDI 21–108, A0–C8), fixed note height 16 px/semitone
- Horizontal axis: time in ticks, scrollable and zoomable
- Left strip (36 px, `KEY_WIDTH`): piano keyboard, all 88 keys labeled
- Top strip (24 px, `HEADER_HEIGHT`): bar/beat ruler, click/drag to seek playhead

**Controls:**
- `Scroll` — pan horizontal
- `Ctrl+scroll` — zoom horizontal (toward cursor tick); browser zoom is blocked
- `Right drag` — pan (horizontal + vertical); cursor shows `grabbing`
- `Home` — scroll to tick 0
- `End` — scroll to show last note at right edge
- `Space` — toggle playback
- `Escape` — clear selection (also cancels in-progress rect if one is active)
- `Click ruler` / `drag ruler` — seek playhead
- `Ctrl+click ruler` — add bookmark; `Ctrl+right-click bookmark` — remove
- `← / →` — seek to previous / next bookmark (wraps)
- `Alt+left click` — insert new note (default duration = one snap step at the current grid, velocity 64, tick snapped, immediately selected)
- `Alt+left drag` — insert a new note whose **duration is set by the drag** (a live dashed ghost previews it; onset snapped at press, the moving end snapped to grid like a resize; pitch fixed at the press row). A drag spanning at least one grid step uses that span; a shorter drag or a bare click falls back to the one-snap-step default. Committed on mouseup via `_insertSpan` (the same span the ghost shows), which `addNote`s and selects it; the trailing click is suppressed (`_didInsert`). Alt overrides move/resize, so it inserts even over an existing note.
- `Left drag empty` — teal rubber-band rectangle; covered notes **replace** the selection on release
- `Shift+left drag empty` — teal rubber-band rectangle; covered notes **extend** (union with) the selection
- `Left drag note body` — move selection (**no modifier**), **axis locked**: the axis (timing or pitch) is decided once from the press→activation direction (the >6px that triggers the drag) and **never flips** for the rest of the gesture — so a move is purely horizontal or purely vertical, and later cross-axis wandering is ignored
- `Left drag note left/right edge` — resize start / end (snapped to grid, **no modifier**); if the dragged note is selected, all selected notes resize together by the same tick delta. The note under the cursor draws explicit left/right grip bars on hover — and if that note is selected, every selected note draws them (they all resize as a unit). Resizing **selects** the resized note(s) (like move) and the trailing click is suppressed (`_didResize`), so a multi-note resize keeps its selection rather than collapsing onto the edge
- Moving and resizing need **no modifier** — a press on a note's body moves it, on an edge resizes it; a press on empty space starts a rubber-band. **Alt** is reserved (insert), so an Alt-press over a note does *not* move it — it begins an insert drag.
- `Delete` / `Backspace` — delete selected notes
- `M` — mute / unmute selected notes. `state.toggleNoteMutes` flips the `muted` flag: a mixed selection mutes all first, and only unmutes once every selected note is already muted. Muted notes are skipped during playback (`midi-out.js`) and marked with a diagonal hatch over their velocity colour (see Note Coloring)
- `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) — undo / redo

**Canvas coordinate scaling:** `_canvasPos(e)` scales mouse CSS coordinates by
`canvas.width / r.width` (and height). Without this, hit testing drifts at non-1:1
CSS/logical pixel ratios. Canvas is sized via `ResizeObserver` on `#roll-container`.

---

## Selection

A **classic** selection model: a plain click selects just the hit note (replacing whatever was
selected); **Shift** turns clicks into a **toggle** and rect drags into an **extend**. Shift+click
removes a note already in the selection (and adds one that isn't); Shift-drag only ever extends.
To drop notes from a selection, Shift-click them, click a different note (or empty space), or
**undo** (`setSelection` snapshots the selection onto the undo stack). Because moving and
resizing now need **no modifier**, a bare drag is a rubber-band only when it starts on **empty
space** — a drag starting on a note's body moves it, on an edge resizes it.

Single-click selection follows this matrix (the empty-space row always wins):

| Notes selected? | Shift held? | Note hit? | Result |
|---|---|---|---|
| no  | no  | yes | `selection = [hit]` |
| no  | yes | yes | `selection = [hit]` |
| yes | no  | yes | `selection = [hit]` (collapses to the one clicked) |
| yes | yes | yes (not in sel) | `selection += [hit]` (Shift adds) |
| yes | yes | yes (in sel)     | `selection −= [hit]` (Shift removes) |
| any | any | no  | `selection = []` |

- **Left click note** — select just that note (Shift+click toggles it against an existing selection: adds it if absent, removes it if already selected)
- **Left click empty** — clear the selection and seek the playhead to the click x-position
- **Left drag empty** — draws a **teal** rubber-band; overlapping notes **replace** the selection on release
- **Shift+left drag empty** — same teal rubber-band, but overlapping notes **extend** the selection (union)
- **Alt+left drag** — **no rubber-band**: Alt is the insert modifier, so an Alt-drag inserts a note (its duration set by the drag) and never selects (see Controls). The committing mouseup suppresses the trailing click via `_didInsert`.
- **Escape** — clears the selection (also cancels an in-progress rect drag or insert drag)
- **Right drag** — pans the view (see Controls); does not affect selection

The press target decides the gesture (resolved in `_onMouseDown` from the live hover indices):
**Alt → insert** (wins outright, even over a note), else edge → resize, body → move, empty →
rubber-band. (A Shift+click on a note toggles it in/out of the selection; only Shift+*drag*
extends.) The rect mode is fixed at mousedown into `_rectSelMode` (`'replace'` bare /
`'extend'` Shift), so releasing the modifier mid-drag doesn't flip it. An Alt press never reaches
the rect path — it sets up an insert drag instead, so there is no longer an `inert` rect mode.
During a rect drag, `_rectHitSet`
is updated each frame (via `_notesInRect`, which includes **all** overlapping notes).
`_effectiveSelection()` previews the pending result live: in **extend** mode the effective set is
`committed ∪ hits` and incoming notes brighten (`willAdd`); in **replace** mode it is just `hits`,
incoming notes brighten and any previously-committed note *not* in the rect dims as a removal
preview (`willRemove`, dimmed independently of `hasSel`). Hovering a note outside a drag also
shows highlighted.

The rect drag threshold is 6 px (`DRAG_THRESHOLD`). Below threshold the mouseup is treated
as a click (handled by the `click` event, not `mouseup`). `_didRectSel` suppresses the
`click` event after a completed rect drag. A right-drag pan produces no `click` event, so
panning needs no such suppression.

When the cursor enters the `AUTO_PAN_ZONE` band near a content edge during a rect drag, the
view auto-pans (a `requestAnimationFrame` loop) at a speed ramping to `AUTO_PAN_MAX` at the
edge; the rect anchor is held in world coords (`_rectSelStartWorld`) so the selection keeps
growing past the visible area.

### Off-screen selection indicators

So a selection scrolled out of view is never silently forgotten, `_drawOffscreenSelection`
draws small **outward-pointing white triangles** at the roll's content edges — one per
selected note that has scrolled off-screen, placed at the note's cross-axis position (clamped
into view) so the markers roughly map where the hidden selection sits (high on the left edge =
high-pitched notes off to the left, etc.). **Horizontal overflow takes precedence**: a note off
only vertically marks the top/bottom edge. Markers are deduplicated into 4 px cross-axis buckets
per edge (`OFFSCREEN_SIZE` / `OFFSCREEN_HALF` / `COL_OFFSCREEN`, with a dark outline
`COL_OFFSCREEN_STROKE` so they stay legible over light notes at the edge), so a large
off-screen selection reads as a continuous band rather than overdrawing thousands of glyphs. It reflects the
**committed** selection (`state.selectedNoteIndices`), not the live rect-drag preview. Drawn
after notes/rect-band and before the ruler/keys, so those strips paint over any edge bleed.

---

## Note Coloring

Fill color is velocity-mapped (`noteHSL` in `roll.js`): a viridis-style blue→green→yellow
gradient (250° indigo at low velocity → 50° yellow at high, via blue/teal/green), with
saturation 60–90% and lightness 32–65% both ramping with velocity. The palette is
**colorblind-safe** — it avoids the red↔green pair, and the lightness ramp redundantly
encodes velocity as brightness, so don't flatten lightness to a constant. Three display
states adjust the base lightness:
- **Normal**: notes in the current selection, or all notes when nothing is selected
- **Dimmed**: unselected notes when a selection exists (lightness × 0.55)
- **Highlighted**: hovered note (or, when the hovered note is selected, the whole selection — they read as one unit), or notes being added by an in-progress rect drag (lightness + 16, capped at 80%)

**Muted notes** (`n.muted`) keep their velocity-mapped fill (so the shaping stays visible)
and are marked instead by a **diagonal hatch** (`_drawMuteHatch` in `roll.js`) — a
fill-independent cue, since a flat grey fill collided with the mid-velocity (~50–65)
desaturated teal-greys of the viridis ramp. The hatch stripe colour is picked from the
fill's luminance the same way the velocity label is (`labelColorFor`: white over dark
low-velocity blues, black over bright yellows), so it always contrasts. Toggled with `M`
(`state.toggleNoteMutes`); skipped by the MIDI scheduler.

Selected notes are distinguished by border weight: 2 px solid white vs 1 px semi-transparent
white for others. Label text color is **luminance-adaptive** (`labelColorFor` in `roll.js`):
black or white per the WCAG max-contrast crossover (relative luminance ≈ 0.179) of the note's
actual fill — so darker low-velocity blues read white, bright high-velocity yellows flip to black, and the
choice tracks hover/dim brightening. Each note has a 1 px top gap (`y+1`, `h = noteHeight−1`),
visually separating adjacent pitches.

Each note box shows its velocity number (top-left), clipped to the note interior.

Notes are drawn (and hit-tested) in `_drawOrder` — indices sorted by duration descending, so
longer notes paint first (bottom) and shorter notes last (top). A short note fully contained
within a longer one therefore stays visible and clickable. Hit testing walks `_drawOrder` back
to front so the topmost note wins.

---

## Tool Windows

Floating DOM panels spawned at the cursor position, closed by clicking outside or Escape.
Keyboard shortcuts work when no `<input>`/`<select>` is focused.

- **[1] Curve** — pick a ramp shape (Linear / Ease in / Ease out / S-curve;
  `SCALE_EASINGS` in engine/state.js, default S-curve; the selector row is built by the
  shared `buildShapeRow` helper, the picker by `buildRampPicker`), then two-click: first click
  sets start velocity, second sets end. The eased ramp is baked across the selection by onset
  time — **a one-shot velocity edit, nothing persisted** (`state.applyVelocityCurve`).
- **[2] Note velocity** — 5–120 grid in steps of 5; click sets all selected notes
- **[3] Duration delta** — −50/−25/−10/+10/+25/+50%; scales selected notes' durations
  by the given factor (minimum 1 tick)
- **[4] Velocity delta** — `−10 / −5 / −1 / +1 / +5 / +10` buttons; offsets every
  selected note's velocity by the chosen amount (clamped 1–127)

Tools [1]–[4] require a non-empty selection (`requireSelection`) and silently refuse to
open without one.

---

## Curve Lanes (`curve-lane.js`, `tempo-lane.js`, `pedal-lane.js`)

Both lanes share the `CurveLane` base class, parameterised via a config object (label,
colors, value range, data accessors, add/remove/move callbacks). Lane-specific reticle
colors are read from `lane.config.reticleColor/reticleHotColor` by `roll.js`.

**Controls (identical for both lanes):**
- `Scroll` / `Ctrl+scroll` — horizontal pan / zoom (forwarded to roll)
- `Left-click empty` — add control point (tick snapped to grid; Y snapped to nearest neighbor within ±11 px, or to the lane's top/bottom edges, the range reference lines (`config.refFracs`: eighths for tempo, coarser quarters for pedal), and the lane baseline)
- `Left-drag point` — move an existing control point (same tick + Y snap; hold Ctrl to disable both)
- `Right-click` — remove nearest control point
- `Ctrl+left-click` — add control point without any snapping

**The browser context menu** is suppressed globally (window-level `contextmenu`
prevention), freeing the right button for gestures: roll pan, bookmark removal
(Ctrl+right-click on the ruler), and lane point removal.

### Tempo Lane (150 px, above pedal lane)
**Monotone cubic** tempo ratio curve (PCHIP — see engine/CLAUDE.md). Control points are
`{tick, value}` pairs (value 0.8–1.2).
- Centre of lane = ratio 1.0 (baseline tempo); top = ×1.2, bottom = ×0.8
- The lane renders the same spline that drives playback: the config supplies a `makeSampler`
  hook (tangents once, `evalMonotoneCubic` per pixel) and `CurveLane._traceSmoothCurve`
  samples it every 2 px into the amber polyline. Control points are small squares sitting
  on the curve. The pedal lane has no `makeSampler`, so it draws straight segments.
- Hovering shows a dashed vertical reticle in the roll

### Pedal Lane (75 px, below tempo lane)
Linear sustain pedal curve. Control points are `{tick, value}` pairs (value 0–1).
- Top of lane = CC64 127 (fully depressed), bottom = CC64 0 (fully released)
- Curve is drawn as a connected teal polyline; control points shown as small squares
- Hovering the lane shows a dashed vertical reticle in the roll at the cursor tick

---

## Status Bar (20 px, bottom)

Shows state only — note count, selection count, and a `Press [?] for help` prompt.
Driven by a single `updateStatus()` called on `loaded` and `selectionchanged`.

---

## Help Overlay

Press `?` (Shift+/) to open a centered modal listing all keyboard and mouse shortcuts
grouped by section (Selection / Editing / View / Playback / Curve lanes). Press `?`
again, Escape, or click outside to dismiss. The shortcut table lives in `HELP_SECTIONS`
in `index.html` — keep it in sync when adding or changing shortcuts.

---

## Toolbar (`toolbar.js`)

`<ph-toolbar>` custom element. Items:
Load MusicXML | Load project | Save project | Undo | Redo |
Stop | Play/Pause | Speed | Time | Snap grid | Vel. curve |
Re-strike (gap dropdown, `RESTRIKE_OPTIONS` 0–80 ms, default 60; 0 = Off; drives
`state.setRestrikeGap`, device-scoped — see engine/CLAUDE.md) |
MIDI out: Connect button (hidden once connected) + port dropdown

---

## Mini-map (`minimap.js`, 75 px, below pedal lane)

Full-piece overview. Shows all notes scaled to fit the canvas, the used pitch range as a
faint band, bookmark verticals, the playhead, and a translucent viewport indicator that
brightens on hover/drag. Left-click or left-drag pans the roll so the clicked tick centers
in the viewport.

---

## Velocity Curve Editor

Opened by the toolbar's "Vel. curve" button (no keyboard shortcut). An 88-column × 45-row
grid (one column per piano key, rows for delta −22…+22 with row 22 = 0). Left-click paints
a cell; left-drag interpolates between cells across the drag path; right-click resets a
column to 0. Closed by clicking outside, Escape, or the title-bar ✕. Values stored in
`state.velocityCurve`, persisted under `pianizer-vel-curve` (device-level calibration,
independent of the loaded project).

---

## Bookmarks

`state.bookmarks` is a sorted tick array, drawn on the ruler as orange upward triangles
that brighten on hover. Added/removed via Ctrl+click and Ctrl+right-click on the ruler;
`← / →` seek to previous/next bookmark (wrapping). Bookmarks are persisted in project
JSON but are **not** part of undo.
