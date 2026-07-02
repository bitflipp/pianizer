// ui/curve-lane.js
// Base class for the tempo and pedal curve editors.
// Each lane edits a curve of {tick, value} control points — drawn piecewise-linear
// by default, or smooth when the config supplies a `makeSampler` (the tempo lane's
// monotone cubic).
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

import { state, snapGridTicks } from '../engine/state.js';
import {
  KEY_WIDTH, canvasPos, forwardWheelToRoll,
  drawTickGrid, drawVerticalLine, drawLaneLabel,
} from './dom-utils.js';

const PAD_V           = 6;
const HIT_RADIUS      = 12;
const DRAG_THRESHOLD  = 4;
const Y_SNAP_RADIUS   = 11;

const COL_REF_BASE  = '#353535'; // baseline reference line (range midpoint)
const COL_REF_OTHER = '#222222'; // non-baseline reference lines

const PT_SIZE       = 6;  // control-point square (px)
const PT_SIZE_HOT   = 8;  // hovered/dragged control-point square (px)

// Reference lines drawn across the lane and used as Y-snap targets: eighths of
// the value range, *including the two edges* (frac 0 = valueMin, frac 1 = valueMax).
// They are placed in the padded value↔Y space (via _valueToY), not raw canvas
// fractions, because a control point also maps through that space and so can never
// be drawn in the PAD_V margin — a line outside it would sit where no point can
// land, and its snap target would drift off the line. Including the edges keeps
// every band between consecutive lines the same height (the PAD_V margins above the
// top line and below the bottom line stay equal and thin). A lane may override this
// with `config.refFracs`.
const REF_FRACS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

