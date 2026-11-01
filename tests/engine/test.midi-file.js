import { describe, test, expect } from 'vitest';
import { state } from '../../engine/state.js';
import { buildMidiFile, vlq } from '../../engine/midi-file.js';

// Decode the single track into [{tick, bytes}] (skipping meta events).
function parse(bytes) {
  const dv = new DataView(bytes.buffer);
  expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
  expect(dv.getUint16(8)).toBe(0);
  expect(dv.getUint16(12)).toBe(960);
  expect(String.fromCharCode(...bytes.slice(14, 18))).toBe('MTrk');
  const end = 22 + dv.getUint32(18);
  expect(end).toBe(bytes.length);
  let i = 22, tick = 0;
  const out = [];
  while (i < end) {
    let d = 0, b;
    do { b = bytes[i++]; d = (d << 7) | (b & 0x7f); } while (b & 0x80);
    tick += d;
    if (bytes[i] === 0xff) {
      const type = bytes[i + 1]; let len = bytes[i + 2];
      out.push({ tick, meta: type });
      i += 3 + len;
    } else {
      out.push({ tick, bytes: [...bytes.slice(i, i + 3)] });
      i += 3;
    }
  }
  return out;
}

const load = (notes, extra = {}) => state.loadProject({
  version: 1, ticksPerBeat: 480, tempoMap: [{ tick: 0, bpm: 120, time: 0 }],
  notes, ...extra,
});
const note = (pitch, startTick, endTick, extra = {}) => ({ pitch, velocity: 80, startTick, endTick, ...extra });

describe('vlq', () => {
  test('encodes', () => {
    expect(vlq(0)).toEqual([0]);
    expect(vlq(127)).toEqual([0x7f]);
    expect(vlq(128)).toEqual([0x81, 0x00]);
    expect(vlq(0x3fff)).toEqual([0xff, 0x7f]);
  });
});

describe('buildMidiFile', () => {
  test('writes notes at real time (120 BPM, 480 tpb → 1 beat = 960 ticks)', () => {
    load([note(60, 0, 480)]);
    const ev = parse(buildMidiFile(state)).filter(e => e.bytes);
    expect(ev).toEqual([
      { tick: 0,   bytes: [0x90, 60, 80] },
      { tick: 960, bytes: [0x80, 60, 0] },
    ]);
  });

  test('skips muted notes, and non-soloed ones when any is soloed', () => {
    load([note(60, 0, 480, { muted: true }), note(62, 0, 480), note(64, 0, 480, { soloed: true })]);
    const pitches = parse(buildMidiFile(state)).filter(e => e.bytes?.[0] === 0x90).map(e => e.bytes[1]);
    expect(pitches).toEqual([64]);
  });

  test('releases a key before its re-strike', () => {
    load([note(60, 0, 480), note(60, 480, 960)]);
    const ev = parse(buildMidiFile(state)).filter(e => e.bytes);
    expect(ev.map(e => e.bytes[0])).toEqual([0x90, 0x80, 0x90, 0x80]);
    expect(ev[1].tick).toBeLessThan(ev[2].tick);
  });

  test('includes sustain and soft pedal', () => {
    load([note(60, 0, 480)], {
      pedalPoints: [{ tick: 0, value: 1 }],
      softPedalRegions: [{ startTick: 0, endTick: 480 }],
    });
    const cc = parse(buildMidiFile(state)).filter(e => e.bytes?.[0] === 0xb0).map(e => e.bytes.slice(1));
    expect(cc).toContainEqual([64, 127]);
    expect(cc).toContainEqual([67, 127]);
    expect(cc).toContainEqual([67, 0]);
  });
});
