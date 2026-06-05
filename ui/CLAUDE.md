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
- `Alt+left click empty` — insert new note (1-beat duration, velocity 64, tick snapped, immediately selected)
- `Left drag note body` — move selection horizontally
- `Shift+left drag note body` — move horizontally + pitch
- `Left drag note left/right edge` — resize start / end (snapped to grid); if the dragged note is selected, all selected notes resize together by the same tick delta
- `Delete` / `Backspace` — delete selected notes
- `Ctrl+Z` / `Ctrl+Y` (or `Ctrl+Shift+Z`) — undo / redo

**Canvas coordinate scaling:** `_canvasPos(e)` scales mouse CSS coordinates by
`canvas.width / r.width` (and height). Without this, hit testing drifts at non-1:1
CSS/logical pixel ratios. Canvas is sized via `ResizeObserver` on `#roll-container`.

---

## Selection

Selection is **additive and modifier-free**: clicks and rect drags only ever add notes;
there is no remove gesture. To take a note back out, **undo** (`setSelection` snapshots the
selection onto the undo stack), clear with empty-click/Escape, or rebuild the selection.

- **Left click note** — add that note to the selection (no-op if already selected; never removes)
- **Left click empty** — clear the selection and seek the playhead to the click x-position
- **Left drag** — draws a teal rubber-band rectangle; overlapping notes are **added** to the current selection on release
- **Escape** — clears the selection (also cancels an in-progress rect drag)
- **Right drag** — pans the view (see Controls); does not affect selection

During a rect drag, `_rectHitSet` is updated each frame. Notes newly entering via the rect (not yet in the committed selection) preview at highlighted brightness; notes already in the committed selection render at normal brightness. Hovering a note outside a drag also shows highlighted. Rect hits are always unioned with the committed selection on release.

The rect drag threshold is 6 px (`DRAG_THRESHOLD`). Below threshold the mouseup is treated
as a click (handled by the `click` event, not `mouseup`). `_didRectSel` suppresses the
`click` event after a completed rect drag. A right-drag pan produces no `click` event, so
panning needs no such suppression.

When the cursor enters the `AUTO_PAN_ZONE` band near a content edge during a rect drag, the
view auto-pans (a `requestAnimationFrame` loop) at a speed ramping to `AUTO_PAN_MAX` at the
edge; the rect anchor is held in world coords (`_rectSelStartWorld`) so the selection keeps
growing past the visible area.

---

## Note Coloring

Fill color is velocity-mapped (`noteHSL` in `roll.js`): hue fixed at 213° (blue),
saturation 65–80%, lightness 8–62%, both scaled linearly with velocity. Three display
states adjust the base lightness:
- **Normal**: notes in the current selection, or all notes when nothing is selected
- **Dimmed**: unselected notes when a selection exists (lightness × 0.55)
- **Highlighted**: hovered note, or notes being added by an in-progress rect drag (lightness + 16, capped at 78%)

Selected notes are distinguished by border weight: 2 px solid white vs 1 px semi-transparent
white for others. Label text is always white `#fff`. Each note has a 1 px top gap
(`y+1`, `h = noteHeight−1`), visually separating adjacent pitches.

Each note box shows its velocity number (top-left), clipped to the note interior —
**except** locked curve-group notes, which hide the number. Those notes are also filled
with their group's accent color (not the velocity-blue), with the ramp's endpoint values
shown as labels on the first/last member; see Curve Groups below.

Notes are drawn (and hit-tested) in `_drawOrder` — indices sorted by duration descending, so
longer notes paint first (bottom) and shorter notes last (top). A short note fully contained
within a longer one therefore stays visible and clickable. Hit testing walks `_drawOrder` back
to front so the topmost note wins.

---

## Tool Windows

Floating DOM panels spawned at the cursor position, closed by clicking outside or Escape.
Keyboard shortcuts work when no `<input>`/`<select>` is focused.

- **[1] Velocity scale** — pick a ramp shape (Linear / Ease in / Ease out / S-curve;
  `SCALE_EASINGS` in engine/state.js, default Linear; the selector row is built by the
  shared `buildShapeRow` helper), then two-click: first click sets start velocity, second
  sets end. The eased ramp is baked across the selection by onset time and **recorded as a
  locked curve group** (see Curve Groups) — `state.createCurveGroup`.
- **[2] Note velocity** — 5–120 grid in steps of 5; click sets all selected notes
- **[3] Duration delta** — −50/−25/−10/+10/+25/+50%; scales selected notes' durations
  by the given factor (minimum 1 tick)
- **[4] Velocity delta** — `−10 / −5 / −1 / +1 / +5 / +10` buttons; offsets every
  selected note's velocity by the chosen amount (clamped 1–127)

Tools [1]–[4] refuse a selection containing locked curve-group notes (a status flash
tells the user to dissolve the group first).