export class CurveLane {
  constructor(canvas, roll, config) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.roll   = roll;
    this.config = config;
    this._refFracs = config.refFracs ?? REF_FRACS;

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
    const { valueMin, valueMax } = this.config;
    ctx.lineWidth = 1;
    for (const frac of this._refFracs) {
      ctx.strokeStyle = frac === 0.5 ? COL_REF_BASE : COL_REF_OTHER;
      const y = this._valueToY(valueMin + frac * (valueMax - valueMin));
      ctx.beginPath();
      ctx.moveTo(KEY_WIDTH, y);
      ctx.lineTo(canvas.width, y);
      ctx.stroke();
    }
  }

  _drawLabel() {
    drawLaneLabel(this.ctx, this.canvas, this.config.label);
  }

  _drawGrid() {
    const { ctx, canvas } = this;
    const tpb       = state.ticksPerBeat;
    const tickStart = this.roll.scrollX;
    const tickEnd   = tickStart + (canvas.width - KEY_WIDTH) / this.roll.pixelsPerTick;
    drawTickGrid(ctx, t => this.roll.tickToX(t), 0, canvas.height,
      tickStart, tickEnd, tpb, snapGridTicks(state.snapGrid, tpb), state.barBoundaries(tickStart, tickEnd));
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
        ctx.fillRect(px - PT_SIZE_HOT / 2, py - PT_SIZE_HOT / 2, PT_SIZE_HOT, PT_SIZE_HOT);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(px - PT_SIZE / 2, py - PT_SIZE / 2, PT_SIZE, PT_SIZE);
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
    drawVerticalLine(this.ctx, x, 0, this.canvas.height);
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

  // The tick a click/drag/reticle lands on: grid-snapped, or raw when Ctrl
  // disables snapping. Shared by add/move and the hover reticle so they agree.
  _tickAtX(x, e) {
    const rawTick = Math.max(0, Math.round(this.roll.xToTick(x)));
    return e?.ctrlKey ? rawTick : state.snapTick(rawTick);
  }

  // ── Snap ────────────────────────────────────────────────────────────

  // Returns the nearest snap target within Y_SNAP_RADIUS px as { value }, or
  // { value: null } if no target is close enough. Snap targets are the neighbouring
  // control points (excluding `excludePoint`), the lane's top/bottom edges
  // (valueMin/valueMax), the `_refFracs` reference lines, and the baseline (config.emptyValue).
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
    // Snap targets are the reference lines (`_refFracs` fractions of the value
    // range incl. the edges — see REF_FRACS / _drawBackground) plus the baseline.
    // Expressed as values so a snapped point lands exactly on its drawn line under
    // the value↔Y mapping (the edges come in via frac 0 / frac 1 of refFracs).
    const refLines = [
      emptyValue,
      ...this._refFracs.map(f => valueMin + f * (valueMax - valueMin)),
    ];
    for (const candidate of refLines) {
      const dist = Math.abs(this._valueToY(candidate) - pos.y);
      if (dist < bestDist) { bestDist = dist; value = candidate; }
    }
    return { value };
  }

  // Resolve a pointer position into the {tick, value} an add/move should land on:
  // tick from x (grid-snapped unless Ctrl), value from y (snapped to a candidate
  // unless Ctrl). `excludePoint` keeps a dragged point from snapping to itself.
  _snappedTickValue(pos, e, excludePoint = null) {
    const tick  = this._tickAtX(pos.x, e);
    let   value = this._yToValue(pos.y);
    if (!e.ctrlKey) {
      const { value: snapped } = this._snapCandidate(pos, tick, excludePoint);
      if (snapped !== null) value = snapped;
    }
    return { tick, value };
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
    this.canvas.addEventListener('wheel',       e  => forwardWheelToRoll(this.roll, this.canvas, e), { passive: false });
    window.addEventListener('mousemove', e => this._onWindowMouseMove(e));
    window.addEventListener('mouseup',   () => this._onWindowMouseUp());
  }

  _onMouseDown(e) {
    if (e.button !== 0 || !state.loaded) return;
    // Stale if the previous drag released off-canvas (its click never fired on
    // this canvas to consume the flag) — don't let it eat this press's click.
    this._didDrag = false;
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
    const { tick, value } = this._snappedTickValue(pos, e, this._dragPoint);
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
    this._updateHover(this._canvasPos(e), e);
  }

  // Two visuals depend on lane hover: the dashed reticle (drawn by the roll) and this
  // lane's own hot-point square (drawn here, changes only when the nearest control point
  // flips). They're repainted independently so cursor motion repaints just the roll for
  // the reticle — the lane canvas repaints only when the hot point actually changes.
  // (The roll's onPostRender is view-gated, so it no longer drags the lane along on every
  // reticle move.) The reticle sits on the tick a click/drag would land on, not the raw
  // cursor tick: an existing point's tick when hovering one, else the grid-snapped tick
  // (raw when Ctrl disables snapping) — so it reads as a snap preview, not a free crosshair.
  _updateHover(pos, e) {
    const overLane = pos.x > KEY_WIDTH;
    const idx  = overLane ? this._nearestPointIdx(pos) : -1;
    let tick = null;
    if (overLane) {
      if (idx >= 0) {
        tick = this._points[idx].tick;
      } else {
        tick = this._tickAtX(pos.x, e);
      }
    }

    const reticleChanged = !this._isHovered
      || this._hoverTick     !== tick
      || this._hoverPointIdx !== idx;
    const hotPointChanged = this._hoverPointIdx !== idx;

    this._isHovered     = true;
    this._hoverTick     = tick;
    this._hoverPointIdx = idx;

    if (hotPointChanged) this.render();       // own hot-point square
    if (reticleChanged)  this.roll.render();  // reticle in the roll
  }

  _onMouseLeave() {
    if (this._dragPoint) return;
    if (!this._isHovered) return;
    const hadHotPoint = this._hoverPointIdx >= 0;
    this._isHovered     = false;
    this._hoverTick     = null;
    this._hoverPointIdx = -1;
    if (hadHotPoint) this.render();  // clear the hot-point square only if one was lit
    this.roll.render();              // clear the reticle
  }

  _onClick(e) {
    if (this._didDrag) { this._didDrag = false; return; }
    if (!state.loaded) return;
    const pos = this._canvasPos(e);
    if (pos.x <= KEY_WIDTH) return;
    // Skip click-to-add when the press landed on an existing point: that's
    // either a no-threshold drag attempt or a misclick — never an add.
    if (this._nearestPointIdx(pos) !== -1) return;
    const { tick, value } = this._snappedTickValue(pos, e);
    this.config.addPoint(tick, value);
    // Pin hover to the just-created point so the roll reticle reads hot
    // immediately, before any further cursor motion (mirrors the drag path).
    this._isHovered     = true;
    this._hoverTick     = tick;
    this._hoverPointIdx = this._points.findIndex(p => p.tick === tick);
    this.render();
    this.roll.render();
  }

  _onContextMenu(e) {
    e.preventDefault();
    if (!state.loaded || !this._points.length) return;
    const pos = this._canvasPos(e);
    const idx = this._nearestPointIdx(pos);
    if (idx === -1) return;
    this.config.removePoint(idx);
    // The point under the cursor is gone — recompute hover so the reticle drops
    // its hot color (and the hot-point square clears) instead of staying pinned.
    this._updateHover(pos, e);
  }

}
