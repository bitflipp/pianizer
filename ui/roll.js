// ui/roll.js
import { state, snapGridTicks } from '../engine/state.js';
import {
  KEY_WIDTH, HEADER_HEIGHT,
  PITCH_MIN, PITCH_MAX, PITCH_RANGE,
  canvasPos, isFormFocused,
} from './dom-utils.js';

const COL_BG         = '#1a1a1a';
const COL_GRID_BEAT  = '#2a2a2a';
const COL_GRID_BAR   = '#3a3a3a';
const COL_GRID_SUB   = '#222222';
const COL_RULER_BG   = '#111111';
const COL_RULER_TEXT = '#888888';
const COL_PLAYHEAD   = '#ffffff';
const COL_BOOKMARK     = '#e08030';
const COL_BOOKMARK_HOT = '#ffb060';

// Curve-group accents — cycled by group id so side-by-side groups (e.g. a melody
// line and its accompaniment) read as distinct. Hues are spread around the wheel,
// skipping the ~205–250 band so they stay distinct from the velocity-blue notes
// (hue 213). Stored as HSL with a deliberately moderate base lightness so a hover
// can brighten the whole group by bumping lightness (see groupHSL / _hoverGroupId,
// mirroring noteHSL's hovered state) with clearly visible headroom.
const GROUP_COLORS  = [
  { h:  20, s: 80, l: 52 },  // orange
  { h:  50, s: 78, l: 50 },  // gold
  { h:  85, s: 60, l: 47 },  // lime
  { h: 120, s: 56, l: 46 },  // green
  { h: 160, s: 66, l: 44 },  // teal
  { h: 188, s: 74, l: 47 },  // cyan
  { h: 255, s: 60, l: 60 },  // violet
  { h: 285, s: 56, l: 58 },  // purple
  { h: 315, s: 66, l: 55 },  // magenta
  { h: 345, s: 72, l: 56 },  // pink
];

// Accent fill for a group member. `hovered` brightens every member of the group
// under the cursor as a unit (lightness +18, capped), the same brightness idiom
// noteHSL uses for plain notes.
function groupHSL(c, hovered) {
  const l = hovered ? Math.min(82, c.l + 18) : c.l;
  return `hsl(${c.h},${c.s}%,${l}%)`;
}
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
// One rule for every roll label — velocity numbers and curve-group endpoints —
// adapting to the actual rendered fill, so it tracks velocity and the hover /
// group-highlight brightening alike (a near-threshold fill flips on hover, by
// design: the label always follows the most legible choice for the current fill).
function labelColorFor(fill) {
  return relativeLuminance(fill) > 0.179 ? '#000' : '#fff';
}
const NOTE_LABEL_FONT = '9px monospace'; // velocity number + curve endpoint label

// One-character prefix on the start ('from') endpoint label marking the ramp's
// easing shape, so a group's type stays legible on the roll after the tool window
// closes. The glyph evokes the curve: flat ramp, accelerating, decelerating, S.
const SHAPE_GLYPHS = {
  'Linear':   '-',
  'Ease in':  '/',
  'Ease out': '\\',
  'S-curve':  '~',
};

// Velocity-mapped note fill. `displayState`: 'normal' | 'hovered' | 'dimmed'
export function noteHSL(velocity, displayState) {
  const t = velocity / 127;
  const s = 65 + t * 15;   // 65–80% saturation
  let   l = 8  + t * 54;   // 8–62% lightness
  if (displayState === 'dimmed')  l *= 0.55;
  if (displayState === 'hovered') l  = Math.min(78, l + 16);
  return `hsl(213,${Math.round(s)}%,${Math.round(l)}%)`;
}