---

## Curve Groups (velocity ramps)

A velocity scale [1] records its result as a locked group (`state.curveGroups`, see
engine/CLAUDE.md). On the roll:

- **Member notes** are **always filled with the group's accent color** (`GROUP_COLORS`,
  cycled by group id; `state.groupOfNote` in `_drawNote`), overriding the velocity-blue
  fill so a group reads as a unit at all times. They hide their velocity number and are
  fully locked: `_trackEdgeHover` drops the resize/move affordance on them, mixed-selection
  drags and edge-resizes filter them out, Delete skips them (flashing a hint), and tools
  [1]–[4] refuse them. The only way to change them is the menu (below) or dissolving the group.
- **Endpoint labels** — the only group chrome on the roll (no square handles). The `from`
  velocity is drawn on every earliest-onset member and the `to` velocity on every
  latest-onset member, at the note box's top-left — the exact position/font of a normal
  note's velocity number (`_drawHandle` mirrors `_drawNote`'s number draw, clipped to the
  box), only in dark `GLABEL_COLOR` for contrast against the accent fill. Geometry/hit-test
  (hit box spans the label width over the note row): `_groupHandles` / `_mkHandle` / `_handleAt`.
- **Clicking any member note** opens the group menu — since locked members have no other
  affordance, the whole note body is a click target (`_groupNoteAt`), not just the endpoint
  labels. The cursor is `pointer` over any member, and this takes priority over note edit
  affordances; the endpoint-label hit (`_handleAt`) still wins where they overlap so the
  displayed velocity reads as the target. A press dispatches `curve-handle-menu`; index.html
  opens a "Curve group" tool window that reuses the scale tool's `buildRampPicker` — the
  **same shape selector + two-click velocity picker as creating the group** — but calls
  `state.reshapeCurveGroup` (one undo step via `state.beginCurvePointMove`) instead of
  `createCurveGroup`, plus a **Dissolve group** button (unlocks, keeps velocities). The
  trailing canvas click is suppressed via `_didHandleInteract`.

---

## Curve Lanes (`curve-lane.js`, `tempo-lane.js`, `pedal-lane.js`)

Both lanes share the `CurveLane` base class, parameterised via a config object (label,
colors, value range, data accessors, add/remove/move callbacks, optional `drawAnnotations`
hook). Lane-specific reticle colors are read from `lane.config.reticleColor/reticleHotColor`
by `roll.js`.

**Controls (identical for both lanes):**
- `Scroll` / `Ctrl+scroll` — horizontal pan / zoom (forwarded to roll)
- `Left-click empty` — add control point (tick snapped to grid; Y snapped to nearest neighbor within ±11 px, or to the lane's top/bottom edges, 25%/50%/75% reference lines, and the lane baseline)
- `Left-drag point` — move an existing control point (same tick + Y snap; hold Ctrl to disable both)
- `Right-click` — remove nearest control point
- `Ctrl+left-click` — add control point without any snapping

**Right mouse button** is disabled globally (`window contextmenu` prevention) except
on the two curve lane canvases (point removal).

### Tempo Lane (100 px, above pedal lane)
**Monotone cubic** tempo ratio curve (PCHIP — see engine/CLAUDE.md). Control points are
`{tick, value}` pairs (value 0.8–1.2).
- Centre of lane = ratio 1.0 (baseline tempo); top = ×1.2, bottom = ×0.8
- The lane renders the same spline that drives playback: the config supplies a `makeSampler`
  hook (tangents once, `evalMonotoneCubic` per pixel) and `CurveLane._traceSmoothCurve`
  samples it every 2 px into the amber polyline. Control points are small squares sitting
  on the curve. The pedal lane has no `makeSampler`, so it draws straight segments.
- Hovering shows a dashed vertical reticle in the roll

### Pedal Lane (100 px, below tempo lane)
Linear sustain pedal curve. Control points are `{tick, value}` pairs (value 0–1).
- Top of lane = CC64 127 (fully depressed), bottom = CC64 0 (fully released)
- Curve is drawn as a connected teal polyline; control points shown as small squares
- Hovering the lane shows a dashed vertical reticle in the roll at the cursor tick

### Rubato Balance Labels (tempo lane only)
`tempo-lane.js` supplies a `drawAnnotations` callback that finds every span between two
consecutive control points with value exactly 1.0 and at least one non-baseline point
between them. For each such span it computes `(curvedTime − baseTime) × 1000` and draws
the rounded ms delta next to **every** inner non-baseline point in the region (same value,
repeated per point — so the delta stays visible even if other points in the same gesture
are scrolled off). Each label flips to the lane edge opposite its own point's value
(point above 1.0 → label at bottom, point below → label at top). Green within ±1 ms,
amber otherwise. A balanced rubato gesture reads `0 ms`.

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
