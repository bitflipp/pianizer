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

  // onReady (optional): called once, synchronously, *after* all the per-note
  // prep below and immediately *before* the first schedule() tick. The caller
  // uses it to (re)baseline the playback clock — building sortedNotes runs
  // state.tickToTime() twice per note (numerically integrating the tempo curve),
  // which can take ~100ms on a large score. If the clock origin were set before
  // that work, getPieceTime() would already read ~100ms by the first tick, every
  // note in that gap would clamp to nowMs+5 and fire bunched, and the playhead
  // (same clock) would have jumped ahead — the "silence then compressed catch-up"
  // at the start of playback. Baselining here keeps prep cost off the clock.
  schedulePlayback(startTime, getPieceTime, onReady = null) {
    // Collect unique MIDI channels used by notes (for CC64 broadcast + reset).
    const channels = [...new Set(state.notes.map(n => (n.channel ?? 0) & 0xf))];
    if (channels.length === 0) channels.push(0);

    // Reset only the channels we're about to play on. A full 16-channel reset
    // here would push ~48 untimed messages onto the pipe ahead of the note-ons
    // we schedule below; on a serial/USB-MIDI port (or ALSA → FluidSynth, which
    // floats immediate sends ahead of slightly-future ones) that head-of-line
    // drain stalls the first ~100ms of output, so the playhead advances in
    // silence and the backlog then fires compressed. Scoping the reset to the
    // channels in use (one, for a piano score) keeps the start tight.
    this.stopPlayback(channels);

    // Assert the pedal state for the start point *immediately*, on the same
    // untimed/direct path as stopPlayback()'s CC64=0 reset (which just ran). A
    // queued, slightly-future send can be reordered behind an immediate one on
    // some MIDI backends (notably Linux/ALSA → FluidSynth), so the held pedal
    // value would otherwise lose a race with the reset and never take effect.
    // The lookahead loop below only schedules control points *after* startTime.
    const startOut = this.selectedOutput;
    if (startOut) {
      const startTick = state.timeToTick(startTime);
      const cc64 = Math.round(interpolateCurveAtTick(state.pedalPoints, startTick, 0) * 127);
      for (const ch of channels) {
        try { startOut.send([0xb0 | ch, 64, cc64]); } catch {}
      }
    }

    // state.tickToTime() is the cached batched converter (state._timeline), so
    // converting every note's start/end here is O(breaks + notes) — the naive
    // per-call re-integration from tick 0 is what made playback start ~100ms late.
    // Notes are kept if they start after the start point — or started before it
    // but are still sounding (noteEnd > startTime): those are *chased*, scheduled
    // immediately at the start so beginning playback mid-held-note still sounds it.
    const sortedNotes = state.notes
      .map(n => ({
        n,
        noteStart: state.tickToTime(n.startTick),
        noteEnd:   state.tickToTime(n.endTick),
      }))
      .filter(({ n, noteStart, noteEnd }) =>
        !n.muted && (noteStart >= startTime - 0.05 || noteEnd > startTime))
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

    // Pedal events after the start point — control points plus the per-CC-step
    // ramp samples between them (the start-point value was already asserted
    // immediately above). See buildPedalEvents.
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

    onReady?.(); // baseline the playback clock now that the heavy prep is done
    schedule();
    this._scheduleInterval = setInterval(schedule, SCHEDULE_INTERVAL_MS);
  }

  // channels: which MIDI channels to reset. Defaults to all 16 (a standalone
  // Stop wants a clean slate); schedulePlayback passes just the channels in use
  // so the pre-playback reset doesn't flood the pipe — see there.
  stopPlayback(channels = null) {
    if (this._scheduleInterval !== null) {
      clearInterval(this._scheduleInterval);
      this._scheduleInterval = null;
    }
    const out = this.selectedOutput;
    if (!out) return;
    try { out.clear(); } catch {}
    const chans = channels ?? [...Array(16).keys()];
    for (const ch of chans) {
      try {
        out.send([0xb0 | ch, 64,  0]); // CC64 pedal release
        out.send([0xb0 | ch, 123, 0]); // All Notes Off
        out.send([0xb0 | ch, 120, 0]); // All Sound Off
      } catch {}
    }
  }
}

// ── Pedal helpers ──────────────────────────────────────────────────────────

// Returns [{time, value}] sorted by time, covering everything after startTime.
// The lane draws (and the musician hears, on a half-pedal-capable instrument)
// a *linear ramp* between control points, so emitting only the points would
// play a slow ramp as a single jump. Between each pair of points we therefore
// emit one event per integer CC64 step the ramp crosses — the densest stream
// that changes the output, and self-thinning for slow ramps. The held value at
// startTime is asserted eagerly in schedulePlayback (see there), so events at
// or before it are intentionally excluded here.
function buildPedalEvents(startTime) {
  const pts = state.pedalPoints;
  const events = [];
  const push = (tick, value) => {
    const t = state.tickToTime(tick);
    if (t > startTime) events.push({ time: t, value });
  };

  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const p0 = pts[i - 1], p1 = pts[i];
      const steps = Math.abs(Math.round(p1.value * 127) - Math.round(p0.value * 127));
      for (let s = 1; s < steps; s++) {
        const f = s / steps;
        push(p0.tick + (p1.tick - p0.tick) * f, p0.value + (p1.value - p0.value) * f);
      }
    }
    push(pts[i].tick, pts[i].value);
  }

  return events; // pts is sorted by tick, so this is sorted by time
}

export const midiOut = new MidiOut();
