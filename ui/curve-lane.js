// ui/curve-lane.js
// Base class for the tempo and pedal curve editors.
// Each lane edits a piecewise-linear curve of {tick, value} control points.
//
// Config shape:
//   label           string   — 'PED' | 'TEMPO'
//   stateEvent      string   — state event that signals curve data changed
//   getPoints       ()=>[]   — returns [{tick, value}] sorted by tick
//   valueMin        number   — bottom of the value range
//   valueMax        number   — top of the value range
//   emptyValue      number   — value drawn when no control points exist;
//                              also the baseline that Y-snap latches onto
//   color           string   — curve stroke and normal point fill
//   colorHot        string   — hovered/dragged point fill
//   reticleColor    string   — dashed reticle in the roll
//   reticleHotColor string   — reticle when hovering/dragging a control point
//   addPoint        (tick, value)=>void
//   removePoint     (index)=>void
//   movePoint       (point, tick, value)=>void
//   drawAnnotations (ctx, canvas, lane)=>void   — optional, called after _drawCurve

import { state, snapGridTicks } from '../engine/state.js';
import { KEY_WIDTH, canvasPos } from './dom-utils.js';

const PAD_V           = 6;
const HIT_RADIUS      = 12;
const DRAG_THRESHOLD  = 4;
const Y_SNAP_RADIUS   = 11;

const COL_GRID_SUB  = '#222';
const COL_GRID_BEAT = '#2a2a2a';
const COL_GRID_BAR  = '#3a3a3a';

// Reference lines drawn across the value range and used as Y-snap targets.
const REF_FRACS = [0.25, 0.5, 0.75];

export class CurveLane {
  constructor(canvas, roll, config) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.roll   = roll;
    this.config = config;

    this._isHovered     = false;
    this._hoverTick     = null;
    this._hoverPointIdx = -1;

    this._dragPoint    = null;
    this._dragStartPos = null;
    this._dragStarted  = false;
    this._didDrag      = false;

