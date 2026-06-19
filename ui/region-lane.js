// ui/region-lane.js
// The soft-pedal (una corda) lane. Unlike the curve lanes, the value it edits is
// *binary* held state — CC67 on or off — so it draws and edits time *regions*
// ([{startTick, endTick}] spans), not value control points. It is therefore a
// note-like editor rather than a CurveLane: a thin strip of filled bars.
//
// Controls:
//   Left-drag empty  — paint a region (onset snapped at press, end snapped to grid).
//                      A sub-grid drag or a bare click falls back to a one-snap-step
//                      region, so a single click drops a default-width bar.
//   Drag region edge — resize start / end (snapped; live, merged on release).
//                      The hovered region draws left/right grip bars, like a note.
//   Drag region body — move the whole region (snapped; live, merged on release)
//   Right-click      — delete the region under the cursor
//   Ctrl             — held during paint/resize/move, disables grid snapping
//   Scroll / Ctrl+scroll — horizontal pan / zoom (forwarded to the roll)
//
// Overlapping or touching regions merge on commit (state.normalizeRegions), so the
// set stays disjoint and playback emits one clean CC67 on/off pair per region.

import { state, snapGridTicks } from '../engine/state.js';
import { KEY_WIDTH, canvasPos, forwardWheelToRoll } from './dom-utils.js';

const PAD_V          = 5;   // vertical inset of the region bars within the strip
const EDGE_PX        = 5;   // edge-grab zone width for resizing (px)
const DRAG_THRESHOLD = 4;   // px of motion before a press becomes a resize/move drag

const COL_KEY_BG    = '#111';
const COL_LANE_BG   = '#161616';
const COL_GRID_SUB  = '#212121';
const COL_GRID_BEAT = '#343434';
const COL_GRID_BAR  = '#525252';

// Una corda violet — distinct from the pedal lane's teal and the tempo lane's
// amber, and clear of the red↔green axis. The hot shade brightens on hover.
const COL_REGION     = '#9a7cd0';
const COL_REGION_HOT = '#c0a8ee';

export class RegionLane {
  constructor(canvas, roll) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.roll   = roll;

    this._hoverIdx = -1;

    // Paint (left-drag on empty space) — a new region being drawn.
    this._paintActive = false;
    this._paintAnchor = 0;   // snapped onset, fixed at press
    this._paintStart  = 0;
    this._paintEnd    = 0;

    // Resize / move drag of an existing region.
    this._dragRegion    = null;
    this._dragEdge      = null;   // 'start' | 'end' | 'body'
    this._dragStartPos  = null;
    this._dragStarted   = false;
    this._dragOrigStart = 0;      // region.startTick at press (move delta origin)
    this._dragGrabTick  = 0;      // cursor tick at press (move delta origin)

