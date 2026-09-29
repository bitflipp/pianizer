// ui/dom-utils.js
// Shared layout constants and small DOM helpers used by the canvas UI
// classes and the host page.

import { state, snapGridTicks, PITCH_MIN, PITCH_MAX } from '../engine/state.js';

export const KEY_WIDTH     = 36;       // pixel width of the piano key strip
export const HEADER_HEIGHT = 24;       // pixel height of the bar/beat ruler
export { PITCH_MIN, PITCH_MAX };       // A0…C8, owned by the engine (state clamps to it)
export const PITCH_RANGE   = PITCH_MAX - PITCH_MIN + 1;

// Lane backgrounds: the key strip and the content area beside it.
export const COL_KEY_BG  = '#111';
export const COL_LANE_BG = '#161616';

// Tick-grid line colors, shared by the roll and the curve/region lanes.
export const COL_GRID_SUB  = '#212121';
export const COL_GRID_BEAT = '#343434';
export const COL_GRID_BAR  = '#525252';

// Scales mouse CSS coordinates to canvas logical coordinates. The two differ
// when the canvas logical size (set from clientWidth/Height) doesn't match its
// CSS-rendered size — e.g. before the toolbar has taken its layout space.
// Without this, hit testing drifts at non-1:1 ratios.
export function canvasPos(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width  / r.width),
    y: (e.clientY - r.top)  * (canvas.height / r.height),
  };
}

// Forwards a wheel gesture over a lane canvas to the roll (Ctrl/Cmd+wheel zooms
// toward the cursor tick, a plain wheel pans horizontally). The lanes share the
// roll's horizontal view, so they delegate the gesture rather than tracking
// scroll/zoom themselves; lane and roll canvases share the same x geometry.
export function forwardWheelToRoll(roll, canvas, e) {
  roll.applyWheel(e, canvasPos(canvas, e).x);
}

// Draws sub-beat, beat, and bar grid lines across [tickStart, tickEnd] via
// tickToX, spanning [yTop, yBottom] vertically. Shared by the roll and the
// curve/region lanes — identical logic, differing only in y-extent and the
// tick→x mapping (the roll's own vs. a lane's `roll.tickToX`). `subTicks` is
// the caller's current snap-grid resolution in ticks; `bars` is the caller's
// `state.barBoundaries(tickStart, tickEnd)` result.
export function drawTickGrid(ctx, tickToX, yTop, yBottom, tickStart, tickEnd, tpb, subTicks, bars) {
  const drawLine = x => {
    if (x <= KEY_WIDTH) return;
    ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBottom); ctx.stroke();
  };

  ctx.strokeStyle = COL_GRID_SUB; ctx.lineWidth = 0.5;
  for (let t = Math.floor(tickStart / subTicks) * subTicks; t <= tickEnd; t += subTicks) {
    drawLine(tickToX(t));
  }

  ctx.strokeStyle = COL_GRID_BEAT; ctx.lineWidth = 1;
  for (let t = Math.floor(tickStart / tpb) * tpb; t <= tickEnd; t += tpb) {
    drawLine(tickToX(t));
  }

  ctx.strokeStyle = COL_GRID_BAR; ctx.lineWidth = 1.5;
  for (const { tick } of bars) drawLine(tickToX(tick));
}

// The tick grid across a whole lane canvas (see drawTickGrid), following the
// roll's horizontal view. Shared by the curve and region lanes.
export function drawLaneGrid(ctx, canvas, roll) {
  const tpb       = state.ticksPerBeat;
  const tickStart = roll.scrollX;
  const tickEnd   = tickStart + (canvas.width - KEY_WIDTH) / roll.pixelsPerTick;
  drawTickGrid(ctx, t => roll.tickToX(t), 0, canvas.height,
    tickStart, tickEnd, tpb, snapGridTicks(state.snapGrid, tpb), state.barBoundaries(tickStart, tickEnd));
}

// The playhead line across a whole lane canvas. Shared by the curve and region lanes.
export function drawLanePlayhead(ctx, canvas, roll) {
  if (!state.loaded) return;
  const x = roll.tickToX(state.timeToTick(state.playheadTime));
  if (x <= KEY_WIDTH) return;
  drawVerticalLine(ctx, x, 0, canvas.height);
}

// Best-effort localStorage write — swallows quota / private-mode errors.
export function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

// Draws a solid vertical line at canvas x from yTop to yBottom — the playhead
// marker shared by the roll and the curve/region lanes (the roll additionally
// draws a triangle flag on top of its line).
export function drawVerticalLine(ctx, x, yTop, yBottom, color = '#ffffff') {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yBottom);
  ctx.stroke();
}

// Draws a lane's centered key-strip label (e.g. 'PED', 'TEMPO', 'U.C.') —
// shared by the curve and region lanes.
export function drawLaneLabel(ctx, canvas, text) {
  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, KEY_WIDTH / 2, canvas.height / 2);
}

// True when the keyboard event originates from a form element — used to skip
// keyboard shortcuts so typing in an input/select/textarea doesn't trigger app
// actions. Takes the event, not its target: events from inside a shadow DOM
// (the toolbar's selects) retarget `e.target` to the host element, hiding the
// real control; composedPath()[0] sees through that.
export function isFormFocused(e) {
  const t = e.composedPath ? e.composedPath()[0] : e.target;
  return t instanceof HTMLInputElement
      || t instanceof HTMLSelectElement
      || t instanceof HTMLTextAreaElement;
}
