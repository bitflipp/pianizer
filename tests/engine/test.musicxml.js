// @vitest-environment happy-dom
import { describe, test, expect } from 'vitest';
import { parseMusicXml } from '../../engine/musicxml.js';

// ── XML builder helpers ───────────────────────────────────────────────────────

function score(partsContent) {
  const ids = partsContent.map((_, i) => `P${i + 1}`);
  const partList = ids.map(id => `<score-part id="${id}"><part-name>${id}</part-name></score-part>`).join('');
  const parts    = ids.map((id, i) => `<part id="${id}">${partsContent[i]}</part>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><score-partwise><part-list>${partList}</part-list>${parts}</score-partwise>`;
}

// Shorthand: single-part score
function sp(content) { return score([content]); }

function attrs({ divs = 480, beats = 4, beatType = 4 } = {}) {
  return `<attributes><divisions>${divs}</divisions><time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time></attributes>`;
}

function note(step, octave, dur, { alter = 0, chord = false, grace = false,
    tieStop = false, tieStart = false, tremolo = null, voice = null, tupletActual = null } = {}) {
  let s = '<note>';
  if (grace) s += '<grace/>';
  if (chord) s += '<chord/>';
  s += `<pitch><step>${step}</step>`;
  if (alter) s += `<alter>${alter}</alter>`;
  s += `<octave>${octave}</octave></pitch><duration>${dur}</duration>`;
  if (tieStop)  s += '<tie type="stop"/>';
  if (tieStart) s += '<tie type="start"/>';
  if (voice != null) s += `<voice>${voice}</voice>`;
  if (tremolo)  s += `<tremolo type="${tremolo.type}">${tremolo.slashes}</tremolo>`;
  if (tupletActual != null) {
    s += `<notations><tuplet type="start"><tuplet-actual><tuplet-number>${tupletActual}</tuplet-number></tuplet-actual></tuplet></notations>`;
  }
  return s + '</note>';
}

function rest(dur) {
  return `<note><rest/><duration>${dur}</duration></note>`;
}

function sound({ tempo, dynamics } = {}) {
  const attrs2 = [tempo && `tempo="${tempo}"`, dynamics && `dynamics="${dynamics}"`].filter(Boolean).join(' ');
  return `<direction><sound ${attrs2}/></direction>`;
}

// ── pitchToMidi ───────────────────────────────────────────────────────────────

describe('pitchToMidi', () => {
  function pitchOf(step, octave, alter) {
    const xml = sp(`<measure number="1">${attrs()}${note(step, octave, 480, { alter })}</measure>`);
    return parseMusicXml(xml).notes[0].pitch;
  }

  test('C4 = 60', () => expect(pitchOf('C', 4)).toBe(60));
  test('A4 = 69', () => expect(pitchOf('A', 4)).toBe(69));
  test('C0 = 12', () => expect(pitchOf('C', 0)).toBe(12));
  test('sharp adds 1', () => expect(pitchOf('C', 4, 1)).toBe(61));
  test('flat subtracts 1', () => expect(pitchOf('B', 4, -1)).toBe(70));
});

// ── basic parsing ─────────────────────────────────────────────────────────────

describe('basic parsing', () => {
  test('single note gets correct tick and duration', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ startTick: 0, endTick: 480 });
  });

  test('two sequential notes have correct startTicks', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480)}${note('D', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes[0].startTick).toBe(0);
    expect(notes[1].startTick).toBe(480);
  });

  test('notes sorted by startTick', () => {
    // Put D before C in the XML via backup, so D starts later but C comes first after sort
    const xml = sp(`<measure number="1">${attrs()}${note('D', 4, 480)}${note('C', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes[0].startTick).toBeLessThanOrEqual(notes[1].startTick);
  });

  test('default tempo is 120 bpm when absent', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480)}</measure>`);
    const { tempoMap } = parseMusicXml(xml);
    expect(tempoMap[0]).toMatchObject({ tick: 0, bpm: 120 });
  });

  test('default time signature is 4/4 when absent', () => {
    const xml = sp(`<measure number="1"><attributes><divisions>480</divisions></attributes>${note('C', 4, 480)}</measure>`);
    const { timeSigs } = parseMusicXml(xml);
    expect(timeSigs[0]).toMatchObject({ numerator: 4, denominator: 4 });
  });

  test('tpb comes from first <divisions>', () => {
    const xml = sp(`<measure number="1">${attrs({ divs: 960 })}${note('C', 4, 960)}</measure>`);
    const { tpb } = parseMusicXml(xml);
    expect(tpb).toBe(960);
  });

  test('low divisions are scaled up to at least 480 tpb', () => {
    // divisions=2: a quarter note has duration 2 — useless tick resolution raw,
    // so tpb is scaled by an integer factor (×240 → 480) and durations follow.
    const xml = sp(`<measure number="1">${attrs({ divs: 2 })}${note('C', 4, 2)}</measure>`);
    const { tpb, notes } = parseMusicXml(xml);
    expect(tpb).toBe(480);
    expect(notes[0]).toMatchObject({ startTick: 0, endTick: 480 });
  });

  test('grace notes are skipped', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 60, { grace: true })}${note('D', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].pitch).toBe(62); // D4
  });

  test('rest advances tick but produces no note', () => {
    const xml = sp(`<measure number="1">${attrs()}${rest(480)}${note('C', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].startTick).toBe(480);
  });

  test('chord notes share the same startTick', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480)}${note('E', 4, 480, { chord: true })}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(2);
    expect(notes[0].startTick).toBe(notes[1].startTick);
  });
});

// ── tempo and dynamics ────────────────────────────────────────────────────────

describe('tempo and dynamics', () => {
  test('reads tempo from <sound tempo="">', () => {
    const xml = sp(`<measure number="1">${attrs()}${sound({ tempo: 100 })}${note('C', 4, 480)}</measure>`);
    const { tempoMap } = parseMusicXml(xml);
    expect(tempoMap.some(e => Math.abs(e.bpm - 100) < 0.01)).toBe(true);
  });

  test('reads dynamics and maps to velocity', () => {
    const xml = sp(`<measure number="1">${attrs()}${sound({ dynamics: '90' })}${note('C', 4, 480)}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes[0].velocity).toBe(90);
  });

  test('time signature is parsed correctly', () => {
    const xml = sp(`<measure number="1">${attrs({ beats: 3, beatType: 4 })}${note('C', 4, 480)}</measure>`);
    const { timeSigs } = parseMusicXml(xml);
    expect(timeSigs[0]).toMatchObject({ numerator: 3, denominator: 4 });
  });
});