    this._bindEvents();
    state.addEventListener('softpedalchanged', () => this.render());
  }

  // ── Drawing ──────────────────────────────────────────────────────────

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawBackground();
    if (state.tempoMap.length) this._drawGrid();
    this._drawRegions();
    this._drawPlayhead();
    this._drawLabel();
  }

  _drawBackground() {
    const { ctx, canvas } = this;
    ctx.fillStyle = COL_KEY_BG;
    ctx.fillRect(0, 0, KEY_WIDTH, canvas.height);
    ctx.fillStyle = COL_LANE_BG;
    ctx.fillRect(KEY_WIDTH, 0, canvas.width - KEY_WIDTH, canvas.height);
  }

  _drawGrid() {
    const { ctx, canvas } = this;
    const tpb       = state.ticksPerBeat;
    const tickStart = this.roll.scrollX;
    const tickEnd   = tickStart + (canvas.width - KEY_WIDTH) / this.roll.pixelsPerTick;

    const drawLine = x => {
      if (x <= KEY_WIDTH) return;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    };

    ctx.strokeStyle = COL_GRID_SUB; ctx.lineWidth = 0.5;
    const subTicks = snapGridTicks(state.snapGrid, tpb);
    for (let t = Math.floor(tickStart / subTicks) * subTicks; t <= tickEnd; t += subTicks) {
      drawLine(this.roll.tickToX(t));
    }

    ctx.strokeStyle = COL_GRID_BEAT; ctx.lineWidth = 1;
    for (let t = Math.floor(tickStart / tpb) * tpb; t <= tickEnd; t += tpb) {
      drawLine(this.roll.tickToX(t));
    }

    ctx.strokeStyle = COL_GRID_BAR; ctx.lineWidth = 1.5;
    for (const { tick } of state.barBoundaries(tickStart, tickEnd)) {
      drawLine(this.roll.tickToX(tick));
    }
  }

  _drawRegions() {
    const { ctx, canvas } = this;
    const top = PAD_V, h = canvas.height - 2 * PAD_V;

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, 0, canvas.width - KEY_WIDTH, canvas.height);
    ctx.clip();

    const regions = state.softPedalRegions;
    for (let i = 0; i < regions.length; i++) {
      const rx1 = this.roll.tickToX(regions[i].startTick);
      const rx2 = this.roll.tickToX(regions[i].endTick);
      if (rx2 < KEY_WIDTH || rx1 > canvas.width) continue;
      const x = Math.max(KEY_WIDTH, rx1);
      const w = Math.max(1, rx2 - x);
      ctx.fillStyle = i === this._hoverIdx ? COL_REGION_HOT : COL_REGION;
      ctx.fillRect(x, top, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);

      // Left/right grip bars on the hovered region, like a note's resize handles.
      // Width matches the edge hit zone (_hitTest's `ew`), so the affordance shows
      // exactly where a resize grab lands. Drawn from the true edges (rx1/rx2) and
      // clipped, so a grip behind the key strip simply isn't seen.
      if (i === this._hoverIdx) {
        const gw = Math.min(EDGE_PX, (rx2 - rx1) / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(rx1, top, gw, h);
        ctx.fillRect(rx2 - gw, top, gw, h);
      }
    }

    // Ghost of the region being painted — dashed white outline over a translucent fill.
    if (this._paintActive) {
      const { startTick, endTick } = this._paintSpan();
      const x = this.roll.tickToX(startTick);
      const w = Math.max(1, (endTick - startTick) * this.roll.pixelsPerTick);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle   = COL_REGION;
      ctx.fillRect(x, top, w, h);
      ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth   = 1.5;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x + 0.75, top + 0.75, w - 1.5, h - 1.5);
    }

    ctx.restore();
  }

  _drawLabel() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText('U.C.', KEY_WIDTH / 2, canvas.height / 2);
  }

  _drawPlayhead() {
    if (!state.loaded) return;
    const x = this.roll.tickToX(state.timeToTick(state.playheadTime));
    if (x <= KEY_WIDTH) return;
    const { ctx, canvas } = this;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }

  // ── Geometry / hit testing ───────────────────────────────────────────

  _canvasPos(e) { return canvasPos(this.canvas, e); }

  // The region (and which part of it) under a canvas position. Edge zones cap at
  // half the bar width so a thin region still exposes both edges, and the start/end
  // grab zones extend EDGE_PX *outside* the bar so an edge just past it is grabbable.
  _hitTest(pos) {
    const regions = state.softPedalRegions;
    for (let i = 0; i < regions.length; i++) {
      const x1 = this.roll.tickToX(regions[i].startTick);
      const x2 = this.roll.tickToX(regions[i].endTick);
      if (pos.x < x1 - EDGE_PX || pos.x > x2 + EDGE_PX) continue;
      const ew = Math.min(EDGE_PX, (x2 - x1) / 2);
      if (pos.x <= x1 + ew) return { index: i, edge: 'start' };
      if (pos.x >= x2 - ew) return { index: i, edge: 'end' };
      return { index: i, edge: 'body' };
    }
    return { index: -1, edge: null };
  }

  // The region a paint commit would create: the dragged span once it covers at
  // least one snap step, else a default one-snap-step region (the current grid)
  // anchored at the press — so a bare click drops a default-width bar. Mirrors the
  // roll's note-insert span fallback.
  _paintSpan() {
    const lo = Math.min(this._paintStart, this._paintEnd);
    const hi = Math.max(this._paintStart, this._paintEnd);
    if (hi > lo) return { startTick: lo, endTick: hi };
    const grid = snapGridTicks(state.snapGrid, state.ticksPerBeat);
    return { startTick: this._paintAnchor, endTick: this._paintAnchor + grid };
  }

  _snapX(x, e) {
    const raw = Math.max(0, Math.round(this.roll.xToTick(x)));
    return e.ctrlKey ? raw : state.snapTick(raw);
  }

  // ── Events ───────────────────────────────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener('mousedown',   e => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove',   e => this._onMouseMove(e));
    this.canvas.addEventListener('mouseleave',  () => this._onMouseLeave());
    this.canvas.addEventListener('contextmenu', e => this._onContextMenu(e));
    this.canvas.addEventListener('wheel',       e => forwardWheelToRoll(this.roll, this.canvas, e), { passive: false });
    window.addEventListener('mousemove', e => this._onWindowMouseMove(e));
    window.addEventListener('mouseup',   () => this._onWindowMouseUp());
  }

  _onMouseDown(e) {
    if (e.button !== 0 || !state.loaded) return;
    const pos = this._canvasPos(e);
    if (pos.x <= KEY_WIDTH) return;

    const { index, edge } = this._hitTest(pos);
    if (index >= 0) {
      // A press on a region begins a resize (edge) or move (body). Undo is pushed
      // lazily once the drag actually crosses the threshold, so a bare click on a
      // region is a no-op rather than a redundant undo entry.
      this._dragRegion    = state.softPedalRegions[index];
      this._dragEdge      = edge;
      this._dragStartPos  = pos;
      this._dragStarted   = false;
      this._dragOrigStart = this._dragRegion.startTick;
      this._dragGrabTick  = this.roll.xToTick(pos.x);
      if (edge === 'body') this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Empty space: start painting a new region.
    this._paintActive = true;
    this._paintAnchor = this._snapX(pos.x, e);
    this._paintStart  = this._paintAnchor;
    this._paintEnd    = this._paintAnchor;
    this.render();
  }

  _onWindowMouseMove(e) {
    if (this._paintActive) {
      const end = this._snapX(this._canvasPos(e).x, e);
      if (end !== this._paintEnd) { this._paintEnd = end; this.render(); }
      return;
    }
    if (!this._dragRegion) return;

    const pos = this._canvasPos(e);
    if (!this._dragStarted) {
      if (Math.hypot(pos.x - this._dragStartPos.x, pos.y - this._dragStartPos.y) < DRAG_THRESHOLD) return;
      this._dragStarted = true;
      state.beginSoftPedalEdit();
    }

    if (this._dragEdge === 'body') {
      const rawDelta = this.roll.xToTick(pos.x) - this._dragGrabTick;
      const newStartRaw = Math.max(0, Math.round(this._dragOrigStart + rawDelta));
      const newStart = e.ctrlKey ? newStartRaw : state.snapTick(newStartRaw);
      state.moveSoftPedalRegion(this._dragRegion, newStart);
    } else {
      state.resizeSoftPedalRegion(this._dragRegion, this._dragEdge, this._snapX(pos.x, e));
    }
  }

  _onWindowMouseUp() {
    if (this._paintActive) {
      this._paintActive = false;
      const { startTick, endTick } = this._paintSpan();
      state.addSoftPedalRegion(startTick, endTick);
      return;
    }
    if (this._dragRegion) {
      if (this._dragStarted) state.endSoftPedalEdit();
      this._dragRegion  = null;
      this._dragStarted = false;
      if (this._dragEdge === 'body') this.canvas.style.cursor = 'grab';
    }
  }

  _onMouseMove(e) {
    if (this._dragRegion || this._paintActive) return;
    const pos = this._canvasPos(e);
    const { index, edge } = pos.x > KEY_WIDTH ? this._hitTest(pos) : { index: -1, edge: null };
    this.canvas.style.cursor = edge === 'start' || edge === 'end' ? 'ew-resize'
                             : edge === 'body' ? 'grab' : '';
    if (index !== this._hoverIdx) { this._hoverIdx = index; this.render(); }
  }

  _onMouseLeave() {
    if (this._dragRegion || this._paintActive) return;
    if (this._hoverIdx !== -1) { this._hoverIdx = -1; this.render(); }
  }

  _onContextMenu(e) {
    e.preventDefault();
    if (!state.loaded || !state.softPedalRegions.length) return;
    const { index } = this._hitTest(this._canvasPos(e));
    if (index >= 0) state.removeSoftPedalRegionAt(index);
  }
}