    this._bindEvents();
    state.addEventListener(config.stateEvent, () => this.render());
  }

  get _points() { return this.config.getPoints(); }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this._drawBackground();
    if (state.tempoMap.length) this._drawGrid();
    this._drawCurve();
    if (this.config.drawAnnotations) this.config.drawAnnotations(ctx, canvas, this);
    this._drawPlayhead();
    this._drawLabel();
  }

  // ── Drawing ──────────────────────────────────────────────────────────

  _drawBackground() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, KEY_WIDTH, canvas.height);
    ctx.fillStyle = '#161616';
    ctx.fillRect(KEY_WIDTH, 0, canvas.width - KEY_WIDTH, canvas.height);
    // Reference lines at 25%, 50%, 75% of the value range
    const { valueMin, valueMax } = this.config;
    ctx.lineWidth = 1;
    for (const frac of REF_FRACS) {
      ctx.strokeStyle = frac === 0.5 ? '#2d2d2d' : '#222222';
      const y = this._valueToY(valueMin + frac * (valueMax - valueMin));
      ctx.beginPath();
      ctx.moveTo(KEY_WIDTH, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }

  _drawLabel() {
    const { ctx, canvas } = this;
    ctx.fillStyle = '#555';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(this.config.label, KEY_WIDTH / 2, canvas.height / 2);
  }

  _drawGrid() {
    const { ctx, canvas } = this;
    const tpb      = state.ticksPerBeat;
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

  _drawCurve() {
    const { ctx, canvas } = this;
    const { color, colorHot, emptyValue } = this.config;
    const pts = this._points;
    const hotIdx = this._dragPoint
      ? pts.indexOf(this._dragPoint)
      : this._hoverPointIdx;

    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_WIDTH, 0, canvas.width - KEY_WIDTH, canvas.height);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    if (pts.length === 0) {
      const y = this._valueToY(emptyValue);
      ctx.moveTo(KEY_WIDTH, y);
      ctx.lineTo(canvas.width, y);
    } else if (this.config.makeSampler && pts.length >= 2) {
      this._traceSmoothCurve(this.config.makeSampler(pts), pts);
    } else {
      ctx.moveTo(KEY_WIDTH, this._valueToY(pts[0].value));
      ctx.lineTo(this.roll.tickToX(pts[0].tick), this._valueToY(pts[0].value));
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(this.roll.tickToX(pts[i].tick), this._valueToY(pts[i].value));
      }
      ctx.lineTo(canvas.width, this._valueToY(pts[pts.length - 1].value));
    }
    ctx.stroke();

    for (let i = 0; i < pts.length; i++) {
      const px = this.roll.tickToX(pts[i].tick);
      if (px < KEY_WIDTH || px > canvas.width) continue;
      const py = this._valueToY(pts[i].value);
      if (i === hotIdx) {
        ctx.fillStyle = colorHot;
        ctx.fillRect(px - 4, py - 4, 8, 8);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(px - 3, py - 3, 6, 6);
      }
    }

    ctx.restore();
  }

  // Trace a smooth curve by sampling `sample(tick)` every few pixels across the
  // visible span between the first and last control points. The flat leading and
  // trailing segments mirror the straight-line branch: outside the point range
  // the curve holds the nearest endpoint value. Issues only moveTo/lineTo into
  // the path the caller has already begun (and will stroke).
  _traceSmoothCurve(sample, pts) {
    const { ctx, canvas } = this;
    const SAMPLE_STEP = 2; // px between samples
    const firstX = this.roll.tickToX(pts[0].tick);
    const lastX  = this.roll.tickToX(pts[pts.length - 1].tick);
    const y0 = this._valueToY(pts[0].value);
    const yN = this._valueToY(pts[pts.length - 1].value);

    ctx.moveTo(KEY_WIDTH, y0);
    ctx.lineTo(firstX, y0);
    const sx = Math.max(KEY_WIDTH, Math.ceil(firstX));
    const ex = Math.min(canvas.width, Math.floor(lastX));
    for (let x = sx; x <= ex; x += SAMPLE_STEP) {
      ctx.lineTo(x, this._valueToY(sample(this.roll.xToTick(x))));
    }
    ctx.lineTo(lastX, yN);
    ctx.lineTo(canvas.width, yN);
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

  // ── Coordinate mapping ───────────────────────────────────────────────

  _valueToY(value) {
    const { valueMin, valueMax } = this.config;
    const norm = (value - valueMin) / (valueMax - valueMin);
    return PAD_V + (1 - norm) * (this.canvas.height - 2 * PAD_V);
  }

  _yToValue(y) {
    const { valueMin, valueMax } = this.config;
    const norm = 1 - (y - PAD_V) / (this.canvas.height - 2 * PAD_V);
    return Math.max(valueMin, Math.min(valueMax, valueMin + norm * (valueMax - valueMin)));
  }

  _canvasPos(e) { return canvasPos(this.canvas, e); }

  // ── Snap ────────────────────────────────────────────────────────────

  // Returns the nearest snap target within Y_SNAP_RADIUS px as { value }, or
  // { value: null } if no target is close enough. Snap targets are the neighbouring
  // control points (excluding `excludePoint`) and the lane's baseline (config.emptyValue).
  _snapCandidate(pos, tick, excludePoint = null) {
    const pts = this._points;
    let prevIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].tick <= tick) prevIdx = i; else break;
    }
    let bestDist = Y_SNAP_RADIUS, value = null;
    for (const ci of [prevIdx - 2, prevIdx - 1, prevIdx, prevIdx + 1, prevIdx + 2]) {
      if (ci < 0 || ci >= pts.length) continue;
      if (excludePoint && pts[ci] === excludePoint) continue;
      const dist = Math.abs(this._valueToY(pts[ci].value) - pos.y);
      if (dist < bestDist) { bestDist = dist; value = pts[ci].value; }
    }
    const { valueMin, valueMax, emptyValue } = this.config;
    const refLines = [
      valueMin,
      emptyValue,
      ...REF_FRACS.map(f => valueMin + f * (valueMax - valueMin)),
      valueMax,
    ];
    for (const candidate of refLines) {
      const dist = Math.abs(this._valueToY(candidate) - pos.y);
      if (dist < bestDist) { bestDist = dist; value = candidate; }
    }
    return { value };
  }

  _nearestPointIdx(pos) {
    const pts = this._points;
    let closest = -1, closestDist = HIT_RADIUS;
    for (let i = 0; i < pts.length; i++) {
      const px = this.roll.tickToX(pts[i].tick);
      const py = this._valueToY(pts[i].value);
      const d  = Math.hypot(pos.x - px, pos.y - py);
      if (d < closestDist) { closestDist = d; closest = i; }
    }
    return closest;
  }

  // ── Events ───────────────────────────────────────────────────────────

  _bindEvents() {
    this.canvas.addEventListener('click',       e  => this._onClick(e));
    this.canvas.addEventListener('contextmenu', e  => this._onContextMenu(e));
    this.canvas.addEventListener('mousedown',   e  => this._onMouseDown(e));
    this.canvas.addEventListener('mousemove',   e  => this._onMouseMove(e));
    this.canvas.addEventListener('mouseleave',  () => this._onMouseLeave());
    this.canvas.addEventListener('wheel',       e  => this._onWheel(e), { passive: false });
    window.addEventListener('mousemove', e => this._onWindowMouseMove(e));
    window.addEventListener('mouseup',   () => this._onWindowMouseUp());
  }

  _onMouseDown(e) {
    if (e.button !== 0 || !state.loaded) return;
    const pos = this._canvasPos(e);
    if (pos.x <= KEY_WIDTH) return;
    const idx = this._nearestPointIdx(pos);
    if (idx === -1) return;
    this._dragPoint    = this._points[idx];
    this._dragStartPos = pos;
    this._dragStarted  = false;
  }

  _onWindowMouseMove(e) {
    if (!this._dragPoint) return;
    const pos = this._canvasPos(e);
    if (!this._dragStarted) {
      const dx = pos.x - this._dragStartPos.x;
      const dy = pos.y - this._dragStartPos.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this._dragStarted = true;
      state.beginCurvePointMove();
    }
    const rawTick = Math.max(0, Math.round(this.roll.xToTick(pos.x)));
    let tick  = e.ctrlKey ? rawTick : state.snapTick(rawTick);
    let value = this._yToValue(pos.y);
    if (!e.ctrlKey) {
      const { value: snapped } = this._snapCandidate(pos, tick, this._dragPoint);
      if (snapped !== null) value = snapped;
    }
    this.config.movePoint(this._dragPoint, tick, value);
    // Keep hover state pinned to the dragged point so the dashed reticle and
    // hot fill follow it even when the cursor leaves the lane mid-drag.
    this._isHovered     = true;
    this._hoverTick     = this._dragPoint.tick;
    this._hoverPointIdx = this._points.indexOf(this._dragPoint);
    this.roll.render();
  }

  _onWindowMouseUp() {
    if (!this._dragPoint) return;
    if (this._dragStarted) this._didDrag = true;
    this._dragPoint    = null;
    this._dragStartPos = null;
    this._dragStarted  = false;
  }

  _onMouseMove(e) {
    if (this._dragPoint) return;
    this._updateHover(this._canvasPos(e));
  }

  _updateHover(pos) {
    const tick = pos.x > KEY_WIDTH ? this.roll.xToTick(pos.x) : null;
    const idx  = tick !== null ? this._nearestPointIdx(pos) : -1;

    const changed = !this._isHovered
      || this._hoverTick     !== tick
      || this._hoverPointIdx !== idx;

    this._isHovered     = true;
    this._hoverTick     = tick;
    this._hoverPointIdx = idx;

    if (changed) this.roll.render();
  }

  _onMouseLeave() {
    if (this._dragPoint) return;
    if (!this._isHovered) return;
    this._isHovered     = false;
    this._hoverTick     = null;
    this._hoverPointIdx = -1;
    this.roll.render();
  }

  _onClick(e) {
    if (this._didDrag) { this._didDrag = false; return; }
    if (!state.loaded) return;
    const pos = this._canvasPos(e);
    if (pos.x <= KEY_WIDTH) return;
    // Skip click-to-add when the press landed on an existing point: that's
    // either a no-threshold drag attempt or a misclick — never an add.
    if (this._nearestPointIdx(pos) !== -1) return;
    const rawTick = Math.max(0, Math.round(this.roll.xToTick(pos.x)));
    const tick    = e.ctrlKey ? rawTick : state.snapTick(rawTick);
    let   value   = this._yToValue(pos.y);
    if (!e.ctrlKey) {
      const { value: snapped } = this._snapCandidate(pos, tick);
      if (snapped !== null) value = snapped;
    }
    this.config.addPoint(tick, value);
  }

  _onContextMenu(e) {
    e.preventDefault();
    if (!state.loaded || !this._points.length) return;
    const pos = this._canvasPos(e);
    const idx = this._nearestPointIdx(pos);
    if (idx !== -1) this.config.removePoint(idx);
  }

  _onWheel(e) {
    e.preventDefault();
    const mouseX = this._canvasPos(e).x;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;

    if (e.ctrlKey || e.metaKey) {
      const mouseTick = this.roll.xToTick(mouseX);
      this.roll.pixelsPerTick = Math.max(0.01, Math.min(8, this.roll.pixelsPerTick * factor));
      this.roll.scrollX = this.roll._clampScrollX(mouseTick - (mouseX - KEY_WIDTH) / this.roll.pixelsPerTick);
    } else {
      this.roll.scrollX = this.roll._clampScrollX(this.roll.scrollX + e.deltaY / this.roll.pixelsPerTick * 0.5);
    }
    this.roll.render();
  }
}
