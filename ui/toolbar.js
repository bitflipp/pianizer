// ui/toolbar.js
// <ph-toolbar> — a plain custom element. Builds its DOM once in the constructor,
// then patches only the bits that change in response to state events. No
// framework or build step.

import { state, SNAP_GRIDS } from '../engine/state.js';
import { midiOut } from '../engine/midi-out.js';

const STYLE = `
  :host {
    display: block;
    background: #111;
    border-bottom: 1px solid #444;
  }
  .inner {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px;
    font: 12px monospace;
    color: #fff;
    flex-wrap: wrap;
  }
  button {
    background: #222;
    border: 1px solid #666;
    color: #fff;
    padding: 4px 8px;
    font: 12px monospace;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #333; border-color: #bbb; }
  button:disabled { opacity: 0.3; cursor: default; }
  .transport { display: flex; gap: 6px; align-items: center; }
  .time { font-size: 12px; letter-spacing: 1px; min-width: 56px; }
  select {
    background: #222;
    color: #fff;
    border: 1px solid #666;
    font: 12px monospace;
    padding: 2px 4px;
  }
  .sep { color: #666; }
  .snap-label, .midi-label, .restrike-label { color: #ccc; }
`;

// Selectable re-strike-gap values (ms). Topping out at 80 ms: a grand can't
// produce more than ~15 intelligible repeats/sec (~66 ms apart), so a larger
// gap would start eating into musically valid repeats rather than just
// protecting the action's reset. 0 = off (pass note durations through untouched).
const RESTRIKE_OPTIONS = [0, 20, 30, 40, 50, 60, 70, 80];

export class Toolbar extends HTMLElement {
  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);

    const inner = document.createElement('div');
    inner.className = 'inner';
    inner.innerHTML = `
      <button data-action="load">Load MusicXML</button>
      <button data-action="load-project">Load project</button>
      <button data-action="save-project" disabled>Save project</button>
      <button data-action="undo" disabled title="Ctrl+Z">Undo</button>
      <button data-action="redo" disabled title="Ctrl+Y">Redo</button>
      <span class="sep">│</span>
      <div class="transport">
        <button data-action="stop" disabled>Stop</button>
        <button data-action="play" disabled>Play</button>
        <select data-role="speed">
          <option value="0.25">25%</option>
          <option value="0.5">50%</option>
          <option value="0.75">75%</option>
          <option value="1" selected>100%</option>
          <option value="1.25">125%</option>
          <option value="1.5">150%</option>
          <option value="2">200%</option>
        </select>
        <span class="time">0:00</span>
      </div>
      <span class="sep">│</span>
      <span class="snap-label">Snap</span>
      <select data-role="snap">
        ${SNAP_GRIDS.map(g => `<option value="${g}"${g === state.snapGrid ? ' selected' : ''}>${g}</option>`).join('')}
      </select>
      <span class="sep">│</span>
      <button data-action="vel-curve">Vel. curve</button>
      <span class="restrike-label" title="Minimum key-up before the same key is struck again, so an acoustic grand's action can reset. Off passes note durations through untouched.">Re-strike</span>
      <select data-role="restrike">
        ${RESTRIKE_OPTIONS.map(ms => `<option value="${ms}"${ms === state.restrikeGapMs ? ' selected' : ''}>${ms === 0 ? 'Off' : ms + ' ms'}</option>`).join('')}
      </select>
      <span class="sep">│</span>
      <span class="midi-label">MIDI out</span>
      <button data-action="midi-connect">Connect</button>
      <select data-role="midi-port" hidden></select>
    `;
    shadow.appendChild(inner);

    this._saveBtn  = shadow.querySelector('[data-action="save-project"]');
    this._undoBtn  = shadow.querySelector('[data-action="undo"]');
    this._redoBtn  = shadow.querySelector('[data-action="redo"]');
    this._stopBtn  = shadow.querySelector('[data-action="stop"]');
    this._playBtn  = shadow.querySelector('[data-action="play"]');
    this._timeEl   = shadow.querySelector('.time');
    this._connBtn  = shadow.querySelector('[data-action="midi-connect"]');
    this._midiSel  = shadow.querySelector('[data-role="midi-port"]');
    this._snapSel     = shadow.querySelector('[data-role="snap"]');
    this._speedSel    = shadow.querySelector('[data-role="speed"]');
    this._restrikeSel = shadow.querySelector('[data-role="restrike"]');

    const emit = name => () => this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, composed: true })
    );
    shadow.querySelector('[data-action="load"]').addEventListener('click', emit('load-file'));
    shadow.querySelector('[data-action="load-project"]').addEventListener('click', emit('load-project'));
    this._saveBtn.addEventListener('click', emit('save-project'));
    this._undoBtn.addEventListener('click', () => state.undo());
    this._redoBtn.addEventListener('click', () => state.redo());
    this._stopBtn.addEventListener('click', emit('stop-playback'));
    this._playBtn.addEventListener('click', emit('toggle-playback'));
    this._connBtn.addEventListener('click', emit('midi-connect'));
    shadow.querySelector('[data-action="vel-curve"]').addEventListener('click', emit('vel-curve'));

    this._snapSel.addEventListener('change', e => {
      state.snapGrid = e.target.value;
      state.dispatch('snapchanged');
    });
    this._midiSel.addEventListener('change', e => { midiOut.outputId = e.target.value; });
    this._restrikeSel.addEventListener('change', e => { state.setRestrikeGap(Number(e.target.value)); });
    this._speedSel.addEventListener('change', e => {
      this.dispatchEvent(new CustomEvent('play-speed', {
        bubbles: true, composed: true,
        detail: { speed: Number(e.target.value) },
      }));
    });

    state.addEventListener('loaded',           () => this._syncLoaded());
    state.addEventListener('playbackchanged',  () => this._syncPlayback());
    state.addEventListener('playheadmoved',    () => { this._timeEl.textContent = formatTime(state.playheadTime); });
    state.addEventListener('undochanged',      () => this._syncUndo());
    state.addEventListener('midiportschanged', () => this._syncMidi());
    state.addEventListener('snapchanged',      () => { this._snapSel.value = state.snapGrid; });
    state.addEventListener('playspeedchanged', () => { this._speedSel.value = String(state.playSpeed); });
    state.addEventListener('restrikegapchanged', () => { this._restrikeSel.value = String(state.restrikeGapMs); });
  }

  _syncLoaded() {
    const has = state.loaded;
    this._saveBtn.disabled = !has;
    this._stopBtn.disabled = !has;
    this._playBtn.disabled = !has;
  }

  _syncPlayback() {
    this._playBtn.textContent = state.playing ? 'Pause' : 'Play';
  }

  _syncUndo() {
    this._undoBtn.disabled = !state.canUndo;
    this._redoBtn.disabled = !state.canRedo;
  }

  _syncMidi() {
    const connected = midiOut.connected;
    this._connBtn.hidden = connected;
    if (!connected) { this._midiSel.hidden = true; return; }

    this._midiSel.hidden = false;
    const sel = midiOut.outputId;
    this._midiSel.replaceChildren(...midiOut.outputs.map(o => {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      if (o.id === sel) opt.selected = true;
      return opt;
    }));
  }
}

customElements.define('ph-toolbar', Toolbar);

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
