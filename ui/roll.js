// ui/roll.js
import { state, snapGridTicks } from '../engine/state.js';
import {
  KEY_WIDTH, HEADER_HEIGHT,
  PITCH_MIN, PITCH_MAX, PITCH_RANGE,
  canvasPos, isFormFocused,
} from './dom-utils.js';

const COL_BG         = '#1a1a1a';
const COL_GRID_BEAT  = '#343434';
const COL_GRID_BAR   = '#525252';
const COL_GRID_SUB   = '#212121';
const COL_RULER_BG   = '#111111';
const COL_RULER_STRIPE = '#1d1d1d';   // alternating (odd-bar) measure shade over the ruler base
const COL_RULER_TEXT = '#888888';
const COL_PLAYHEAD   = '#ffffff';
const COL_BOOKMARK     = '#e08030';
const COL_BOOKMARK_HOT = '#ffb060';

// Relative luminance (WCAG) of an `hsl(h,s%,l%)` string, 0 (black) … 1 (white).
// HSL lightness alone isn't perceptual — gold and blue at the same `l` differ
// wildly in brightness — so we convert through sRGB and weight the channels.
function relativeLuminance(hsl) {
  let [h, s, l] = hsl.match(/[\d.]+/g).map(Number);
  s /= 100; l /= 100;
  const c  = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x  = c * (1 - Math.abs(hp % 2 - 1));
  const m  = l - c / 2;
  const rgb = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
            : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const [r, g, b] = rgb.map(v => {
    v += m;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Black or white label, whichever has the higher WCAG contrast against `fill`.
// The crossover (luminance ≈ 0.179) is exactly where black-on-fill and
// white-on-fill contrast ratios meet, so this is genuinely maximum contrast.
// One rule for every roll label — the per-note velocity numbers —
// adapting to the actual rendered fill, so it tracks velocity and the hover
// brightening alike (a near-threshold fill flips on hover, by design: the label
// always follows the most legible choice for the current fill).
// Memoized: this runs per visible note per frame, and the input space is tiny
// (the hsl() strings noteHSL can produce), but the regex parse isn't free.
const _labelColorCache = new Map();
export function labelColorFor(fill) {
  let color = _labelColorCache.get(fill);
  if (color === undefined) {
    color = relativeLuminance(fill) > 0.179 ? '#000' : '#fff';
    _labelColorCache.set(fill, color);
  }
  return color;
}
const NOTE_LABEL_FONT = '9px monospace'; // per-note velocity number

// Velocity-mapped note fill. `displayState`: 'normal' | 'hovered' | 'dimmed'
// Viridis-style blue→green→yellow gradient (low → high velocity). Colorblind-safe:
// it avoids the red↔green pair, and lightness ramps up with velocity so brightness
// redundantly encodes the signal even when hue is ambiguous.
export function noteHSL(velocity, displayState) {
  const t = velocity / 127;
  const h = 250 - t * 200; // 250° indigo (low) → 50° yellow (high), via blue/teal/green
  const s = 60 + t * 30;   // 60–90% saturation (calmer low end, vivid high end)
  let   l = 32 + t * 33;   // 32–65% lightness ramps with velocity (redundant cue)
  if (displayState === 'dimmed')  l *= 0.55;
  if (displayState === 'hovered') l  = Math.min(80, l + 16);
  return `hsl(${Math.round(h)},${Math.round(s)}%,${Math.round(l)}%)`;
}

// Coincident (unplayable) note fill. Two notes on the same pitch with the same onset are two
// note-ons fired at one instant for a single key — impossible on a real piano, and a source of
// inconsistent velocities — so the redundant copies are painted a flat warning red instead of their
// velocity color (see _ensureNoteCaches). Red is otherwise absent from the viridis velocity
// ramp, so these stand out against every legitimate note. hsl() form keeps labelColorFor's
// luminance parse working (it expects an hsl() string).
const COL_UNPLAYABLE         = 'hsl(0,75%,45%)';
const COL_UNPLAYABLE_HOVERED = 'hsl(0,80%,60%)';

// Rectangle-selection rubber band (teal)
const COL_RECT_FILL   = 'rgba(92,200,200,0.1)';
const COL_RECT_STROKE = 'rgba(92,200,200,0.55)';

// Off-screen selection indicators: outward-pointing triangles drawn at the roll's
// content edges for selected notes that have scrolled out of view, so a selection
// can never be silently forgotten off-screen.
const COL_OFFSCREEN        = '#ffffff';
const COL_OFFSCREEN_STROKE = 'rgba(0,0,0,0.7)';  // outline so markers read against light notes
const OFFSCREEN_SIZE    = 9;  // triangle depth (px, perpendicular to the edge)
const OFFSCREEN_HALF    = 6;  // triangle base half-width (px, along the edge)

const DRAG_THRESHOLD    = 6;
const EDGE_THRESHOLD    = 6;
const HANDLE_WIDTH      = 6;
// Floor on the drawn/hit-tested width of a note (px), so zero-length and very
// short notes remain visible and clickable.
const MIN_NOTE_PX       = 2;
// Max scroll past the piece end, in beats (≈ 4 measures in 4/4)
const SCROLL_TAIL_BEATS = 16;
const BOOKMARK_HIT_RADIUS = 8;

// Auto-pan during rect-selection drag
const AUTO_PAN_ZONE = 40;   // px from content edge that triggers panning
const AUTO_PAN_MAX  = 12;   // px/frame at the edge (speed scales linearly inward)

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const BLACK_KEYS = [1, 3, 6, 8, 10];


export class PianoRoll {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    // View
    this.pixelsPerTick = 0.06;
    this.noteHeight    = 16;
    this.scrollX = 0;
    this.scrollY = 0;

    // Wiring filled in by the host (index.html)
    this.onPostRender = null;
    this.pedalLane    = null;
    this.tempoLane    = null;

    // Playhead drag (ruler seek)
    this.draggingPlayhead = false;
    this._seekTime        = 0;

    // Hover
    this._hoverNoteIdx  = -1;
    this._hoverNoteRightEdge = -1;  // index of note whose right edge is under the cursor
    this._lastMousePos  = null;

    // Rectangle selection drag
    this._rectSelActive      = false;
    this._rectSelStart       = null;    // canvas pixels at mousedown, used only for drag threshold
    this._rectSelStartWorld  = null;    // anchor in world coords {tick, worldY} — fixed during auto-pan
    this._rectSelCurrent     = null;
    this._rectDidDrag        = false;
    this._rectHitSet         = null;
    this._rectSelMode        = 'replace';  // 'replace' (bare) | 'extend' (Shift)
    this._didRectSel         = false;   // suppress the click event that follows mouseup

    // Auto-pan during rect selection
    this._autoPanRaf      = null;
    this._autoPanMousePos = null;

    // Pan (right-drag)
    this._panning    = false;
    this._panLastPos = null;

    // One button owns a gesture at a time: while a drag with one button is live,
    // presses/releases from the other button are ignored so left- and right-button
    // gestures can never mix. _suppressClick eats a stray left click produced when a
    // left press is locked out during a right-drag pan.
    this._suppressClick = false;

    // Right-edge resize drag
    this._resizingNoteRightIdx = -1;
    // Left-edge resize drag
    this._resizingNoteLeftIdx  = -1;
    // Shared resize state: note refs and original ticks captured at drag start
    this._resizeNoteRefs = [];
    this._resizeOrigins  = [];
    this._didResize      = false;  // suppress the click event that follows a resize mouseup

    // Insert drag (Alt) — a press anchors a new note's onset; dragging sets its
    // duration with a live ghost preview, a bare click inserts a default one-beat note.
    this._insertActive    = false;
    this._insertStartTick = 0;   // snapped onset, fixed at mousedown
    this._insertEndTick   = 0;   // snapped tick under the cursor, updated while dragging
    this._insertPitch     = -1;  // fixed at mousedown (the drag is horizontal only)
    this._didInsert       = false;  // suppress the click that follows an insert mouseup

    // Note drag (note body)
    this._draggingNotes     = false;
    this._dragNoteRefs      = [];
    this._dragOrigins       = [];
    this._dragStartTick     = 0;
    this._dragStartPitch    = 0;
    this._dragAxis          = null;  // axis lock during a note-body move: 'h' | 'v' | null (set once at activation)
    this._dragDidMove       = false;
    this._didNoteDrag       = false;
    this._pendingNoteHandle = -1;
    this._pendingDragStart  = null;
    this._hoverNoteHandle   = -1;
    this._hoverNoteLeftEdge = -1;
    this._hoverBookmarkIdx  = -1;
    this._hoverPitch        = -1;

    // Per-note render caches, rebuilt lazily (see _ensureNoteCaches) only when notes
    // change, not every render:
    //   _drawOrder     — indices sorted by duration descending: longest drawn first
    //                    (bottom), shortest last (top), so contained notes stay on top.
    //   _unplayableSet — indices of notes sharing a pitch+onset with an earlier note
    //                    (drawn red — unplayable on a real piano, see _ensureNoteCaches).
    this._drawOrder     = [];
    this._unplayableSet = new Set();
    this._notesDirty    = true;

    this._bindEvents();
    this._bindStateEvents();
  }

  // ── Layout ─────────────────────────────────────────────────────────

  get rollWidth()  { return this.canvas.width - KEY_WIDTH; }
  get rollHeight() { return this.canvas.height - HEADER_HEIGHT; }

  tickToX(tick)  { return KEY_WIDTH + (tick - this.scrollX) * this.pixelsPerTick; }
  xToTick(x)     { return (x - KEY_WIDTH) / this.pixelsPerTick + this.scrollX; }
  pitchToY(pitch){ return HEADER_HEIGHT + (PITCH_MAX - pitch) * this.noteHeight - this.scrollY; }
  yToPitch(y)    { return PITCH_MAX - Math.floor((y - HEADER_HEIGHT + this.scrollY) / this.noteHeight); }
  _noteWidthPx(n){ return Math.max(MIN_NOTE_PX, (n.endTick - n.startTick) * this.pixelsPerTick); }

  // Full canvas bounding box {x1,y1,x2,y2} of a note — no 1 px gap (that's applied
  // only when drawing). Used for rect-overlap hit-testing and off-screen markers.
  _noteBox(n) {
    const x1 = this.tickToX(n.startTick);
    const y1 = this.pitchToY(n.pitch);
    return { x1, y1, x2: x1 + this._noteWidthPx(n), y2: y1 + this.noteHeight };
  }

  // Full scrollable tick range — piece length plus a SCROLL_TAIL_BEATS pad.
  get scrollableTicks() {
    return state.totalTicks + SCROLL_TAIL_BEATS * state.ticksPerBeat;
  }

  // Max scrollX such that the visible window ends no more than
  // SCROLL_TAIL_BEATS past the piece. Returns 0 when the piece (plus tail)
  // already fits in the visible area.
  _maxScrollX() {
    if (!state.loaded) return 0;
    return Math.max(0, this.scrollableTicks - this.rollWidth / this.pixelsPerTick);
  }

  _clampScrollX(x) {
    return Math.max(0, Math.min(this._maxScrollX(), x));
  }

  _clampScrollY(y) {
    const maxScrollY = PITCH_RANGE * this.noteHeight - this.rollHeight;
    return Math.max(0, Math.min(maxScrollY, y));
  }

  // ── Render ─────────────────────────────────────────────────────────

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawBackground();
    this._drawGrid();
    this._drawNotes();
    this._drawInsertPreview();
    this._drawRectSelection();
    this._drawOffscreenSelection();
    this._drawLaneReticles();
    this._drawPlayhead();
    this._drawRuler();
    this._drawKeys();
    this.onPostRender?.();
  }

  _drawBackground() {
    const { ctx } = this;
    ctx.fillStyle = COL_BG;
    ctx.fillRect(KEY_WIDTH, HEADER_HEIGHT, this.rollWidth, this.rollHeight);

    for (let oct = 0; oct < 9; oct++) {
      const topPitch = 12 * (oct + 2);
      const y1 = this.pitchToY(topPitch + 11);
      const y2 = this.pitchToY(topPitch - 1);
      if (oct % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(KEY_WIDTH, y1, this.rollWidth, y2 - y1);
      }
      for (const semi of BLACK_KEYS) {
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(KEY_WIDTH, this.pitchToY(topPitch + semi), this.rollWidth, this.noteHeight);
      }
    }
  }

  _drawGrid() {
    if (!state.tempoMap.length) return;
    const { ctx } = this;
    const tpb      = state.ticksPerBeat;
    const tickStart = this.scrollX;
    const tickEnd   = tickStart + this.rollWidth / this.pixelsPerTick;

    // Lines at or before KEY_WIDTH are skipped — a bar line right at the boundary
    // would render a light-grey sliver across the key strip.
    const drawLine = x => {
      if (x <= KEY_WIDTH) return;
      ctx.beginPath(); ctx.moveTo(x, HEADER_HEIGHT); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    };

    ctx.strokeStyle = COL_GRID_SUB; ctx.lineWidth = 0.5;
    const subTicks = snapGridTicks(state.snapGrid, tpb);
    for (let t = Math.floor(tickStart / subTicks) * subTicks; t <= tickEnd; t += subTicks) {
      drawLine(this.tickToX(t));
    }

    ctx.strokeStyle = COL_GRID_BEAT; ctx.lineWidth = 1;
    for (let t = Math.floor(tickStart / tpb) * tpb; t <= tickEnd; t += tpb) {
      drawLine(this.tickToX(t));
    }

    ctx.strokeStyle = COL_GRID_BAR; ctx.lineWidth = 1.5;
    for (const { tick } of state.barBoundaries(tickStart, tickEnd)) {
      drawLine(this.tickToX(tick));
    }
  }

  _drawRuler() {
    const { ctx } = this;
    ctx.fillStyle = COL_RULER_BG;
    ctx.fillRect(KEY_WIDTH, 0, this.rollWidth, HEADER_HEIGHT);
    if (!state.tempoMap.length) return;

    const tickStart = this.scrollX;
    const tickEnd   = tickStart + this.rollWidth / this.pixelsPerTick;
    const boundaries = state.barBoundaries(tickStart, tickEnd);

    // Alternating measure backgrounds delineate bars in place of tick marks: every
    // other bar (odd bar number) gets a slightly lighter fill over the ruler base.
    // fillSpan paints [xa, xb] clipped to the content area; the roll grid below keeps
    // its own bar/beat lines.
    const fillSpan = (xa, xb, bar) => {
      if (bar % 2 !== 1) return;
      const x0 = Math.max(xa, KEY_WIDTH);
      if (xb <= x0) return;
      ctx.fillStyle = COL_RULER_STRIPE;
      ctx.fillRect(x0, 0, xb - x0, HEADER_HEIGHT);
    };

    for (let i = 0; i < boundaries.length; i++) {
      const xa = this.tickToX(boundaries[i].tick);
      const xb = i + 1 < boundaries.length ? this.tickToX(boundaries[i + 1].tick)
                                           : this.canvas.width;
      fillSpan(xa, xb, boundaries[i].bar);
    }
    // The bar clipped off the left edge has no boundary in range — it's the bar
    // before the first one (opposite parity), filling up to that boundary.
    if (boundaries.length) {
      fillSpan(KEY_WIDTH, this.tickToX(boundaries[0].tick), boundaries[0].bar - 1);
    }

    ctx.fillStyle = COL_RULER_TEXT; ctx.font = '10px monospace'; ctx.textBaseline = 'middle';
    for (const { tick, bar } of boundaries) {
      ctx.fillText(bar, this.tickToX(tick) + 6, HEADER_HEIGHT / 2 + 1);
    }

    // Bookmark markers — upward triangles at the bottom edge of the ruler
    for (let i = 0; i < state.bookmarks.length; i++) {
      const x = this.tickToX(state.bookmarks[i]);
      if (x <= KEY_WIDTH || x > this.canvas.width) continue;
      const hot = i === this._hoverBookmarkIdx;
      const hw  = hot ? 8  : 6;
      const h   = hot ? 13 : 10;
      ctx.fillStyle = hot ? COL_BOOKMARK_HOT : COL_BOOKMARK;
      ctx.beginPath();
      ctx.moveTo(x - hw, HEADER_HEIGHT);
      ctx.lineTo(x + hw, HEADER_HEIGHT);
      ctx.lineTo(x,      HEADER_HEIGHT - h);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawKeys() {
    const { ctx } = this;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, KEY_WIDTH, this.canvas.height);

    const showLabels = this.noteHeight >= 7;
    const fontSize   = Math.max(6, Math.min(9, this.noteHeight - 1));

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEADER_HEIGHT, KEY_WIDTH, this.canvas.height - HEADER_HEIGHT);
    ctx.clip();

    for (let pitch = PITCH_MIN; pitch <= PITCH_MAX; pitch++) {
      const y = this.pitchToY(pitch);
      if (y + this.noteHeight < HEADER_HEIGHT || y > this.canvas.height) continue;

      const isBlack  = BLACK_KEYS.includes(pitch % 12);
      const isHot    = pitch === this._hoverPitch;
      ctx.fillStyle  = isBlack ? (isHot ? '#555' : '#222') : (isHot ? '#fff' : '#ddd');
      ctx.fillRect(1, y + 1, KEY_WIDTH - 2, this.noteHeight - 1);

      if (showLabels) {
        const name = NOTE_NAMES[pitch % 12] + (Math.floor(pitch / 12) - 1);
        ctx.fillStyle  = isBlack ? '#fff' : '#111';
        ctx.font       = fontSize + 'px monospace';
        ctx.textBaseline = 'top';
        ctx.textAlign    = 'left';
        ctx.fillText(name, 3, y + 4);
      }
    }

    ctx.restore();
  }

  _drawNotes() {
    const { ctx } = this;

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, HEADER_HEIGHT, this.rollWidth, this.rollHeight);
    ctx.clip();

    const tickStart = this.scrollX;
    const tickEnd   = tickStart + this.rollWidth / this.pixelsPerTick;
    const effective = this._effectiveSelection();
    const hasSel    = effective.set.size > 0;

    this._ensureNoteCaches();

    // Notes that will have resize handles drawn over them this frame. The left grip
    // overlaps the top-left velocity label, so these notes shift their label right by
    // the handle width (see _drawNote) to keep the number legible.
    //
    // The set of grippable notes: the note under the cursor — and, if that note is
    // selected, every selected note (a resize on a selected note carries the whole
    // selection by the same tick delta, see _beginEdgeResize), so all show grips.
    const hi = this._hoverNoteHandle    >= 0 ? this._hoverNoteHandle
             : this._hoverNoteRightEdge >= 0 ? this._hoverNoteRightEdge
             : this._hoverNoteLeftEdge;
    let handleSet = null;
    if (hi >= 0 && state.selectedNoteIndices.has(hi)) {
      handleSet = state.selectedNoteIndices;
    } else if (hi >= 0) {
      handleSet = new Set([hi]);
    }

    // Cull off-view notes before drawing. Horizontal: outside the visible tick window.
    // Vertical: the note's pitch row sits entirely above/below the roll content area —
    // such notes are clipped to nothing anyway (the roll clip set above), so this just
    // skips the wasted fillRect/stroke/label calls (and noteHSL/labelColorFor) for a
    // score whose pitch span exceeds the viewport.
    for (const i of this._drawOrder) {
      const n = state.notes[i];
      if (n.endTick < tickStart || n.startTick > tickEnd) continue;
      const ny = this.pitchToY(n.pitch);
      if (ny + this.noteHeight < HEADER_HEIGHT || ny > this.canvas.height) continue;
      this._drawNote(i, n, effective, hasSel, handleSet !== null && handleSet.has(i));
    }

    if (handleSet) {
      for (const i of handleSet) {
        const n = state.notes[i];
        if (n) this._drawResizeHandles(n);
      }
    }

    ctx.restore();
  }

  // Rebuilds the per-note render caches, but only when notes have actually changed
  // (flagged dirty on loaded/selectionchanged). render() runs on every hover, pan, and
  // playback frame, so redoing this work unconditionally would re-sort and re-scan the
  // whole piece ~60×/s during playback for nothing.
  _ensureNoteCaches() {
    if (!this._notesDirty) return;
    const notes = state.notes;

    const order = Array.from({ length: notes.length }, (_, i) => i);
    order.sort((a, b) =>
      (notes[b].endTick - notes[b].startTick) - (notes[a].endTick - notes[a].startTick));
    this._drawOrder = order;

    // Coincident notes: two notes on the same pitch with the same onset are two note-ons
    // fired at one instant for a single key — unplayable. Re-striking a still-sounding
    // note at a *later* onset is fine and common, so only an identical startTick conflicts;
    // the held note's duration is irrelevant.) Key by pitch+onset and flag every note
    // after the first to share a key, so the redundant copies light up while one stays
    // as the note to keep.
    const seen = new Set();
    const unplayable = new Set();
    for (let i = 0; i < notes.length; i++) {
      const key = notes[i].pitch + ':' + notes[i].startTick;
      if (seen.has(key)) unplayable.add(i);
      else               seen.add(key);
    }
    this._unplayableSet = unplayable;

    this._notesDirty = false;
  }

  // Draws a clipped, top-left label inside a note box. `y` is the box top
  // (pitchToY + 1). Used for the per-note velocity number.
  _drawNoteLabel(x, y, w, text, color, inset = 0) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, w - 2, this.noteHeight - 3);
    ctx.clip();
    ctx.fillStyle    = color;
    ctx.font         = NOTE_LABEL_FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';
    ctx.fillText(text, x + 3 + inset, y + 4);
    ctx.restore();
  }

  // Returns the visible selection set, accounting for an in-progress rect drag.
  // A bare (replace) drag previews the hits as the entire new selection — notes
  // entering brighten, previously-committed notes leaving dim. A Shift (extend)
  // drag previews the hits as additions to the committed selection. `addingHits`
  // / `removingHits` are the subsets that would change on commit.
  _effectiveSelection() {
    const committed = state.selectedNoteIndices;
    const inDrag    = this._rectSelActive && this._rectDidDrag && this._rectHitSet !== null;
    if (!inDrag) return { set: committed, addingHits: null, removingHits: null, inDrag: false };

    if (this._rectSelMode === 'extend') {
      const set = new Set([...committed, ...this._rectHitSet]);
      return { set, addingHits: this._rectHitSet, removingHits: null, inDrag: true };
    }
    // 'replace': the rect hits become the whole selection; anything committed but
    // not hit is on its way out and dims as a removal preview.
    const set      = new Set(this._rectHitSet);
    const removing = new Set([...committed].filter(i => !this._rectHitSet.has(i)));
    return { set, addingHits: this._rectHitSet, removingHits: removing, inDrag: true };
  }

  _drawNote(i, n, effective, hasSel, hasHandles) {
    const { ctx } = this;
    const x = this.tickToX(n.startTick);
    const w = this._noteWidthPx(n);
    const y = this.pitchToY(n.pitch) + 1;
    const h = this.noteHeight - 1;

    const selected = effective.set.has(i);
    // willAdd: entering selection via current rect drag (not already committed)
    const willAdd  = effective.inDrag && effective.addingHits
                     && effective.addingHits.has(i)
                     && !state.selectedNoteIndices.has(i);
    // willRemove: leaving the selection via a red deselect rect (currently committed)
    const willRemove = effective.inDrag && effective.removingHits
                       && effective.removingHits.has(i)
                       && state.selectedNoteIndices.has(i);
    // Hovering a note highlights it; hovering a *selected* note highlights the
    // whole selection as a unit (they all move/resize together, so they read as one).
    const hovered  = !effective.inDrag
                     && (i === this._hoverNoteIdx
                         || (this._hoverNoteIdx >= 0 && selected
                             && effective.set.has(this._hoverNoteIdx)));

    let colorState = 'normal';
    // willRemove dims explicitly (independent of hasSel — removing the whole
    // selection empties the effective set, but departing notes should still dim).
    if (willRemove) colorState = 'dimmed';
    else if (hasSel && !selected && !willAdd && !hovered) colorState = 'dimmed';
    else if (hovered || willAdd) colorState = 'hovered';

    // A coincident (unplayable) note is painted red regardless of selection/dim state —
    // it's an error to surface, not a note to fade into the background — brightening only on
    // hover. Everything else uses the velocity-mapped viridis fill.
    const fill = this._unplayableSet.has(i)
      ? (colorState === 'hovered' ? COL_UNPLAYABLE_HOVERED : COL_UNPLAYABLE)
      : noteHSL(n.velocity, colorState);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);

    // Muted notes keep their velocity color (so the shaping stays visible) but get a
    // diagonal hatch — a fill-independent "silenced" marker that reads against any fill.
    if (n.muted) this._drawMuteHatch(x, y, w, h, fill);

    const isSel   = selected && !willAdd;
    const bw      = isSel ? 2 : 1;
    const bOff    = bw / 2;
    ctx.lineWidth   = bw;
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.strokeRect(x + bOff, y + bOff, w - bw, h - bw);

    // Every note shows its velocity number (label color adapts to the fill via labelColorFor).
    // When this note draws a resize grip, nudge the label right past the left handle so
    // the grip doesn't occlude the number.
    const labelInset = hasHandles ? Math.min(HANDLE_WIDTH, w / 2) : 0;
    this._drawNoteLabel(x, y, w, String(n.velocity), labelColorFor(fill), labelInset);
  }

  // Diagonal hatch (╱╱╱) over a muted note's box, clipped to it. The stripe color is
  // chosen from the fill's luminance the same way the velocity label is (labelColorFor),
  // so it always contrasts — white over dark low-velocity blues, black over bright yellows.
  _drawMuteHatch(x, y, w, h, fill) {
    const { ctx } = this;
    const gap = 5;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.strokeStyle = labelColorFor(fill) === '#000' ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let sx = x - h; sx < x + w; sx += gap) {
      ctx.moveTo(sx, y + h);
      ctx.lineTo(sx + h, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Left/right grip bars on a note, shown while it's hovered. Drawn within
  // _drawNotes' roll clip. Width caps at half the note so short notes still show two grips.
  _drawResizeHandles(n) {
    const { ctx } = this;
    const x  = this.tickToX(n.startTick);
    const w  = this._noteWidthPx(n);
    const y  = this.pitchToY(n.pitch) + 1;
    const h  = this.noteHeight - 1;
    const hw = Math.min(HANDLE_WIDTH, w / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x, y, hw, h);
    ctx.fillRect(x + w - hw, y, hw, h);
  }

  // The note an in-progress insert would commit: the dragged span once it covers at
  // least one snap step, else a default one-snap-step note (the current grid resolution)
  // a bare click inserts. Used by both the ghost preview and the mouseup commit so what
  // you see is what you get.
  _insertSpan() {
    const lo = Math.min(this._insertStartTick, this._insertEndTick);
    const hi = Math.max(this._insertStartTick, this._insertEndTick);
    if (hi > lo) return { startTick: lo, endTick: hi };
    const grid = snapGridTicks(state.snapGrid, state.ticksPerBeat);
    return { startTick: this._insertStartTick, endTick: this._insertStartTick + grid };
  }

  // Ghost of the note being drawn during an Alt insert drag — dashed white outline over
  // a translucent fill in the note's eventual velocity color (insert velocity is 64).
  _drawInsertPreview() {
    if (!this._insertActive) return;
    const { startTick, endTick } = this._insertSpan();
    const x = this.tickToX(startTick);
    const w = Math.max(MIN_NOTE_PX, (endTick - startTick) * this.pixelsPerTick);
    const y = this.pitchToY(this._insertPitch) + 1;
    const h = this.noteHeight - 1;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, HEADER_HEIGHT, this.rollWidth, this.rollHeight);
    ctx.clip();
    ctx.globalAlpha = 0.4;
    ctx.fillStyle   = noteHSL(64, 'normal');
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    ctx.restore();
  }

  _drawLaneReticles() {
    for (const lane of [this.pedalLane, this.tempoLane]) this._drawLaneReticle(lane);
  }

  _drawLaneReticle(lane) {
    if (!lane?._isHovered || lane._hoverTick === null) return;
    const x = this.tickToX(lane._hoverTick);
    if (x < KEY_WIDTH || x > this.canvas.width) return;
    const hot = lane._hoverPointIdx >= 0;
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hot ? lane.config.reticleHotColor : lane.config.reticleColor;
    ctx.lineWidth   = hot ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT);
    ctx.lineTo(x, this.canvas.height);
    ctx.stroke();
    ctx.restore();
  }

  _drawPlayhead() {
    if (!state.loaded) return;
    const x = this.tickToX(state.timeToTick(state.playheadTime));
    if (x <= KEY_WIDTH) return;
    const { ctx } = this;
    ctx.strokeStyle = COL_PLAYHEAD; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, HEADER_HEIGHT); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    ctx.fillStyle = COL_PLAYHEAD;
    ctx.beginPath(); ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,10); ctx.closePath(); ctx.fill();
  }

  // ── Hit testing ────────────────────────────────────────────────────

  // True when canvas y falls within note n's pitch row.
  _rowContains(n, y) {
    const ny = this.pitchToY(n.pitch);
    return y >= ny && y < ny + this.noteHeight;
  }

  // Walks _drawOrder back to front (topmost note first) and returns the index of
  // the first note in pos's pitch row for which test(n) is true, or -1.
  _hitNote(pos, test) {
    this._ensureNoteCaches();  // keep the caches fresh for hit-tests that precede a render
    for (let j = this._drawOrder.length - 1; j >= 0; j--) {
      const i = this._drawOrder[j];
      const n = state.notes[i];
      if (!this._rowContains(n, pos.y)) continue;
      if (test(n)) return i;
    }
    return -1;
  }

  // Returns the index of the note at canvas position pos, or -1.
  _noteAtPos(pos) {
    const tick = this.xToTick(pos.x);
    return this._hitNote(pos, n => n.startTick <= tick && n.endTick > tick);
  }

  // Returns the index of the note whose right edge is within EDGE_THRESHOLD px of pos, or -1.
  _noteRightEdgeAt(pos) {
    return this._hitNote(pos, n => {
      const nx = this.tickToX(n.startTick);
      const w  = this._noteWidthPx(n);
      return Math.abs(pos.x - (nx + w)) <= EDGE_THRESHOLD;
    });
  }

  // Returns the index of the note whose left edge zone contains pos, or -1.
  _noteLeftEdgeAt(pos) {
    return this._hitNote(pos, n => {
      const nx = this.tickToX(n.startTick);
      const w  = this._noteWidthPx(n);
      return pos.x >= nx && pos.x < nx + Math.min(HANDLE_WIDTH, w);
    });
  }

  // Returns the index of the note whose body (excluding both edge zones) contains pos, or -1.
  _noteBodyAt(pos) {
    return this._hitNote(pos, n => {
      const nx = this.tickToX(n.startTick);
      const w  = this._noteWidthPx(n);
      if (pos.x < nx || pos.x >= nx + w) return false;
      if (pos.x < nx + Math.min(HANDLE_WIDTH, w)) return false;
      if (Math.abs(pos.x - (nx + w)) <= EDGE_THRESHOLD) return false;
      return true;
    });
  }

  // Returns the index of the nearest bookmark within BOOKMARK_HIT_RADIUS of canvas x, or -1.
  _bookmarkNear(x) {
    let best = -1, bestDist = BOOKMARK_HIT_RADIUS + 1;
    for (let i = 0; i < state.bookmarks.length; i++) {
      const dist = Math.abs(this.tickToX(state.bookmarks[i]) - x);
      if (dist <= BOOKMARK_HIT_RADIUS && dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  // True when pos is inside the scrollable content area (excludes keys + ruler).
  _inRoll(pos) {
    return pos.x > KEY_WIDTH && pos.x < this.canvas.width
        && pos.y > HEADER_HEIGHT && pos.y < this.canvas.height;
  }

  // ── Events ─────────────────────────────────────────────────────────

  _bindStateEvents() {
    // loaded/selectionchanged are the only events that add, remove,
    // move, or resize notes — i.e. the only ones that can change the note caches (draw
    // order, unplayable set). Flag them dirty here so _ensureNoteCaches rebuilds next render.
    state.addEventListener('loaded',           () => { this.scrollX = 0; this._cancelRectSel(); this._notesDirty = true; this.render(); });
    state.addEventListener('selectionchanged', () => { this._notesDirty = true; this.render(); });
    state.addEventListener('playheadmoved',    () => this.render());
    state.addEventListener('pedalchanged',     () => this.render());
    state.addEventListener('tempochanged',     () => this.render());
    state.addEventListener('bookmarkschanged', () => this.render());
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('mousedown',  e  => this._onMouseDown(e));
    c.addEventListener('wheel',      e  => this._onWheel(e), { passive: false });
    c.addEventListener('click',      e  => this._onClick(e));
    c.addEventListener('mouseleave', () => this._onMouseLeave());
    window.addEventListener('keyup', e => {
      if (e.key === 'Alt' && !this._panning) this._refreshCursor();
    });
    // move/up on window so dragging off-canvas still registers (critical for ruler seek)
    window.addEventListener('mousemove', e => this._onMouseMove(e));
    window.addEventListener('mouseup',   e => this._onMouseUp(e));

    window.addEventListener('keydown', e => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    // A focused form control owns the keyboard outright — every shortcut below
    // (including Space/Home/End/Escape) must yield to typing and native control
    // behaviour like Space opening a <select>.
    if (isFormFocused(e)) return;

    // Show the insert (cell) cursor when Alt is held over the roll content. Alt is
    // the insert modifier and overrides move/resize, so it wins even over a note.
    if (e.key === 'Alt' && this._lastMousePos
        && !this._panning && !this._draggingNotes && !this._rectSelActive
        && this._inRoll(this._lastMousePos)) {
      this.canvas.style.cursor = 'cell';
    }
    if (e.key === 'Escape' && state.loaded) {
      if (this._insertActive) {
        e.preventDefault();
        this._insertActive = false;
        this._didInsert    = true;  // swallow the click when the held button releases
        this.render();
      } else if (this._rectSelActive || state.selectedNoteIndices.size > 0) {
        e.preventDefault();
        this._cancelRectSel();
        state.setSelection([]);
      }
    }
    if (e.key === ' ' && state.loaded) {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('toggle-playback'));
    }
    if (e.key === 'Home' && state.loaded) {
      e.preventDefault();
      this.scrollX = 0;
      this.render();
    }
    if (e.key === 'End' && state.loaded) {
      e.preventDefault();
      this.scrollX = Math.max(0, state.totalTicks - this.rollWidth / this.pixelsPerTick);
      this.render();
    }

    // ── Note editing shortcuts ─────────────────────────────────────────
    if (!state.loaded) return;

    const sel = state.selectedNoteIndices;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size > 0) {
      e.preventDefault();
      state.deleteNotes([...sel]);
    }
    if ((e.key === 'm' || e.key === 'M') && sel.size > 0) {
      e.preventDefault();
      state.toggleNoteMutes([...sel]);
    }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); this._seekToBookmark(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this._seekToBookmark( 1); }

    // Zoom toward the viewport center (no cursor to anchor on). '+' is typically
    // Shift+'='; accept both glyphs so the unshifted '=' works too.
    if (e.key === '+' || e.key === '=') { e.preventDefault(); this._zoomBy(1.1, KEY_WIDTH + this.rollWidth / 2); }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); this._zoomBy(0.9, KEY_WIDTH + this.rollWidth / 2); }
  }

  // Briefly surface a message in the status bar (handled in index.html).
  _flash(message) {
    document.dispatchEvent(new CustomEvent('roll-flash', { detail: { message } }));
  }

  _seekToBookmark(dir) {
    const bm = state.bookmarks;
    if (!bm.length) return;
    const cur = state.timeToTick(state.playheadTime);
    let target;
    if (dir < 0) {
      const prev = bm.filter(t => t < cur - 0.5);
      target = prev.length ? prev[prev.length - 1] : bm[bm.length - 1];
    } else {
      target = bm.find(t => t > cur + 0.5) ?? bm[0];
    }
    const time = state.tickToTime(target);
    state.setPlayheadTime(time);
    this.canvas.dispatchEvent(new CustomEvent('user-seek', { bubbles: true, detail: { time } }));
    this.scrollX = this._clampScrollX(target - this.rollWidth / this.pixelsPerTick / 2);
    this.render();
  }

  _refreshCursor() {
    if (this._draggingNotes) {
      this.canvas.style.cursor = 'grabbing';
    } else if (this._resizingNoteRightIdx >= 0 || this._resizingNoteLeftIdx >= 0
               || this._hoverNoteRightEdge >= 0 || this._hoverNoteLeftEdge >= 0) {
      this.canvas.style.cursor = 'ew-resize';
    } else if (this._hoverNoteHandle >= 0) {
      this.canvas.style.cursor = 'grab';
    } else {
      this.canvas.style.cursor = '';
    }
  }

  _canvasPos(e) { return canvasPos(this.canvas, e); }

  _cancelRectSel() {
    this._stopAutoPan();
    this._rectSelActive     = false;
    this._rectSelStart      = null;
    this._rectSelStartWorld = null;
    this._rectSelCurrent    = null;
    this._rectDidDrag       = false;
    this._rectHitSet        = null;
    this._rectSelMode       = 'replace';
  }

  // Returns {vx, vy} pixels/frame for the given canvas position.
  // Speed ramps from 0 at AUTO_PAN_ZONE inward to AUTO_PAN_MAX at the edge.
  _autoPanVelocity(pos) {
    let vx = 0, vy = 0;
    const dl = pos.x - KEY_WIDTH;
    const dr = this.canvas.width  - pos.x;
    const dt = pos.y - HEADER_HEIGHT;
    const db = this.canvas.height - pos.y;
    if (dl < AUTO_PAN_ZONE) vx = -AUTO_PAN_MAX * (1 - Math.max(0, dl) / AUTO_PAN_ZONE);
    if (dr < AUTO_PAN_ZONE) vx =  AUTO_PAN_MAX * (1 - Math.max(0, dr) / AUTO_PAN_ZONE);
    if (dt < AUTO_PAN_ZONE) vy = -AUTO_PAN_MAX * (1 - Math.max(0, dt) / AUTO_PAN_ZONE);
    if (db < AUTO_PAN_ZONE) vy =  AUTO_PAN_MAX * (1 - Math.max(0, db) / AUTO_PAN_ZONE);
    return { vx, vy };
  }

  _startAutoPan() {
    if (this._autoPanRaf !== null) return;
    const step = () => {
      if (!this._rectSelActive || !this._rectDidDrag || !this._autoPanMousePos) {
        this._autoPanRaf = null;
        return;
      }
      const { vx, vy } = this._autoPanVelocity(this._autoPanMousePos);
      if (vx === 0 && vy === 0) { this._autoPanRaf = null; return; }
      this.scrollX = this._clampScrollX(this.scrollX + vx / this.pixelsPerTick);
      this.scrollY = this._clampScrollY(this.scrollY + vy);
      this._rectHitSet = this._notesInRect();
      this.render();
      this._autoPanRaf = requestAnimationFrame(step);
    };
    this._autoPanRaf = requestAnimationFrame(step);
  }

  _stopAutoPan() {
    if (this._autoPanRaf !== null) {
      cancelAnimationFrame(this._autoPanRaf);
      this._autoPanRaf = null;
    }
  }

  _onMouseLeave() {
    this._hoverNoteIdx       = -1;
    this._hoverNoteRightEdge = -1;
    this._hoverNoteHandle    = -1;
    this._hoverNoteLeftEdge  = -1;
    this._hoverBookmarkIdx   = -1;
    this._hoverPitch         = -1;
    if (!this._panning) this._refreshCursor();
    this.render();
  }

  _selectionRect() {
    const sx = this.tickToX(this._rectSelStartWorld.tick);
    const sy = this._rectSelStartWorld.worldY + HEADER_HEIGHT - this.scrollY;
    return {
      x1: Math.min(sx, this._rectSelCurrent.x),
      y1: Math.min(sy, this._rectSelCurrent.y),
      x2: Math.max(sx, this._rectSelCurrent.x),
      y2: Math.max(sy, this._rectSelCurrent.y),
    };
  }

  _drawRectSelection() {
    if (!this._rectSelActive || !this._rectDidDrag) return;
    const { x1, y1, x2, y2 } = this._selectionRect();
    const { ctx, canvas } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, HEADER_HEIGHT, canvas.width - KEY_WIDTH, canvas.height - HEADER_HEIGHT);
    ctx.clip();
    ctx.fillStyle   = COL_RECT_FILL;
    ctx.strokeStyle = COL_RECT_STROKE;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
    ctx.restore();
  }

  // Markers at the roll's content edges pointing toward selected notes that have
  // scrolled out of view. Each off-screen selected note contributes one outward
  // triangle at the nearest edge, placed at the note's cross-axis position (clamped
  // into view) so the markers roughly map where the hidden selection sits — high up
  // the left edge means high-pitched notes off to the left, etc. Horizontal overflow
  // takes precedence: a note off only vertically marks the top/bottom edge. Markers
  // are deduplicated into 4 px cross-axis buckets per edge, so a large off-screen
  // selection reads as a continuous band rather than overdrawing thousands of glyphs.
  _drawOffscreenSelection() {
    const sel = state.selectedNoteIndices;
    if (sel.size === 0) return;

    const left = KEY_WIDTH, right = this.canvas.width;
    const top  = HEADER_HEIGHT, bottom = this.canvas.height;

    const seen  = new Set();
    const marks = [];  // { edge: 'L'|'R'|'T'|'B', pos }  (pos = cross-axis pixel)
    for (const i of sel) {
      const n = state.notes[i];
      if (!n) continue;
      const { x1: nx1, y1: ny1, x2: nx2, y2: ny2 } = this._noteBox(n);

      let edge, pos;
      if      (nx2 < left)   { edge = 'L'; pos = (ny1 + ny2) / 2; }
      else if (nx1 > right)  { edge = 'R'; pos = (ny1 + ny2) / 2; }
      else if (ny2 < top)    { edge = 'T'; pos = (nx1 + nx2) / 2; }
      else if (ny1 > bottom) { edge = 'B'; pos = (nx1 + nx2) / 2; }
      else continue;  // visible — intersects both axes

      pos = (edge === 'L' || edge === 'R')
        ? Math.max(top + OFFSCREEN_HALF,  Math.min(bottom - OFFSCREEN_HALF, pos))
        : Math.max(left + OFFSCREEN_HALF, Math.min(right - OFFSCREEN_HALF,  pos));
      const bucket = edge + Math.round(pos / 4);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      marks.push({ edge, pos });
    }
    if (!marks.length) return;

    const { ctx } = this;
    const s = OFFSCREEN_SIZE, h = OFFSCREEN_HALF;
    ctx.fillStyle   = COL_OFFSCREEN;
    ctx.strokeStyle = COL_OFFSCREEN_STROKE;
    ctx.lineWidth   = 1;
    ctx.lineJoin    = 'miter';
    for (const { edge, pos } of marks) {
      ctx.beginPath();
      if (edge === 'L') {
        ctx.moveTo(left + 1, pos);  ctx.lineTo(left + 1 + s, pos - h);  ctx.lineTo(left + 1 + s, pos + h);
      } else if (edge === 'R') {
        ctx.moveTo(right - 1, pos); ctx.lineTo(right - 1 - s, pos - h); ctx.lineTo(right - 1 - s, pos + h);
      } else if (edge === 'T') {
        ctx.moveTo(pos, top + 1);   ctx.lineTo(pos - h, top + 1 + s);   ctx.lineTo(pos + h, top + 1 + s);
      } else {
        ctx.moveTo(pos, bottom - 1); ctx.lineTo(pos - h, bottom - 1 - s); ctx.lineTo(pos + h, bottom - 1 - s);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  // Returns a Set of note indices whose canvas rects overlap the current selection rect.
  _notesInRect() {
    const { x1, y1, x2, y2 } = this._selectionRect();
    const hits = new Set();
    for (let i = 0; i < state.notes.length; i++) {
      const { x1: nx1, y1: ny1, x2: nx2, y2: ny2 } = this._noteBox(state.notes[i]);
      if (nx2 >= x1 && nx1 <= x2 && ny2 >= y1 && ny1 <= y2) hits.add(i);
    }
    return hits;
  }

  // Begin a left/right edge resize drag anchored on `anchorIdx`. If the anchor is
  // selected, all selected notes resize together; the anchor is moved to index 0
  // so the grid snap is applied to it and the others follow by the same delta.
  _beginEdgeResize(anchorIdx, side) {
    const isSelected    = state.selectedNoteIndices.has(anchorIdx);
    const resizeIndices = isSelected ? [...state.selectedNoteIndices] : [anchorIdx];
    const ai = resizeIndices.indexOf(anchorIdx);
    if (ai > 0) { resizeIndices.splice(ai, 1); resizeIndices.unshift(anchorIdx); }
    state.resizeNoteStart(resizeIndices);
    this._resizeNoteRefs = resizeIndices.map(i => state.notes[i]).filter(Boolean);
    if (side === 'right') {
      this._resizingNoteRightIdx = anchorIdx;
      this._resizeOrigins = this._resizeNoteRefs.map(n => ({ endTick: n.endTick }));
    } else {
      this._resizingNoteLeftIdx = anchorIdx;
      this._resizeOrigins = this._resizeNoteRefs.map(n => ({ startTick: n.startTick }));
    }
    this.canvas.style.cursor = 'ew-resize';
  }

  // Which mouse button, if any, currently owns an in-progress gesture: 2 for a
  // right-drag pan, 0 for any left-button gesture (rubber-band, note move/resize,
  // insert, playhead seek), or null when idle.
  _gestureButton() {
    if (this._panning) return 2;
    if (this._rectSelActive || this._draggingNotes || this._pendingNoteHandle >= 0
      || this._resizingNoteRightIdx >= 0 || this._resizingNoteLeftIdx >= 0
      || this._insertActive || this.draggingPlayhead) return 0;
    return null;
  }

  _onMouseDown(e) {
    if (!state.loaded) return;

    // Lock out the other button while a gesture is live, so a right-press can't pan
    // mid left-drag (and vice versa). A locked-out left press still emits a trailing
    // click, so flag it for suppression.
    const owner = this._gestureButton();
    if (owner !== null && e.button !== owner) {
      if (e.button === 0) this._suppressClick = true;
      return;
    }
    this._suppressClick = false;  // a fresh, non-locked press starts clean
    // Stale suppress flags: if the previous gesture's release landed off-canvas,
    // its trailing click never fired and the flag would eat this press's click.
    // Any click those flags were meant for has fired before this mousedown.
    this._didRectSel = this._didNoteDrag = this._didResize = this._didInsert = false;

    const pos = this._canvasPos(e);

    // Ctrl+right-click in ruler: remove nearest bookmark
    if (e.button === 2 && e.ctrlKey && pos.y < HEADER_HEIGHT && pos.x > KEY_WIDTH) {
      const nearIdx = this._bookmarkNear(pos.x);
      if (nearIdx >= 0) state.removeBookmark(nearIdx);
      return;
    }

    // Right-drag pans the view (horizontal + vertical) over the roll content
    if (e.button === 2) {
      if (this._inRoll(pos)) {
        this._panning    = true;
        this._panLastPos = pos;
        this.canvas.style.cursor = 'grabbing';
      }
      return;
    }

    if (e.button !== 0) return;

    if (pos.y < HEADER_HEIGHT && pos.x > KEY_WIDTH) {
      if (e.ctrlKey) {
        state.addBookmark(state.snapTick(Math.max(0, Math.round(this.xToTick(pos.x)))));
        return;
      }
      this.draggingPlayhead = true;
      this._seekTime = state.tickToTime(Math.max(0, this.xToTick(pos.x)));
      state.setPlayheadTime(this._seekTime);
      return;
    }
    if (pos.x < KEY_WIDTH) return;

    // Alt is the insert modifier and overrides move/resize, so it wins even over an
    // existing note: the press anchors the new note's onset (snapped) and pitch, and a
    // drag sets its duration with a live ghost preview. The commit happens on mouseup.
    if (e.altKey) {
      this._insertActive    = true;
      this._insertPitch     = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.yToPitch(pos.y)));
      this._insertStartTick = state.snapTick(Math.max(0, Math.round(this.xToTick(pos.x))));
      this._insertEndTick   = this._insertStartTick;
      this.render();
      return;
    }

    // Notes move and resize freely (no modifier). A press on a note's edge resizes it,
    // on its body begins a move; a press on empty space starts a rubber-band.
    if (this._hoverNoteRightEdge >= 0) { this._beginEdgeResize(this._hoverNoteRightEdge, 'right'); return; }
    if (this._hoverNoteLeftEdge  >= 0) { this._beginEdgeResize(this._hoverNoteLeftEdge,  'left');  return; }
    if (this._hoverNoteHandle    >= 0) {
      this._pendingNoteHandle = this._hoverNoteHandle;
      this._pendingDragStart  = pos;
      this.canvas.style.cursor = 'grabbing';  // commit to grab on press, before the drag threshold
      return;
    }

    // Empty-space press starts a rubber-band. The modifier picks the rect mode, fixed
    // here at mousedown so releasing it mid-drag doesn't flip it: Shift extends the
    // committed selection, a bare drag replaces it.
    this._rectSelActive     = true;
    this._rectSelStart      = pos;
    this._rectSelStartWorld = { tick: this.xToTick(pos.x), worldY: pos.y - HEADER_HEIGHT + this.scrollY };
    this._rectSelCurrent    = pos;
    this._rectDidDrag       = false;
    this._rectSelMode       = e.shiftKey ? 'extend' : 'replace';
  }

  _onMouseMove(e) {
    const pos = this._canvasPos(e);
    this._lastMousePos = pos;

    const newHoverPitch = (pos.y > HEADER_HEIGHT && pos.y < this.canvas.height)
      ? Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.yToPitch(pos.y))) : -1;
    const hoverPitchChanged = newHoverPitch !== this._hoverPitch;
    this._hoverPitch = newHoverPitch;

    if (this._panning) {
      const dx = pos.x - this._panLastPos.x;
      const dy = pos.y - this._panLastPos.y;
      this._panLastPos = pos;
      if (dx !== 0 || dy !== 0) {
        this.scrollX = this._clampScrollX(this.scrollX - dx / this.pixelsPerTick);
        this.scrollY = this._clampScrollY(this.scrollY - dy);
        this.render();
      }
      return;
    }

    // Right-edge resize — update note endTick live, skip all other tracking
    if (this._resizingNoteRightIdx >= 0) {
      const anchorNote = state.notes[this._resizingNoteRightIdx];
      if (anchorNote) {
        const rawTick = Math.round(this.xToTick(pos.x));
        const snapped = state.snapTick(Math.max(anchorNote.startTick + 1, rawTick));
        const delta   = snapped - this._resizeOrigins[0].endTick;
        state.resizeNotesRight(this._resizeNoteRefs.map((note, k) => ({
          note, endTick: this._resizeOrigins[k].endTick + delta,
        })));
      }
      return;
    }

    // Left-edge resize — update note startTick live, skip all other tracking
    if (this._resizingNoteLeftIdx >= 0) {
      const anchorNote = state.notes[this._resizingNoteLeftIdx];
      if (anchorNote) {
        const snapped = state.snapTick(Math.round(this.xToTick(pos.x)));
        const delta   = snapped - this._resizeOrigins[0].startTick;
        state.resizeNotesLeft(this._resizeNoteRefs.map((note, k) => ({
          note, startTick: this._resizeOrigins[k].startTick + delta,
        })));
      }
      return;
    }

    // Activate pending note drag once movement exceeds threshold
    if (this._pendingNoteHandle >= 0) {
      const dx = pos.x - this._pendingDragStart.x;
      const dy = pos.y - this._pendingDragStart.y;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this._activateNoteDrag(pos);
    }

    // Note drag — update positions live, skip all other tracking
    if (this._draggingNotes) {
      this._updateNoteDrag(pos);
      return;
    }

    // Insert drag — extend the ghost note's duration live (horizontal only; pitch is
    // fixed at the press row), snapped to the grid like a resize.
    if (this._insertActive) {
      const tick = state.snapTick(Math.max(0, Math.round(this.xToTick(pos.x))));
      if (tick !== this._insertEndTick) { this._insertEndTick = tick; this.render(); }
      return;
    }

    // Bookmark hover in ruler
    const inRuler = pos.y >= 0 && pos.y < HEADER_HEIGHT && pos.x > KEY_WIDTH;
    const bookmarkIdx = inRuler ? this._bookmarkNear(pos.x) : -1;
    if (bookmarkIdx !== this._hoverBookmarkIdx) {
      this._hoverBookmarkIdx = bookmarkIdx;
      this.render();
    }

    // Note hover highlight — always tracked
    const inRoll  = this._inRoll(pos);
    const hoverNi = inRoll ? this._noteAtPos(pos) : -1;
    const hoverChanged = hoverNi !== this._hoverNoteIdx;
    this._hoverNoteIdx = hoverNi;

    if (this.draggingPlayhead) {
      this._seekTime = state.tickToTime(Math.max(0, this.xToTick(pos.x)));
      state.setPlayheadTime(this._seekTime); // dispatches playheadmoved → render
      return;
    }

    const { edgeNi, leftEdgeNi, handleNi, changed: edgeHoverChanged } = this._trackEdgeHover(pos, inRoll);

    if (this._rectSelActive) {
      this._rectSelCurrent = pos;
      if (!this._rectDidDrag) {
        const dx = pos.x - this._rectSelStart.x;
        const dy = pos.y - this._rectSelStart.y;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this._rectDidDrag = true;
      }
      if (this._rectDidDrag) {
        this._autoPanMousePos = pos;
        const { vx, vy } = this._autoPanVelocity(pos);
        if (vx !== 0 || vy !== 0) this._startAutoPan(); else this._stopAutoPan();
        this._rectHitSet = this._notesInRect();
      }
      if (this._rectDidDrag || hoverChanged || hoverPitchChanged) this.render();
      return;
    }

    this._setHoverCursor(e.altKey, inRoll, edgeNi, leftEdgeNi, handleNi);
    if (hoverChanged || edgeHoverChanged || hoverPitchChanged) this.render();
  }

  // Resolves right-edge / left-edge / body hover (all forced to -1 during a rect-select
  // drag) and returns the indices plus whether any of the three changed since last move.
  _trackEdgeHover(pos, inRoll) {
    // Notes move/resize without a modifier, so edge and body hover affordances light up
    // whenever the cursor is over a note (outside an in-progress rubber-band drag).
    const active     = inRoll && !this._rectSelActive;
    let   edgeNi     = active ? this._noteRightEdgeAt(pos) : -1;
    let   leftEdgeNi = (active && edgeNi < 0) ? this._noteLeftEdgeAt(pos) : -1;
    let   handleNi   = (active && edgeNi < 0 && leftEdgeNi < 0) ? this._noteBodyAt(pos) : -1;
    const changed    = edgeNi     !== this._hoverNoteRightEdge
                    || leftEdgeNi !== this._hoverNoteLeftEdge
                    || handleNi   !== this._hoverNoteHandle;
    this._hoverNoteRightEdge = edgeNi;
    this._hoverNoteLeftEdge  = leftEdgeNi;
    this._hoverNoteHandle    = handleNi;
    return { edgeNi, leftEdgeNi, handleNi, changed };
  }

  _setHoverCursor(altKey, inRoll, edgeNi, leftEdgeNi, handleNi) {
    if (altKey && inRoll) {
      this.canvas.style.cursor = 'cell';        // Alt = insert, overrides move/resize
    } else if (edgeNi >= 0 || leftEdgeNi >= 0) {
      this.canvas.style.cursor = 'ew-resize';
    } else if (handleNi >= 0) {
      this.canvas.style.cursor = 'grab';
    } else {
      this.canvas.style.cursor = '';
    }
  }

  _activateNoteDrag(pos) {
    const ni    = this._pendingNoteHandle;
    const press = this._pendingDragStart;  // press point — seeds the irrevocable axis lock
    this._pendingNoteHandle = -1;
    this._pendingDragStart  = null;

    const dragIndices = state.selectedNoteIndices.has(ni)
      ? [...state.selectedNoteIndices]
      : [ni];

    // Clear hover state before mutation so no ghost highlights appear during drag
    this._hoverNoteIdx       = -1;
    this._hoverNoteHandle    = -1;
    this._hoverNoteRightEdge = -1;
    this._hoverNoteLeftEdge  = -1;

    state.moveNotesStart(dragIndices);  // pushes undo, sets selection, renders

    this._dragNoteRefs = dragIndices.map(i => state.notes[i]).filter(Boolean);
    this._dragOrigins  = this._dragNoteRefs.map(n => ({
      startTick: n.startTick, endTick: n.endTick, pitch: n.pitch,
    }));

    // Sort so anchor (index 0) is the earliest-starting note — snap is applied to it
    const pairs = this._dragNoteRefs.map((ref, k) => ({ ref, origin: this._dragOrigins[k] }));
    pairs.sort((a, b) => a.origin.startTick - b.origin.startTick);
    this._dragNoteRefs = pairs.map(p => p.ref);
    this._dragOrigins  = pairs.map(p => p.origin);

    this._dragStartTick  = this.xToTick(pos.x);
    this._dragStartPitch = this.yToPitch(pos.y);
    // Lock the axis once, from the press→activation vector (the >6px that triggered the
    // drag carries the user's intent). It never flips for the rest of this gesture.
    this._dragAxis       = Math.abs(pos.x - press.x) >= Math.abs(pos.y - press.y) ? 'h' : 'v';
    this._dragDidMove    = false;
    this._draggingNotes  = true;
    this.canvas.style.cursor = 'grabbing';
  }

  _updateNoteDrag(pos) {
    // Axis is locked irrevocably at drag activation from the press→activation direction
    // (see _activateNoteDrag) and never flips: a move stays purely horizontal (timing)
    // or vertical (pitch) for its whole duration, regardless of later cross-axis travel.
    const axis = this._dragAxis;

    let snappedDelta = 0;
    if (axis === 'h') {
      const rawDeltaTick  = this.xToTick(pos.x) - this._dragStartTick;
      const anchorSnapped = state.snapTick(this._dragOrigins[0].startTick + rawDeltaTick);
      snappedDelta        = anchorSnapped - this._dragOrigins[0].startTick;
    }
    const deltaPitch = axis === 'v'
      ? Math.round(this.yToPitch(pos.y) - this._dragStartPitch)
      : 0;

    const moves = this._dragNoteRefs.map((note, k) => {
      const o = this._dragOrigins[k];
      return { note, startTick: o.startTick + snappedDelta, endTick: o.endTick + snappedDelta, pitch: o.pitch + deltaPitch };
    });

    this._dragDidMove = true;
    state.moveNotesLive(moves);
  }

  _onMouseUp(e) {
    // Only the button that owns the active gesture may end it; the other button's
    // release (e.g. left-up while right-drag panning) is ignored so the pan continues.
    const owner = this._gestureButton();
    if (owner !== null && e.button !== owner) return;

    if (this._panning) {
      this._panning = false;
      this._panLastPos = null;
      this.canvas.style.cursor = '';
      return;
    }

    if (this._resizingNoteRightIdx >= 0 || this._resizingNoteLeftIdx >= 0) {
      this._resizingNoteRightIdx = -1;
      this._resizingNoteLeftIdx  = -1;
      this._resizeNoteRefs = [];
      this._resizeOrigins  = [];
      // Suppress the trailing click so it can't re-run the selection matrix and
      // collapse the selection the resize just established onto the note edge.
      this._didResize = true;
      this._refreshCursor();
      return;
    }

    if (this._pendingNoteHandle >= 0) {
      this._pendingNoteHandle = -1;
      this._pendingDragStart  = null;
      this._refreshCursor();  // restore grab/idle cursor: the grabbing was committed on press
      // No threshold crossed — let click event handle selection normally
      return;
    }

    if (this._draggingNotes) {
      this._draggingNotes = false;
      this._dragNoteRefs  = [];
      this._dragOrigins   = [];
      if (this._dragDidMove) {
        this._didNoteDrag = true;
        this._dragDidMove = false;
      }
      this._refreshCursor();
      return;
    }

    if (this._insertActive && e.button === 0) {
      this._insertActive = false;
      const { startTick, endTick } = this._insertSpan();
      state.addNote(this._insertPitch, startTick, endTick, 64);  // dispatches → render
      this._didInsert = true;  // suppress the trailing click (incl. a bare Alt+click)
      return;
    }

    const wasDraggingPlayhead = this.draggingPlayhead;
    this.draggingPlayhead = false;

    if (wasDraggingPlayhead) {
      this.canvas.dispatchEvent(new CustomEvent('user-seek', {
        bubbles: true, detail: { time: this._seekTime }
      }));
      return;
    }

    if (!this._rectSelActive || e.button !== 0) return;

    const didDrag = this._rectDidDrag;
    const mode    = this._rectSelMode;
    const hits    = didDrag ? this._notesInRect() : new Set();
    this._cancelRectSel();

    if (didDrag) {
      this._didRectSel = true; // suppress the click event
      if (mode === 'extend') {
        state.setSelection([...new Set([...state.selectedNoteIndices, ...hits])]);
      } else {
        state.setSelection([...hits]);
      }
      this.render();
    }
    // Click without drag: _onClick fires separately and handles it
  }

  _onClick(e) {
    if (!state.loaded) return;
    if (this._suppressClick) { this._suppressClick = false; return; }
    if (this._didRectSel)  { this._didRectSel  = false; return; }
    if (this._didNoteDrag) { this._didNoteDrag = false; return; }
    if (this._didResize)   { this._didResize   = false; return; }
    if (this._didInsert)   { this._didInsert   = false; return; }

    const pos = this._canvasPos(e);
    if (pos.x < KEY_WIDTH || pos.y < HEADER_HEIGHT) return;

    const ni = this._noteAtPos(pos);
    if (ni !== -1) {
      e.stopPropagation();
      const current = state.selectedNoteIndices;
      // Classic single-click selection: Shift+click on top of an existing selection
      // toggles the hit note (adds if absent, removes if already in the selection);
      // otherwise the click replaces the selection with just it.
      if (e.shiftKey && current.size > 0) {
        if (current.has(ni)) state.setSelection([...current].filter(i => i !== ni));
        else                 state.setSelection([...current, ni]);
      } else if (!(current.size === 1 && current.has(ni))) {
        state.setSelection([ni]);
      }
      return;
    }

    // Click on empty space: clear the selection and seek the playhead.
    if (state.selectedNoteIndices.size > 0) state.setSelection([]);
    const time = state.tickToTime(Math.max(0, this.xToTick(pos.x)));
    state.setPlayheadTime(time);
    this.canvas.dispatchEvent(new CustomEvent('user-seek', {
      bubbles: true, detail: { time }
    }));
  }

  _onWheel(e) {
    e.preventDefault();
    const pos    = this._canvasPos(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;

    if (e.ctrlKey || e.metaKey) {
      this._zoomBy(factor, pos.x);
    } else {
      this.scrollX = this._clampScrollX(this.scrollX + e.deltaY / this.pixelsPerTick * 0.5);
      this.render();
    }
  }

  // Zoom horizontally by `factor`, holding the tick under `anchorX` (a canvas x
  // coordinate) fixed. Shared by Ctrl+wheel and the +/- keyboard shortcuts.
  _zoomBy(factor, anchorX) {
    const anchorTick   = this.xToTick(anchorX);
    this.pixelsPerTick = Math.max(0.01, Math.min(8, this.pixelsPerTick * factor));
    this.scrollX       = this._clampScrollX(anchorTick - (anchorX - KEY_WIDTH) / this.pixelsPerTick);
    this.render();
  }
}

