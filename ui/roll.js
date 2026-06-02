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

// Velocity-mapped note fill. `displayState`: 'normal' | 'hovered' | 'dimmed'
export function noteHSL(velocity, displayState) {
  const t = velocity / 127;
  const s = 65 + t * 15;   // 65–80% saturation
  let   l = 8  + t * 54;   // 8–62% lightness
  if (displayState === 'dimmed')  l *= 0.55;
  if (displayState === 'hovered') l  = Math.min(78, l + 16);
  return `hsl(213,${Math.round(s)}%,${Math.round(l)}%)`;
}

// Rectangle-selection rubber band
const COL_RECT_FILL   = 'rgba(92,200,200,0.1)';
const COL_RECT_STROKE = 'rgba(92,200,200,0.55)';

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
    this._rectExtend         = false;   // Shift held at drag start → add to selection
    this._rectSelStart       = null;    // canvas pixels at mousedown, used only for drag threshold
    this._rectSelStartWorld  = null;    // anchor in world coords {tick, worldY} — fixed during auto-pan
    this._rectSelCurrent     = null;
    this._rectDidDrag        = false;
    this._rectHitSet         = null;
    this._didRectSel         = false;   // suppress the click event that follows mouseup

    // Auto-pan during rect selection
    this._autoPanRaf      = null;
    this._autoPanMousePos = null;

    // Pan (Ctrl+drag)
    this._panning    = false;
    this._panLastPos = null;
    this._didPan     = false;       // suppress the click event after a pan

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

    for (let i = 0; i < state.notes.length; i++) {
      const n = state.notes[i];
      if (n.endTick < tickStart || n.startTick > tickEnd) continue;
      this._drawNote(i, n, effective, hasSel);
    }

    ctx.restore();
  }

  // Returns the visible selection set, accounting for an in-progress rect drag:
  // during a drag the rect hits are previewed (added to or replacing the committed
  // selection). `addingHits` is the subset that would be newly added on commit.
  _effectiveSelection() {
    const committed = state.selectedNoteIndices;
    const inDrag    = this._rectSelActive && this._rectDidDrag && this._rectHitSet !== null;
    if (!inDrag) return { set: committed, addingHits: null, inDrag: false };

    const set = this._rectExtend
      ? new Set([...committed, ...this._rectHitSet])
      : this._rectHitSet;
    return { set, addingHits: this._rectHitSet, inDrag: true };
  }

  _drawNote(i, n, effective, hasSel) {
    const { ctx } = this;
    const x = this.tickToX(n.startTick);
    const w = this._noteWidthPx(n);
    const y = this.pitchToY(n.pitch) + 1;
    const h = this.noteHeight - 1;

    const selected = effective.set.has(i);
    // willAdd: entering selection via current rect drag (not already committed)
    const willAdd  = effective.inDrag && effective.addingHits.has(i)
                     && !state.selectedNoteIndices.has(i);
    const hovered  = !effective.inDrag && i === this._hoverNoteIdx;

    let colorState = 'normal';
    if (hasSel && !selected && !willAdd && !hovered) colorState = 'dimmed';
    else if (hovered || willAdd) colorState = 'hovered';

    ctx.fillStyle = noteHSL(n.velocity, colorState);
    ctx.fillRect(x, y, w, h);

    const isSel   = selected && !willAdd;
    const bw      = isSel ? 2 : 1;
    const bOff    = bw / 2;
    ctx.lineWidth   = bw;
    ctx.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.5)';
    ctx.strokeRect(x + bOff, y + bOff, w - bw, h - bw);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 1, y + 1, w - 2, h - 2);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(String(n.velocity), x + 3, y + 4);
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

  // Returns the index of the note at canvas position pos, or -1.
  _noteAtPos(pos) {
    const tick = this.xToTick(pos.x);
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n  = state.notes[i];
      const ny = this.pitchToY(n.pitch);
      if (n.startTick <= tick && n.endTick > tick
          && pos.y >= ny && pos.y < ny + this.noteHeight) return i;
    }
    return -1;
  }

  // Returns the index of the note whose right edge is within EDGE_THRESHOLD px of pos, or -1.
  _noteRightEdgeAt(pos) {
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n  = state.notes[i];
      const nx = this.tickToX(n.startTick);
      const w  = this._noteWidthPx(n);
      const ny = this.pitchToY(n.pitch);
      if (pos.y < ny || pos.y >= ny + this.noteHeight) continue;
      if (Math.abs(pos.x - (nx + w)) <= EDGE_THRESHOLD) return i;
    }
    return -1;
  }

  // Returns the index of the note whose left edge zone contains pos, or -1.
  _noteLeftEdgeAt(pos) {
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n  = state.notes[i];
      const nx = this.tickToX(n.startTick);
      const ny = this.pitchToY(n.pitch);
      if (pos.y < ny || pos.y >= ny + this.noteHeight) continue;
      const w = this._noteWidthPx(n);
      if (pos.x >= nx && pos.x < nx + Math.min(HANDLE_WIDTH, w)) return i;
    }
    return -1;
  }

  // Returns the index of the note whose body (excluding both edge zones) contains pos, or -1.
  _noteBodyAt(pos) {
    for (let i = state.notes.length - 1; i >= 0; i--) {
      const n  = state.notes[i];
      const nx = this.tickToX(n.startTick);
      const ny = this.pitchToY(n.pitch);
      if (pos.y < ny || pos.y >= ny + this.noteHeight) continue;
      const w = this._noteWidthPx(n);
      if (pos.x < nx || pos.x >= nx + w) continue;
      if (pos.x < nx + Math.min(HANDLE_WIDTH, w)) continue;
      if (Math.abs(pos.x - (nx + w)) <= EDGE_THRESHOLD) continue;
      return i;
    }
    return -1;
  }

  // Returns the index of the nearest bookmark within 8 px of canvas x, or -1.
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
    state.addEventListener('loaded',           () => { this.scrollX = 0; this._cancelRectSel(); this.render(); });
    state.addEventListener('selectionchanged', () => this.render());
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
      if ((e.key === 'Control' || e.key === 'Alt') && !this._panning) this._refreshCursor();
    });
    // move/up on window so dragging off-canvas still registers (critical for ruler seek)
    window.addEventListener('mousemove', e => this._onMouseMove(e));
    window.addEventListener('mouseup',   e => this._onMouseUp(e));

    window.addEventListener('keydown', e => this._onKeyDown(e));
  }

  _onKeyDown(e) {
    // Show grab/cell cursor when Ctrl/Alt is held over the roll content
    if ((e.key === 'Control' || e.key === 'Alt') && this._lastMousePos
        && !this._panning && !this._draggingNotes && !this._rectSelActive
        && this._hoverNoteRightEdge < 0 && this._hoverNoteLeftEdge < 0 && this._hoverNoteHandle < 0
        && this._inRoll(this._lastMousePos)) {
      this.canvas.style.cursor = e.key === 'Alt' ? 'cell' : 'grab';
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
      state.deleteNotes([...sel]);
    }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); this._seekToBookmark(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); this._seekToBookmark( 1); }
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
    this._rectExtend        = false;
    this._rectSelStart      = null;
    this._rectSelStartWorld = null;
    this._rectSelCurrent    = null;
    this._rectDidDrag       = false;
    this._rectHitSet        = null;
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

  // Returns a Set of note indices whose canvas rects overlap the current selection rect.
  _notesInRect() {
    const { x1, y1, x2, y2 } = this._selectionRect();
    const hits = new Set();
    for (let i = 0; i < state.notes.length; i++) {
      const n   = state.notes[i];
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
    const resizeIndices = isSelected ? [...state.selectedNoteIndices] : [anchorIdx];
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

    if (e.ctrlKey) {
      this._panning    = true;
      this._panLastPos = pos;
      this._didPan     = false;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (this._hoverNoteRightEdge >= 0) { this._beginEdgeResize(this._hoverNoteRightEdge, 'right'); return; }
    if (this._hoverNoteLeftEdge  >= 0) { this._beginEdgeResize(this._hoverNoteLeftEdge,  'left');  return; }

    if (this._hoverNoteHandle >= 0) {
      this._pendingNoteHandle = this._hoverNoteHandle;
      this._pendingDragStart  = pos;
      return;
    }

    this._rectSelActive     = true;
    this._rectExtend        = e.shiftKey;
    this._rectSelStart      = pos;
    this._rectSelStartWorld = { tick: this.xToTick(pos.x), worldY: pos.y - HEADER_HEIGHT + this.scrollY };
    this._rectSelCurrent    = pos;
    this._rectDidDrag       = false;
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
        this._didPan = true;
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

    if (this.draggingPlayhead) {
      this._seekTime = state.tickToTime(Math.max(0, this.xToTick(pos.x)));
      state.setPlayheadTime(this._seekTime); // dispatches playheadmoved → render
      return;
    }

    // Right-edge hover — only outside rect selection
    const edgeNi = (inRoll && !this._rectSelActive) ? this._noteRightEdgeAt(pos) : -1;
    const edgeChanged = edgeNi !== this._hoverNoteRightEdge;
    this._hoverNoteRightEdge = edgeNi;

    // Left-edge hover — only when not near a right edge
    const leftEdgeNi = (inRoll && !this._rectSelActive && edgeNi < 0) ? this._noteLeftEdgeAt(pos) : -1;
    const leftEdgeChanged = leftEdgeNi !== this._hoverNoteLeftEdge;
    this._hoverNoteLeftEdge = leftEdgeNi;

    // Body hover — only when not on either edge
    const handleNi = (inRoll && !this._rectSelActive && edgeNi < 0 && leftEdgeNi < 0) ? this._noteBodyAt(pos) : -1;
    const handleChanged = handleNi !== this._hoverNoteHandle;
    this._hoverNoteHandle = handleNi;

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

    if (edgeNi >= 0 || leftEdgeNi >= 0) {
      this.canvas.style.cursor = 'ew-resize';
    } else if (handleNi >= 0) {
      this.canvas.style.cursor = 'grab';
    } else if (e.altKey && inRoll) {
      this.canvas.style.cursor = 'cell';
    } else if (e.ctrlKey && inRoll) {
      this.canvas.style.cursor = 'grab';
    } else {
      this.canvas.style.cursor = '';
    }
    if (hoverChanged || edgeChanged || leftEdgeChanged || handleChanged || hoverPitchChanged) this.render();
  }

  _activateNoteDrag(e, pos) {
    const ni = this._pendingNoteHandle;
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
      this.canvas.style.cursor = (e.ctrlKey && this._inRoll(this._canvasPos(e))) ? 'grab' : '';
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

    const didDrag    = this._rectDidDrag;
    const rectExtend = this._rectExtend;
    const hits       = didDrag ? [...this._notesInRect()] : [];
    this._cancelRectSel();

    if (didDrag) {
      this._didRectSel = true; // suppress the click event
      if (rectExtend) {
        state.setSelection([...new Set([...state.selectedNoteIndices, ...hits])]);
      } else {
        state.setSelection(hits);
      }
      this.render();
    }
    // Click without drag: _onClick fires separately and handles it
  }

  _onClick(e) {
    if (!state.loaded) return;
    if (this._didRectSel)  { this._didRectSel  = false; return; }
    if (this._didPan)      { this._didPan      = false; return; }
    if (this._didNoteDrag) { this._didNoteDrag = false; return; }

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
      if (e.shiftKey) {
        const newSel = new Set(state.selectedNoteIndices);
        if (newSel.has(ni)) newSel.delete(ni); else newSel.add(ni);
        state.setSelection([...newSel]);
      } else {
        // Select only this note; if already the sole selection, clear it
        const alone = state.selectedNoteIndices.has(ni) && state.selectedNoteIndices.size === 1;
        state.setSelection(alone ? [] : [ni]);
      }
      return;
    }

    if (state.selectedNoteIndices.size > 0) state.setSelection([]);
    if (e.shiftKey) return;
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

