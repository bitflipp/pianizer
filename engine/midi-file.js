// engine/midi-file.js
// Standard MIDI File (format 0) export of the current rendition — the same
// notes, mute/solo filtering, re-strike gaps and pedal streams that playback
// sends over Web MIDI, written to bytes instead.
//
// The tempo envelope is a continuous curve with no MIDI equivalent, so rather
// than approximating it with tempo meta events the file uses a fixed 120 BPM
// at PPQ 960 (1920 ticks/second) and places every event at its real time via
// state.tickToTime(). It plays back identically anywhere; the cost is that a
// DAW's bar grid won't line up with the score.

import { RESTRIKE_GAP_MS, CC_SUSTAIN, CC_SOFT_PEDAL, buildPedalEvents, buildSoftPedalEvents } from './midi-out.js';

const PPQ            = 960;
const TEMPO_US       = 500000;            // 120 BPM
const TICKS_PER_SEC  = PPQ * 1e6 / TEMPO_US;

const channelOf = n => (n.channel ?? 0) & 0xf;
const toTicks   = secs => Math.max(0, Math.round(secs * TICKS_PER_SEC));

export function vlq(value) {
  const out = [value & 0x7f];
  while ((value >>= 7) > 0) out.unshift((value & 0x7f) | 0x80);
  return out;
}

const u32 = n => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = n => [(n >>> 8) & 0xff, n & 0xff];
const ascii = s => [...s].map(c => c.charCodeAt(0));

export function buildMidiFile(state) {
  // events: {tick, order, bytes} — order breaks same-tick ties: note-off (0)
  // before control change (1) before note-on (2), so a released key is never
  // re-struck while still held and pedals are set before the notes they affect.
  const events = [];
  const hasSolo = state.notes.some(n => n.soloed);
  const notes = state.notes
    .filter(n => hasSolo ? n.soloed : !n.muted)
    .map(n => ({ n, start: state.tickToTime(n.startTick), end: state.tickToTime(n.endTick) }))
    .sort((a, b) => a.start - b.start);

  // Next onset of the same key (pitch+channel), to leave the re-strike gap.
  const nextStart = new Array(notes.length);
  const lastStart = new Map();
  for (let i = notes.length - 1; i >= 0; i--) {
    const key = (notes[i].n.pitch << 4) | channelOf(notes[i].n);
    nextStart[i] = lastStart.get(key) ?? Infinity;
    lastStart.set(key, notes[i].start);
  }

  const channels = new Set();
  notes.forEach(({ n, start, end }, i) => {
    const ch = channelOf(n);
    channels.add(ch);
    const on  = toTicks(start);
    let   off = end;
    if (nextStart[i] !== Infinity) off = Math.min(off, nextStart[i] - RESTRIKE_GAP_MS / 1000);
    const offTick = Math.max(on + 1, toTicks(off));
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity)));
    events.push({ tick: on,      order: 2, bytes: [0x90 | ch, n.pitch, vel] });
    events.push({ tick: offTick, order: 0, bytes: [0x80 | ch, n.pitch, 0] });
  });

  if (channels.size === 0) channels.add(0);
  // startTime -1 so events at time 0 are included (playback excludes them).
  const pedal = (cc, evs, scale) => {
    for (const { time, value } of evs)
      for (const ch of channels)
        events.push({ tick: toTicks(time), order: 1, bytes: [0xb0 | ch, cc, Math.max(0, Math.min(127, scale(value)))] });
  };
  pedal(CC_SUSTAIN,    buildPedalEvents(-1),     v => Math.round(v * 127));
  pedal(CC_SOFT_PEDAL, buildSoftPedalEvents(-1), v => v);

  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track = [];
  const meta = (type, data) => track.push(0, 0xff, type, ...vlq(data.length), ...data);
  const title = [...new TextEncoder().encode(state.title || 'Pianizer')];
  meta(0x03, title);                       // track name
  meta(0x51, [(TEMPO_US >> 16) & 0xff, (TEMPO_US >> 8) & 0xff, TEMPO_US & 0xff]);
  let prev = 0;
  for (const { tick, bytes } of events) {
    track.push(...vlq(tick - prev), ...bytes);
    prev = tick;
  }
  track.push(0, 0xff, 0x2f, 0);            // end of track

  return new Uint8Array([
    ...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ),
    ...ascii('MTrk'), ...u32(track.length), ...track,
  ]);
}