// Rectangle-selection rubber band (teal = add, red = remove)
const COL_RECT_FILL   = 'rgba(92,200,200,0.1)';
const COL_RECT_STROKE = 'rgba(92,200,200,0.55)';
const COL_RECT_RM_FILL   = 'rgba(220,70,70,0.12)';
const COL_RECT_RM_STROKE = 'rgba(220,70,70,0.6)';

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
    this._hoverGroupId  = -1;       // curve group whose member is under the cursor (-1 = none)
    this._hoverNoteRightEdge = -1;  // index of note whose right edge is under the cursor
    this._lastMousePos  = null;

    // Rectangle selection drag
    this._rectSelActive      = false;
    this._rectSelStart       = null;    // canvas pixels at mousedown, used only for drag threshold
    this._rectSelStartWorld  = null;    // anchor in world coords {tick, worldY} — fixed during auto-pan
    this._rectSelCurrent     = null;
    this._rectDidDrag        = false;
    this._rectHitSet         = null;
    this._rectSelMode        = 'add';   // 'add' (bare) | 'remove' (Ctrl) | 'inert' (Alt/Shift)
    this._didRectSel         = false;   // suppress the click event that follows mouseup

    // Auto-pan during rect selection
    this._autoPanRaf      = null;
    this._autoPanMousePos = null;

    // Pan (right-drag)
    this._panning    = false;
    this._panLastPos = null;

    // Right-edge resize drag
    this._resizingNoteRightIdx = -1;
    // Left-edge resize drag
    this._resizingNoteLeftIdx  = -1;
    // Shared resize state: note refs and original ticks captured at drag start
    this._resizeNoteRefs = [];
    this._resizeOrigins  = [];

    // Note drag (note body)
    this._draggingNotes     = false;
    this._dragNoteRefs      = [];
    this._dragOrigins       = [];
    this._dragStartTick     = 0;
    this._dragStartPitch    = 0;
    this._dragAllowPitch    = false;
    this._dragDidMove       = false;
    this._didNoteDrag       = false;
    this._pendingNoteHandle = -1;
    this._pendingDragStart  = null;
    this._hoverNoteHandle   = -1;
    this._hoverNoteLeftEdge = -1;
    this._hoverBookmarkIdx  = -1;
    this._hoverPitch        = -1;
    this._pendingHandle     = null;  // handle pressed but not yet released (opens menu)
    this._didHandleInteract = false; // suppress the click event after a handle press

    // Indices into state.notes sorted by duration descending: longest drawn first
    // (bottom), shortest drawn last (top), so contained notes are always on top.
    // Rebuilt lazily (see _ensureDrawOrder) only when notes change, not every render.
    this._drawOrder      = [];
    this._drawOrderDirty = true;

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
    this._drawRectSelection();
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
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
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

    ctx.fillStyle = COL_RULER_TEXT; ctx.font = '10px monospace'; ctx.textBaseline = 'middle';
    for (const { tick, bar } of state.barBoundaries(tickStart, tickEnd)) {
      const x = this.tickToX(tick);
      ctx.fillText(bar, x + 3, HEADER_HEIGHT / 2);
      ctx.fillStyle = COL_GRID_BAR; ctx.fillRect(x - 0.5, HEADER_HEIGHT - 6, 1, 6);
      ctx.fillStyle = COL_RULER_TEXT;
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

    this._ensureDrawOrder();

    for (const i of this._drawOrder) {
      const n = state.notes[i];
      if (n.endTick < tickStart || n.startTick > tickEnd) continue;
      this._drawNote(i, n, effective, hasSel);
    }

    this._drawCurveGroups();

    ctx.restore();
  }

  // Rebuilds the duration-sorted draw order, but only when notes have actually
  // changed (flagged dirty on loaded/selectionchanged/groupschanged). render()
  // runs on every hover, pan, and playback frame, so re-sorting all notes here
  // unconditionally would sort the whole piece ~60×/s during playback for nothing.
  _ensureDrawOrder() {
    if (!this._drawOrderDirty) return;
    const notes = state.notes;
    const order = Array.from({ length: notes.length }, (_, i) => i);
    order.sort((a, b) =>
      (notes[b].endTick - notes[b].startTick) - (notes[a].endTick - notes[a].startTick));
    this._drawOrder      = order;
    this._drawOrderDirty = false;
  }

  _groupColor(g, hovered) { return groupHSL(GROUP_COLORS[g.id % GROUP_COLORS.length], hovered); }

  // Endpoint descriptors for one group: a 'from' label in every earliest-onset
  // member's box and a 'to' label in every latest-onset member's box (a chord
  // shares an onset, so each note in it gets its own label).
  _groupHandles(g) {
    const members = state.groupMembers(g);
    if (!members.length) return [];
    let minOn = Infinity, maxOn = -Infinity;
    for (const n of members) {
      if (n.startTick < minOn) minOn = n.startTick;
      if (n.startTick > maxOn) maxOn = n.startTick;
    }
    const handles = [];
    for (const n of members) {
      if (n.startTick === minOn) handles.push(this._mkHandle(g, 'from', n));
      if (n.startTick === maxOn) handles.push(this._mkHandle(g, 'to',   n));
    }
    return handles;
  }

  // Builds one endpoint descriptor. The velocity label is drawn at the note box's
  // top-left, exactly where a normal note's velocity number sits (just dark, for
  // contrast against the group's accent fill). The 'from' label is prefixed with a
  // shape glyph (SHAPE_GLYPHS) so the group's easing type reads off the start box.
  // `x`/`y` mark the label centre, used for hit-testing the group menu.
  _mkHandle(g, end, n) {
    const nx    = this.tickToX(n.startTick);
    const ny    = this.pitchToY(n.pitch);
    const vel   = String(Math.round(end === 'from' ? g.from : g.to));
    const label = end === 'from' ? (SHAPE_GLYPHS[g.shape] ?? '') + vel : vel;
    this.ctx.font = NOTE_LABEL_FONT;
    const lw = this.ctx.measureText(label).width;
    return {
      groupId: g.id, end, note: n, label, lw,
      nx, ny, w: this._noteWidthPx(n),
      x: nx + 3 + lw / 2,                 // label centre (hit)
      y: ny + this.noteHeight / 2,
    };
  }

  _drawCurveGroups() {
    if (!state.curveGroups.length) return;
    for (const g of state.curveGroups) {
      for (const hd of this._groupHandles(g)) this._drawHandle(hd);
    }
  }

  // The group's endpoint label is the same box-label draw as a note's velocity
  // number — its color adapts to the group's accent fill (labelColorFor) for
  // maximum contrast, mirroring the fill's hover brightening so the two stay in sync.
  _drawHandle(hd) {
    const fill = groupHSL(GROUP_COLORS[hd.groupId % GROUP_COLORS.length],
                          hd.groupId === this._hoverGroupId);
    this._drawNoteLabel(hd.nx, hd.ny + 1, hd.w, hd.label, labelColorFor(fill));
  }

  // Draws a clipped, top-left label inside a note box. `y` is the box top
  // (pitchToY + 1). Shared by the per-note velocity number and curve endpoint labels.
  _drawNoteLabel(x, y, w, text, color) {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, w - 2, this.noteHeight - 3);
    ctx.clip();
    ctx.fillStyle    = color;
    ctx.font         = NOTE_LABEL_FONT;
    ctx.textBaseline = 'top';
    ctx.textAlign    = 'left';
    ctx.fillText(text, x + 3, y + 4);
    ctx.restore();
  }

  // Returns the endpoint descriptor under `pos`, or null. The hit box spans the
  // label's width over the full note row height.
  _handleAt(pos) {
    for (const g of state.curveGroups) {
      for (const hd of this._groupHandles(g)) {
        if (Math.abs(pos.x - hd.x) <= hd.lw / 2 + 3
            && Math.abs(pos.y - hd.y) <= this.noteHeight / 2) return hd;
      }
    }
    return null;
  }

  // Returns the curve group whose locked member note is under `pos`, or null.
  // Members are hard-locked, so a click anywhere on the note body — not just on
  // the endpoint labels — opens the group menu (their only interaction).
  _groupNoteAt(pos) {
    const ni = this._noteAtPos(pos);
    return ni < 0 ? null : state.groupOfNote(state.notes[ni]);
  }

  // Returns the visible selection set, accounting for an in-progress rect drag:
  // during a teal (add) drag the rect hits preview as additions to the committed
  // selection; during a red (remove) drag they preview as subtractions. `addingHits`
  // / `removingHits` are the subsets that would change on commit (only one is set).
  _effectiveSelection() {
    const committed = state.selectedNoteIndices;
    const inDrag    = this._rectSelActive && this._rectDidDrag && this._rectHitSet !== null;
    if (!inDrag) return { set: committed, addingHits: null, removingHits: null, inDrag: false };

    if (this._rectSelMode === 'remove') {
      const set = new Set([...committed].filter(i => !this._rectHitSet.has(i)));
      return { set, addingHits: null, removingHits: this._rectHitSet, inDrag: true };
    }
    const set = new Set([...committed, ...this._rectHitSet]);
    return { set, addingHits: this._rectHitSet, removingHits: null, inDrag: true };
  }

  _drawNote(i, n, effective, hasSel) {
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
    const hovered  = !effective.inDrag && i === this._hoverNoteIdx;

    let colorState = 'normal';
    // willRemove dims explicitly (independent of hasSel — removing the whole
    // selection empties the effective set, but departing notes should still dim).
    if (willRemove) colorState = 'dimmed';
    else if (hasSel && !selected && !willAdd && !hovered) colorState = 'dimmed';
    else if (hovered || willAdd) colorState = 'hovered';

    // Curve-group members always read as a unit in the group's accent color,
    // overriding the per-note velocity-blue fill.
    const grp = state.groupOfNote(n);
    // Hovering any member lights up the whole group as a unit (group members
    // otherwise ignore the per-note `hovered` state, which only tints the blue fill).
    const fill = grp
      ? this._groupColor(grp, !effective.inDrag && grp.id === this._hoverGroupId)
      : noteHSL(n.velocity, colorState);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);

    const isSel   = selected && !willAdd;
    const bw      = isSel ? 2 : 1;
    const bOff    = bw / 2;
    ctx.lineWidth   = bw;
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.strokeRect(x + bOff, y + bOff, w - bw, h - bw);

    // Locked curve-group notes hide their per-note number — the accent fill
    // already marks the group, and its endpoint labels (drawn in _drawHandle)
    // carry the from/to values. The absence of a number is the "curve-controlled" cue.
    if (!state.isLocked(n)) {
      this._drawNoteLabel(x, y, w, String(n.velocity), labelColorFor(fill));
    }
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
    this._ensureDrawOrder();  // keep the cache fresh for hit-tests that precede a render
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
    // loaded/selectionchanged/groupschanged are the only events that add, remove,
    // move, or resize notes — i.e. the only ones that can change the duration-sorted
    // draw order. Flag it dirty here so _ensureDrawOrder rebuilds on the next render.
    state.addEventListener('loaded',           () => { this.scrollX = 0; this._cancelRectSel(); this._drawOrderDirty = true; this.render(); });
    state.addEventListener('selectionchanged', () => { this._drawOrderDirty = true; this.render(); });
    state.addEventListener('groupschanged',    () => { this._drawOrderDirty = true; this.render(); });
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
    // Show the insert (cell) cursor when Alt is held over the roll content
    if (e.key === 'Alt' && this._lastMousePos
        && !this._panning && !this._draggingNotes && !this._rectSelActive
        && this._hoverNoteRightEdge < 0 && this._hoverNoteLeftEdge < 0 && this._hoverNoteHandle < 0
        && this._inRoll(this._lastMousePos)) {
      this.canvas.style.cursor = 'cell';
    }
    if (e.key === 'Escape' && state.loaded) {
      if (this._rectSelActive || state.selectedNoteIndices.size > 0) {
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

    // ── Note editing shortcuts (ignore when typing in an input) ────────
    if (!state.loaded) return;
    if (isFormFocused(e.target)) return;

    const sel = state.selectedNoteIndices;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size > 0) {
      e.preventDefault();
      const deletable = [...sel].filter(i => !state.isLocked(state.notes[i]));
      if (deletable.length < sel.size) {
        this._flash('Locked curve-group notes can’t be deleted — dissolve the group first');
      }
      if (deletable.length > 0) state.deleteNotes(deletable);
    }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); this._seekToBookmark(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this._seekToBookmark( 1); }
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
    this._rectSelMode       = 'add';
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
    this._hoverGroupId       = -1;
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
    // 'inert' (Alt/Shift) drags are swallowed for click-suppression only — no band.
    if (!this._rectSelActive || !this._rectDidDrag || this._rectSelMode === 'inert') return;
    const { x1, y1, x2, y2 } = this._selectionRect();
    const { ctx, canvas } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, HEADER_HEIGHT, canvas.width - KEY_WIDTH, canvas.height - HEADER_HEIGHT);
    ctx.clip();
    ctx.fillStyle   = this._rectSelMode === 'remove' ? COL_RECT_RM_FILL   : COL_RECT_FILL;
    ctx.strokeStyle = this._rectSelMode === 'remove' ? COL_RECT_RM_STROKE : COL_RECT_STROKE;
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
    ctx.restore();
  }

  // Returns a Set of note indices whose canvas rects overlap the current selection rect.
  // Locked curve-group members are excluded — the tools can't act on them anyway, so
  // sweeping them in alongside editable notes would only poison the whole selection.
  _notesInRect() {
    const { x1, y1, x2, y2 } = this._selectionRect();
    const hits = new Set();
    for (let i = 0; i < state.notes.length; i++) {
      const n   = state.notes[i];
      if (state.isLocked(n)) continue;
      const nx1 = this.tickToX(n.startTick);
      const nx2 = nx1 + this._noteWidthPx(n);
      const ny1 = this.pitchToY(n.pitch);
      const ny2 = ny1 + this.noteHeight;
      if (nx2 >= x1 && nx1 <= x2 && ny2 >= y1 && ny1 <= y2) hits.add(i);
    }
    return hits;
  }

  // Begin a left/right edge resize drag anchored on `anchorIdx`. If the anchor is
  // selected, all selected notes resize together; the anchor is moved to index 0
  // so the grid snap is applied to it and the others follow by the same delta.
  _beginEdgeResize(anchorIdx, side) {
    const isSelected    = state.selectedNoteIndices.has(anchorIdx);
    // Locked notes never resize, even when carried along by a selected anchor.
    const resizeIndices = (isSelected ? [...state.selectedNoteIndices] : [anchorIdx])
      .filter(i => !state.isLocked(state.notes[i]));
    const ai = resizeIndices.indexOf(anchorIdx);
    if (ai > 0) { resizeIndices.splice(ai, 1); resizeIndices.unshift(anchorIdx); }
    state.resizeNoteStart();
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

  _onMouseDown(e) {
    if (!state.loaded) return;
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

    // Curve-group handle: a press-and-release opens the handle menu (shape,
    // endpoint velocities, dissolve). Endpoint velocities are edited there, not
    // by dragging, so the press only needs to suppress the trailing click.
    // Pressing anywhere on a locked member note opens the same menu — locked
    // notes have no other affordance — but the endpoint labels still take
    // priority so their displayed velocity reads as the click target.
    const handle = this._handleAt(pos);
    if (handle) {
      this._pendingHandle = handle;
      return;
    }
    const grp = this._groupNoteAt(pos);
    if (grp) {
      this._pendingHandle = { groupId: grp.id };
      return;
    }

    if (this._hoverNoteRightEdge >= 0) { this._beginEdgeResize(this._hoverNoteRightEdge, 'right'); return; }
    if (this._hoverNoteLeftEdge  >= 0) { this._beginEdgeResize(this._hoverNoteLeftEdge,  'left');  return; }

    if (this._hoverNoteHandle >= 0) {
      this._pendingNoteHandle = this._hoverNoteHandle;
      this._pendingDragStart  = pos;
      return;
    }

    // Modifier picks the rect mode. Alt and Shift are reserved for other gestures
    // (Alt = insert note on click, Shift = pitch-unlock on note-body drags) and are
    // easy to leave held by accident, so they make the rect 'inert' — it still tracks
    // the drag (to suppress the trailing click) but draws/selects nothing. Ctrl gives
    // the red deselect rect; a bare drag the teal add rect.
    this._rectSelActive     = true;
    this._rectSelStart      = pos;
    this._rectSelStartWorld = { tick: this.xToTick(pos.x), worldY: pos.y - HEADER_HEIGHT + this.scrollY };
    this._rectSelCurrent    = pos;
    this._rectDidDrag       = false;
    this._rectSelMode       = (e.altKey || e.shiftKey) ? 'inert'
                            : (e.ctrlKey || e.metaKey) ? 'remove'
                            : 'add';
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
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this._activateNoteDrag(e, pos);
    }

    // Note drag — update positions live, skip all other tracking
    if (this._draggingNotes) {
      this._updateNoteDrag(pos);
      return;
    }

    // Bookmark hover in ruler
    const inRuler = pos.y >= 0 && pos.y < HEADER_HEIGHT && pos.x > KEY_WIDTH;
    const bkIdx = inRuler ? this._bookmarkNear(pos.x) : -1;
    if (bkIdx !== this._hoverBookmarkIdx) {
      this._hoverBookmarkIdx = bkIdx;
      this.render();
    }

    // Note hover highlight — always tracked
    const inRoll  = this._inRoll(pos);
    const hoverNi = inRoll ? this._noteAtPos(pos) : -1;
    const hoverChanged = hoverNi !== this._hoverNoteIdx;
    this._hoverNoteIdx = hoverNi;
    // Light up every member of the group under the cursor (derived from the hovered
    // note — a group change always implies a note change, so hoverChanged covers render).
    const hoverGrp = hoverNi >= 0 ? state.groupOfNote(state.notes[hoverNi]) : null;
    this._hoverGroupId = hoverGrp ? hoverGrp.id : -1;

    if (this.draggingPlayhead) {
      this._seekTime = state.tickToTime(Math.max(0, this.xToTick(pos.x)));
      state.setPlayheadTime(this._seekTime); // dispatches playheadmoved → render
      return;
    }

    const { edgeNi, leftEdgeNi, handleNi, changed: edgeHoverChanged } = this._trackEdgeHover(pos, inRoll);

    // A curve-group member under the cursor (endpoint label or note body) takes
    // priority over note edit affordances and shows a pointer — clicking it
    // opens the group menu. hoverGrp is exactly _groupNoteAt(pos) (group of the
    // note under the cursor), already resolved above — reuse it, no second hit-test.
    const overHandle = (inRoll && !this._rectSelActive)
      ? (this._handleAt(pos) || hoverGrp) : null;

    if (this._rectSelActive) {
      this._rectSelCurrent = pos;
      if (!this._rectDidDrag) {
        const dx = pos.x - this._rectSelStart.x;
        const dy = pos.y - this._rectSelStart.y;
        if (Math.hypot(dx, dy) > DRAG_THRESHOLD) this._rectDidDrag = true;
      }
      if (this._rectDidDrag && this._rectSelMode !== 'inert') {
        this._autoPanMousePos = pos;
        const { vx, vy } = this._autoPanVelocity(pos);
        if (vx !== 0 || vy !== 0) this._startAutoPan(); else this._stopAutoPan();
        this._rectHitSet = this._notesInRect();
      }
      if (this._rectDidDrag || hoverChanged || hoverPitchChanged) this.render();
      return;
    }

    if (overHandle) this.canvas.style.cursor = 'pointer';
    else this._setHoverCursor(e, inRoll, edgeNi, leftEdgeNi, handleNi);
    if (hoverChanged || edgeHoverChanged || hoverPitchChanged) this.render();
  }

  // Resolves right-edge / left-edge / body hover (all forced to -1 during a rect-select
  // drag) and returns the indices plus whether any of the three changed since last move.
  _trackEdgeHover(pos, inRoll) {
    const active     = inRoll && !this._rectSelActive;
    let   edgeNi     = active ? this._noteRightEdgeAt(pos) : -1;
    let   leftEdgeNi = (active && edgeNi < 0) ? this._noteLeftEdgeAt(pos) : -1;
    let   handleNi   = (active && edgeNi < 0 && leftEdgeNi < 0) ? this._noteBodyAt(pos) : -1;
    // Curve-group notes are locked: immovable and unresizable. Drop any edit
    // affordance on them so the cursor never offers a resize/move grab. (They
    // stay clickable/selectable via the separate click + rect-select paths.)
    if (edgeNi     >= 0 && state.isLocked(state.notes[edgeNi]))     edgeNi     = -1;
    if (leftEdgeNi >= 0 && state.isLocked(state.notes[leftEdgeNi])) leftEdgeNi = -1;
    if (handleNi   >= 0 && state.isLocked(state.notes[handleNi]))   handleNi   = -1;
    const changed    = edgeNi     !== this._hoverNoteRightEdge
                    || leftEdgeNi !== this._hoverNoteLeftEdge
                    || handleNi   !== this._hoverNoteHandle;
    this._hoverNoteRightEdge = edgeNi;
    this._hoverNoteLeftEdge  = leftEdgeNi;
    this._hoverNoteHandle    = handleNi;
    return { edgeNi, leftEdgeNi, handleNi, changed };
  }

  _setHoverCursor(e, inRoll, edgeNi, leftEdgeNi, handleNi) {
    if (edgeNi >= 0 || leftEdgeNi >= 0) {
      this.canvas.style.cursor = 'ew-resize';
    } else if (handleNi >= 0) {
      this.canvas.style.cursor = 'grab';
    } else if (e.altKey && inRoll) {
      this.canvas.style.cursor = 'cell';
    } else {
      this.canvas.style.cursor = '';
    }
  }

  _activateNoteDrag(e, pos) {
    const ni = this._pendingNoteHandle;
    this._pendingNoteHandle = -1;
    this._pendingDragStart  = null;

    // Locked curve-group notes stay put even when dragged as part of a mixed
    // selection — only the unlocked notes move. (ni itself is never locked: the
    // hover handle is suppressed on locked notes.)
    const dragIndices = (state.selectedNoteIndices.has(ni)
      ? [...state.selectedNoteIndices]
      : [ni]).filter(i => !state.isLocked(state.notes[i]));

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
    this._dragAllowPitch = e.shiftKey;
    this._dragDidMove    = false;
    this._draggingNotes  = true;
    this.canvas.style.cursor = 'grabbing';
  }

  _updateNoteDrag(pos) {
    const rawDeltaTick  = this.xToTick(pos.x) - this._dragStartTick;
    const anchorSnapped = state.snapTick(this._dragOrigins[0].startTick + rawDeltaTick);
    const snappedDelta  = anchorSnapped - this._dragOrigins[0].startTick;

    const deltaPitch = this._dragAllowPitch
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
      this._refreshCursor();
      return;
    }

    if (this._pendingHandle) {
      const h = this._pendingHandle;
      this._pendingHandle     = null;
      this._didHandleInteract = true; // suppress the trailing click
      // A handle press opens its menu (shape selector, endpoint velocities, dissolve).
      document.dispatchEvent(new CustomEvent('curve-handle-menu', { detail: { groupId: h.groupId } }));
      this._refreshCursor();
      return;
    }

    if (this._pendingNoteHandle >= 0) {
      this._pendingNoteHandle = -1;
      this._pendingDragStart  = null;
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
    const hits    = (didDrag && mode !== 'inert') ? this._notesInRect() : new Set();
    this._cancelRectSel();

    if (didDrag) {
      this._didRectSel = true; // suppress the click event (incl. the inert case)
      if (mode === 'remove') {
        state.setSelection([...state.selectedNoteIndices].filter(i => !hits.has(i)));
        this.render();
      } else if (mode === 'add') {
        state.setSelection([...new Set([...state.selectedNoteIndices, ...hits])]);
        this.render();
      }
      // 'inert' (Alt/Shift): drag swallowed, selection untouched, click suppressed
    }
    // Click without drag: _onClick fires separately and handles it
  }

  _onClick(e) {
    if (!state.loaded) return;
    if (this._didRectSel)  { this._didRectSel  = false; return; }
    if (this._didNoteDrag) { this._didNoteDrag = false; return; }
    if (this._didHandleInteract) { this._didHandleInteract = false; return; }

    const pos = this._canvasPos(e);
    if (pos.x < KEY_WIDTH || pos.y < HEADER_HEIGHT) return;

    if (e.altKey) {
      const tick  = state.snapTick(Math.max(0, Math.round(this.xToTick(pos.x))));
      const pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, this.yToPitch(pos.y)));
      state.addNote(pitch, tick, tick + state.ticksPerBeat, 64);
      return;
    }

    const ni = this._noteAtPos(pos);
    if (ni !== -1) {
      e.stopPropagation();
      // Ctrl+click removes that note from the selection; a plain click adds it.
      if (e.ctrlKey || e.metaKey) {
        if (state.selectedNoteIndices.has(ni)) {
          state.setSelection([...state.selectedNoteIndices].filter(i => i !== ni));
        }
      } else if (!state.selectedNoteIndices.has(ni)) {
        state.setSelection([...state.selectedNoteIndices, ni]);
      }
      return;
    }

    // Ctrl+click on empty is a no-op: Ctrl means "remove from selection", so it
    // must not clear everything (which would undo the deselection work in progress).
    if (e.ctrlKey || e.metaKey) return;

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
      const mouseTick    = this.xToTick(pos.x);
      this.pixelsPerTick = Math.max(0.01, Math.min(8, this.pixelsPerTick * factor));
      this.scrollX       = this._clampScrollX(mouseTick - (pos.x - KEY_WIDTH) / this.pixelsPerTick);
    } else {
      this.scrollX = this._clampScrollX(this.scrollX + e.deltaY / this.pixelsPerTick * 0.5);
    }
    this.render();
  }
}

