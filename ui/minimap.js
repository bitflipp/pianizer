// ui/minimap.js
// Overview mini-map lane: shows the full piece scaled down, renders the
// current viewport indicator and playhead, and lets the user pan by
// clicking or dragging.

import { state } from '../engine/state.js';
import { KEY_WIDTH, PITCH_MIN, PITCH_MAX, PITCH_RANGE, canvasPos } from './dom-utils.js';

export class MiniMap {
  constructor(canvas, roll) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.roll   = roll;
    this._dragging = false;
    this._mousePos = null;
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

    // Notes
    ctx.fillStyle = '#4a7abf';
    for (const n of state.notes) {
      const x = this._tickToX(n.startTick);
      const w = Math.max(1, this._tickToX(n.endTick) - x);
      ctx.fillRect(x, this._pitchToY(n.pitch), w, noteH);
    }

    // Bookmarks
    ctx.strokeStyle = '#e08030';
    ctx.lineWidth = 1;
    for (const tick of state.bookmarks) {
      const x = this._tickToX(tick);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }

    // Viewport indicator
    const vpL = this._tickToX(this.roll.scrollX);
    const vpR = this._tickToX(this.roll.scrollX + this.roll.rollWidth / this.roll.pixelsPerTick);
    const vpW = Math.max(2, vpR - vpL);
    const hot = this._dragging ||
                (this._mousePos !== null &&
                 this._mousePos.x >= vpL && this._mousePos.x <= vpL + vpW);
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
      this.render();
    });
    this.canvas.addEventListener('mouseleave', () => {
      this._mousePos = null;
      this.render();
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