// ── ties ──────────────────────────────────────────────────────────────────────

describe('ties', () => {
  test('tied notes merge into one with extended endTick', () => {
    const xml = sp(
      `<measure number="1">${attrs()}${note('C', 4, 480, { tieStart: true })}</measure>` +
      `<measure number="2">${note('C', 4, 480, { tieStop: true })}</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].endTick).toBe(960);
  });

  test('three-note tie chain merges into one', () => {
    const xml = sp(
      `<measure number="1">${attrs()}${note('C', 4, 480, { tieStart: true })}</measure>` +
      `<measure number="2">${note('C', 4, 480, { tieStop: true, tieStart: true })}</measure>` +
      `<measure number="3">${note('C', 4, 480, { tieStop: true })}</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
    expect(notes[0].endTick).toBe(1440);
  });

  test('ties in different voices on the same pitch do not collide', () => {
    const m1 = `<measure number="1">${attrs()}` +
      note('C', 4, 480, { tieStart: true, voice: 1 }) +
      `<backup><duration>480</duration></backup>` +
      note('C', 4, 480, { tieStart: true, voice: 2 }) +
      `</measure>`;
    const m2 = `<measure number="2">` +
      note('C', 4, 480, { tieStop: true, voice: 1 }) +
      `<backup><duration>480</duration></backup>` +
      note('C', 4, 480, { tieStop: true, voice: 2 }) +
      `</measure>`;
    const { notes } = parseMusicXml(sp(m1 + m2));
    expect(notes).toHaveLength(2);
    expect(notes.every(n => n.endTick === 960)).toBe(true);
  });
});

// ── backup / forward ──────────────────────────────────────────────────────────

describe('backup / forward', () => {
  test('backup enables second voice at same tick', () => {
    const xml = sp(
      `<measure number="1">${attrs()}` +
      `${note('C', 4, 480)}` +           // tick 0 → 480
      `<backup><duration>480</duration></backup>` +
      `${note('G', 4, 480)}` +           // tick 0 → 480 (chord-like, different voice)
      `</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(2);
    expect(notes[0].startTick).toBe(0);
    expect(notes[1].startTick).toBe(0);
  });

  test('forward skips ticks', () => {
    const xml = sp(
      `<measure number="1">${attrs()}` +
      `<forward><duration>480</duration></forward>` +
      `${note('C', 4, 480)}` +
      `</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes[0].startTick).toBe(480);
  });
});

// ── multi-measure rest ────────────────────────────────────────────────────────

describe('multiple-rest', () => {
  test('advances tick to cover all N measures', () => {
    const xml = sp(
      `<measure number="1">` +
        `<attributes><divisions>480</divisions><time><beats>4</beats><beat-type>4</beat-type></time>` +
        `<measure-style><multiple-rest>4</multiple-rest></measure-style></attributes>` +
        `${rest(480)}` +   // only 1 beat in XML, but 4 full measures should be consumed
      `</measure>` +
      `<measure number="5">${note('C', 4, 480)}</measure>`
    );
    const { notes } = parseMusicXml(xml);
    // After 4 measures of 4/4 at tpb=480, tick = 4*1920 = 7680
    expect(notes[0].startTick).toBe(7680);
  });
});

// ── multi-part ────────────────────────────────────────────────────────────────

describe('multi-part', () => {
  test('two parts get different channels', () => {
    const meas = `<measure number="1">${attrs()}${note('C', 4, 480)}</measure>`;
    const xml  = score([meas, meas]);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(2);
    const channels = new Set(notes.map(n => n.channel));
    expect(channels.size).toBe(2);
  });

  test('tempo comes from first part only', () => {
    const meas1 = `<measure number="1">${attrs()}${sound({ tempo: 90 })}${note('C', 4, 480)}</measure>`;
    const meas2 = `<measure number="1">${attrs()}${sound({ tempo: 200 })}${note('C', 4, 480)}</measure>`;
    const xml   = score([meas1, meas2]);
    const { tempoMap } = parseMusicXml(xml);
    expect(tempoMap.some(e => Math.abs(e.bpm - 90) < 0.01)).toBe(true);
    expect(tempoMap.some(e => Math.abs(e.bpm - 200) < 0.01)).toBe(false);
  });
});

// ── tremolo ───────────────────────────────────────────────────────────────────

describe('tremolo', () => {
  test('single tremolo with 2 slashes expands to 4 strokes at 480 tpb', () => {
    // 2 slashes → strokeDur = 480/4 = 120; durTick=480 → 4 strokes
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480, { tremolo: { type: 'single', slashes: 2 } })}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(4);
    expect(notes.every(n => n.pitch === 60)).toBe(true);
    expect(notes[0].startTick).toBe(0);
    expect(notes[3].endTick).toBe(480);
  });

  test('two-note tremolo alternates pitches', () => {
    // start C4 + stop E4, 2 slashes: combinedDur=960, strokeDur=120 → 8 strokes
    const xml = sp(
      `<measure number="1">${attrs()}` +
      `${note('C', 4, 480, { tremolo: { type: 'start', slashes: 2 } })}` +
      `${note('E', 4, 480, { tremolo: { type: 'stop',  slashes: 2 } })}` +
      `</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(8);
    // even-indexed strokes: C4 (60), odd: E4 (64)
    expect(notes[0].pitch).toBe(60);
    expect(notes[1].pitch).toBe(64);
    expect(notes[6].pitch).toBe(60);
    expect(notes[7].pitch).toBe(64);
  });

  test('unmeasured tremolo falls through to normal note', () => {
    const xml = sp(`<measure number="1">${attrs()}${note('C', 4, 480, { tremolo: { type: 'unmeasured', slashes: 0 } })}</measure>`);
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(1);
  });

  test('tuplet-actual overrides slash-derived stroke count (sextuplet written as a 2-note tremolo)', () => {
    // 2/4, divisions=120 → tpb scales to 480. Two notes of duration 60 (=1 beat combined),
    // 2 slashes would naively compute 4 strokes/beat — but tuplet-actual=6 (MuseScore's
    // idiom for a sextuplet written as two tremolo noteheads) overrides that to 6.
    const xml = sp(
      `<measure number="1">${attrs({ divs: 120, beats: 2, beatType: 4 })}` +
      `${note('G', 3, 60, { alter: 1, tremolo: { type: 'start', slashes: 2 }, tupletActual: 6 })}` +
      `${note('A', 3, 60, { tremolo: { type: 'stop', slashes: 2 } })}` +
      `</measure>`
    );
    const { notes } = parseMusicXml(xml);
    expect(notes).toHaveLength(6);
    expect(notes[0].pitch).toBe(56); // G#3
    expect(notes[1].pitch).toBe(57); // A3
    expect(notes[0].startTick).toBe(0);
    expect(notes[5].endTick).toBe(480); // full beat (tpb) spanned by all 6 strokes
  });
});
