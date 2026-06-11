// ui/minimap.js
// Overview mini-map lane: shows the full piece scaled down, renders the
// current viewport indicator and playhead, and lets the user pan by
// clicking or dragging.

import { state } from '../engine/state.js';
import { KEY_WIDTH, PITCH_MIN, PITCH_MAX, PITCH_RANGE, canvasPos } from './dom-utils.js';
import { noteHSL } from './roll.js';

// Velocity-coloured notes, batched into bands so the per-render cost stays
// flat. Setting ctx.fillStyle to a fresh hsl() string re-parses a CSS colour
// every time, so a naive per-note colour would parse once per note per frame
// — and the minimap re-renders on every mousemove. Instead we quantize
// velocity into VEL_BUCKETS bands, precompute one colour string per band, and
// set fillStyle once per band: ~VEL_BUCKETS parses per frame regardless of how
// many notes the piece has.
const VEL_BUCKETS = 16;
const VEL_COLORS  = Array.from({ length: VEL_BUCKETS }, (_, b) =>
  noteHSL(Math.round((b + 0.5) / VEL_BUCKETS * 127), 'normal'));

export class MiniMap {
  constructor(canvas, roll) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.roll   = roll;
    this._dragging = false;
    this._mousePos = null;
    this._hot      = false;   // last-painted viewport-indicator hover state
    this._bindEvents();
  }

  get _cw()    { return this.canvas.width - KEY_WIDTH; }
  get _range() { return this.roll.scrollableTicks; }

  _tickToX(tick) {
    return KEY_WIDTH + (tick / this._range) * this._cw;
  }

  _pitchToY(pitch) {
    return ((PITCH_MAX - pitch) / PITCH_RANGE) * this.canvas.height;
  }

  // Left edge + width of the viewport indicator (in canvas px).
  _viewportBounds() {
    const vpL = this._tickToX(this.roll.scrollX);
    const vpR = this._tickToX(this.roll.scrollX + this.roll.rollWidth / this.roll.pixelsPerTick);
    return { vpL, vpW: Math.max(2, vpR - vpL) };
  }

  // Whether the indicator should paint in its brightened (hover/drag) state.
  _isHot(pos) {
    if (this._dragging) return true;
    if (pos === null)   return false;
    const { vpL, vpW } = this._viewportBounds();
    return pos.x >= vpL && pos.x <= vpL + vpW;
  }

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0e0e0e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!state.loaded || !state.totalTicks) return;

    const noteH = Math.max(1, canvas.height / PITCH_RANGE);

    // Subtle band for the used pitch range
    if (state.notes.length) {
      let minP = PITCH_MAX, maxP = PITCH_MIN;
      for (const n of state.notes) {
        if (n.pitch < minP) minP = n.pitch;
        if (n.pitch > maxP) maxP = n.pitch;
      }
      const y1 = this._pitchToY(maxP);
      const y2 = this._pitchToY(minP) + noteH;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(KEY_WIDTH, y1, this._cw, y2 - y1);
    }

    // Notes, velocity-coloured. Bucket once, then draw band by band so
    // fillStyle (and its CSS-colour parse) is set only VEL_BUCKETS times.
    const buckets = Array.from({ length: VEL_BUCKETS }, () => []);
    for (const n of state.notes) {
      const b = Math.min(VEL_BUCKETS - 1, (n.velocity / 128 * VEL_BUCKETS) | 0);
      buckets[b].push(n);
    }
    for (let b = 0; b < VEL_BUCKETS; b++) {
      const group = buckets[b];
      if (!group.length) continue;
      ctx.fillStyle = VEL_COLORS[b];
      for (const n of group) {
        const x = this._tickToX(n.startTick);
        const w = Math.max(1, this._tickToX(n.endTick) - x);
        ctx.fillRect(x, this._pitchToY(n.pitch), w, noteH);
      }
    }

    // Bookmarks
    ctx.strokeStyle = '#e08030';
    ctx.lineWidth = 1;
    for (const tick of state.bookmarks) {
      const x = this._tickToX(tick);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }

    // Viewport indicator
    const { vpL, vpW } = this._viewportBounds();
    const hot = this._hot = this._isHot(this._mousePos);
    ctx.fillStyle = hot ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.10)';
    ctx.fillRect(vpL, 0, vpW, canvas.height);
    ctx.strokeStyle = hot ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vpL + 0.5, 0.5, vpW - 1, canvas.height - 1);

    // Playhead
    const px = this._tickToX(state.timeToTick(state.playheadTime));
    if (px > KEY_WIDTH) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, canvas.height); ctx.stroke();
    }

    // Key strip (drawn last so nothing bleeds into it)
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, KEY_WIDTH, canvas.height);
  }

  _canvasPos(e) { return canvasPos(this.canvas, e); }

  _panToPos(pos) {
    if (!state.totalTicks || pos.x <= KEY_WIDTH) return;
    const tick = (pos.x - KEY_WIDTH) / this._cw * this._range;
    this.roll.scrollX = this.roll._clampScrollX(
      tick - this.roll.rollWidth / this.roll.pixelsPerTick / 2
    );
    this.roll.render();
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this._dragging = true;
      this.canvas.style.cursor = 'grabbing';
      this._panToPos(this._canvasPos(e));
    });
    this.canvas.addEventListener('mousemove', e => {
      this._mousePos = this._canvasPos(e);
      // Only the viewport-indicator hover state depends on the cursor, so
      // repaint solely when it flips — not on every mouse event.
      if (this._isHot(this._mousePos) !== this._hot) this.render();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._mousePos = null;
      if (this._hot) this.render();   // clear the indicator only if it was lit
    });
    window.addEventListener('mousemove', e => {
      if (this._dragging) this._panToPos(this._canvasPos(e));
    });
    window.addEventListener('mouseup', e => {
      if (e.button !== 0) return;
      this._dragging = false;
      this.canvas.style.cursor = '';
    });
  }
}
