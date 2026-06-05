// engine/midi-out.js
// Web MIDI API output — schedules note on/off and CC64 (sustain pedal) via
// MIDIOutput.send() with performance.now() timestamps.

import { state, interpolateCurveAtTick } from './state.js';


export class MidiOut {
  constructor() {
    this._access           = null;
    this.outputId          = null;
    this._scheduleInterval = null;
  }

  get available()  { return 'requestMIDIAccess' in navigator; }
  get connected()  { return this._access !== null; }
  get outputs()    { return this._access ? [...this._access.outputs.values()] : []; }

  get selectedOutput() {
    return this._access?.outputs.get(this.outputId) ?? null;
  }

  async requestAccess() {
    this._access = await navigator.requestMIDIAccess({ sysex: false });
    this._access.onstatechange = () => {
      if (this.outputId && !this._access.outputs.has(this.outputId)) {
        this.outputId = this.outputs[0]?.id ?? null;
      }
      state.dispatch('midiportschanged');
    };
    if (!this.outputId) this.outputId = this.outputs[0]?.id ?? null;
    state.dispatch('midiportschanged');
  }

  // ── Playback scheduling ────────────────────────────────────────────
  // Lookahead scheduler: every 30ms, schedule any events in the next 150ms window.
  // startTime: piece time in seconds to start from.
  // getPieceTime(): returns current playback position in piece-seconds.

  schedulePlayback(startTime, getPieceTime) {
    this.stopPlayback();

    // Collect unique MIDI channels used by notes (for CC64 broadcast)
    const channels = [...new Set(state.notes.map(n => (n.channel ?? 0) & 0xf))];
    if (channels.length === 0) channels.push(0);

    const sortedNotes = state.notes
      .map(n => ({
        n,
        noteStart: state.tickToTime(n.startTick),
        noteEnd:   state.tickToTime(n.endTick),
      }))
      .filter(({ noteStart }) => noteStart >= startTime - 0.05)
      .sort((a, b) => a.noteStart - b.noteStart);

    // For each note, the onset (piece seconds) of the next note that re-strikes
    // the same key (pitch+channel), or Infinity if none. Drives the re-strike gap.
    const nextStartByEntry = new Array(sortedNotes.length);
    const lastStartForKey  = new Map();
    for (let i = sortedNotes.length - 1; i >= 0; i--) {
      const { n, noteStart } = sortedNotes[i];
      const key = (n.pitch << 4) | ((n.channel ?? 0) & 0xf);
      nextStartByEntry[i] = lastStartForKey.has(key) ? lastStartForKey.get(key) : Infinity;
      lastStartForKey.set(key, noteStart);
    }

    // Pedal events: initial value at seek point + one event per control point after it
    const pedalEvents = buildPedalEvents(startTime);

    let notePtr  = 0;
    let pedalPtr = 0;
    const LOOKAHEAD            = 0.15; // seconds
    const SCHEDULE_INTERVAL_MS = 30;

    const schedule = () => {
      const out = this.selectedOutput;
      if (!out) return;

      const nowMs     = performance.now();
      const pieceNow  = getPieceTime();
      const windowEnd = pieceNow + LOOKAHEAD;
      const toWallMs  = t => nowMs + (t - pieceNow) / state.playSpeed * 1000;
      // Re-strike gap is wall-clock; read live so a toolbar change applies to
      // notes scheduled from here on without restarting playback. 0 disables it.
      const restrikeGapMs = state.restrikeGapMs;

      // Notes
      while (notePtr < sortedNotes.length && sortedNotes[notePtr].noteStart <= windowEnd) {
        const idx = notePtr++;
        const { n, noteStart, noteEnd } = sortedNotes[idx];

        const onMs  = toWallMs(noteStart);
        let   offMs = toWallMs(noteEnd);

        // Pull the off in so the same key is released at least restrikeGapMs
        // before its next strike. The safeOffMs floor below keeps the note from
        // collapsing to nothing when the repeat is very close (e.g. a tremolo).
        const nextSameKey = nextStartByEntry[idx];
        if (restrikeGapMs > 0 && nextSameKey !== Infinity) {
          offMs = Math.min(offMs, toWallMs(nextSameKey) - restrikeGapMs);
        }

        const safeOnMs  = Math.max(onMs,  nowMs + 5);
        const safeOffMs = Math.max(offMs, safeOnMs + 10);

        if (offMs + 200 <= nowMs) continue; // already ended

        const ch       = (n.channel ?? 0) & 0xf;
        const curveAdj = state.velocityCurve[n.pitch - 21] ?? 0;
        const vel      = Math.max(1, Math.min(127, n.velocity + curveAdj));

        try {
          out.send([0x90 | ch, n.pitch, vel], safeOnMs);
          out.send([0x80 | ch, n.pitch, 0],   safeOffMs);
        } catch {}
      }

      // Pedal CC64 — sent on all active channels
      while (pedalPtr < pedalEvents.length && pedalEvents[pedalPtr].time <= windowEnd) {
        const { time, value } = pedalEvents[pedalPtr++];

        if (time + 0.1 < pieceNow) continue; // already past

        const evMs   = toWallMs(time);
        const safeMs = Math.max(evMs, nowMs + 2);
        const cc64   = Math.round(value * 127);

        for (const ch of channels) {
          try { out.send([0xb0 | ch, 64, cc64], safeMs); } catch {}
        }
      }
    };

    schedule();
    this._scheduleInterval = setInterval(schedule, SCHEDULE_INTERVAL_MS);
  }

  stopPlayback() {
    if (this._scheduleInterval !== null) {
      clearInterval(this._scheduleInterval);
      this._scheduleInterval = null;
    }
    const out = this.selectedOutput;
    if (!out) return;
    try { out.clear(); } catch {}
    for (let ch = 0; ch < 16; ch++) {
      try {
        out.send([0xb0 | ch, 64,  0]); // CC64 pedal release
        out.send([0xb0 | ch, 123, 0]); // All Notes Off
        out.send([0xb0 | ch, 120, 0]); // All Sound Off
      } catch {}
    }
  }
}

// ── Pedal helpers ──────────────────────────────────────────────────────────

// Returns [{time, value}] sorted by time: initial value at startTime,
// then one entry per control point that falls after startTime.
function buildPedalEvents(startTime) {
  const pts = state.pedalPoints;
  const events = [];

  const startTick = state.timeToTick(startTime);
  events.push({ time: startTime, value: interpolateCurveAtTick(pts, startTick, 0) });

  for (const p of pts) {
    const t = state.tickToTime(p.tick);
    if (t > startTime) events.push({ time: t, value: p.value });
  }

  return events; // pts is already sorted by tick so this is already sorted by time
}

export const midiOut = new MidiOut();
