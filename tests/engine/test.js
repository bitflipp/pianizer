import { describe, test, expect } from 'vitest';
import { AppState, interpolateCurveAtTick, snapGridTicks, SNAP_GRIDS } from '../../engine/state.js';

const TPB = 480;

function mkState({ tpb = TPB, timeSigs = [], tempoMap = [], tempoPoints = [] } = {}) {
  const s = new AppState();
  s.ticksPerBeat   = tpb;
  s.timeSignatures = timeSigs;
  s.tempoMap       = tempoMap;
  s.tempoPoints    = tempoPoints;
  return s;
}

// ── snapGridTicks ─────────────────────────────────────────────────────────────

describe('snapGridTicks', () => {
  test('1/1',   () => expect(snapGridTicks('1/1',   TPB)).toBe(1920));
  test('1/2',   () => expect(snapGridTicks('1/2',   TPB)).toBe(960));
  test('1/4',   () => expect(snapGridTicks('1/4',   TPB)).toBe(480));
  test('1/8',   () => expect(snapGridTicks('1/8',   TPB)).toBe(240));
  test('1/8T',  () => expect(snapGridTicks('1/8T',  TPB)).toBe(320));
  test('1/16',  () => expect(snapGridTicks('1/16',  TPB)).toBe(120));
  test('1/16T', () => expect(snapGridTicks('1/16T', TPB)).toBe(160));
  test('1/32',  () => expect(snapGridTicks('1/32',  TPB)).toBe(60));
  test('1/32T', () => expect(snapGridTicks('1/32T', TPB)).toBe(80));
  test('all entries handled', () => {
    for (const g of SNAP_GRIDS) expect(snapGridTicks(g, TPB)).toBeGreaterThan(0);
  });
});

// ── interpolateCurveAtTick ────────────────────────────────────────────────────

describe('interpolateCurveAtTick', () => {
  test('empty → fallback', () =>
    expect(interpolateCurveAtTick([], 100, 7)).toBe(7));

  test('before first point → clamp to first value', () =>
    expect(interpolateCurveAtTick([{ tick: 100, value: 0.5 }], 0, 0)).toBe(0.5));

  test('after last point → clamp to last value', () =>
    expect(interpolateCurveAtTick([{ tick: 100, value: 0.5 }], 999, 0)).toBe(0.5));

  test('exact hit', () =>
    expect(interpolateCurveAtTick([{ tick: 0, value: 0.2 }, { tick: 200, value: 0.8 }], 0, 0)).toBe(0.2));

  test('midpoint', () =>
    expect(interpolateCurveAtTick([{ tick: 0, value: 0 }, { tick: 100, value: 1 }], 50, 0)).toBeCloseTo(0.5));

  test('three-point, second segment', () => {
    const pts = [{ tick: 0, value: 0 }, { tick: 100, value: 1 }, { tick: 200, value: 0 }];
    expect(interpolateCurveAtTick(pts, 150, 0)).toBeCloseTo(0.5);
  });
});

// ── barBoundaries ─────────────────────────────────────────────────────────────

describe('barBoundaries', () => {
  test('4/4, first 3 bars', () => {
    const s = mkState({ timeSigs: [{ tick: 0, numerator: 4, denominator: 4 }] });
    const bars = s.barBoundaries(0, 1920 * 3);
    expect(bars[0]).toMatchObject({ tick: 0,    bar: 1 });
    expect(bars[1]).toMatchObject({ tick: 1920, bar: 2 });
    expect(bars[2]).toMatchObject({ tick: 3840, bar: 3 });
  });

  test('3/4 bar width = 3 beats', () => {
    const s = mkState({ timeSigs: [{ tick: 0, numerator: 3, denominator: 4 }] });
    const bars = s.barBoundaries(0, 1440 * 2);
    expect(bars[1].tick).toBe(1440);
  });

  test('6/8 bar width = 3 beats', () => {
    const s = mkState({ timeSigs: [{ tick: 0, numerator: 6, denominator: 8 }] });
    const bars = s.barBoundaries(0, 1440 * 2);
    expect(bars[1].tick).toBe(1440);
  });

  test('empty timeSigs defaults to 4/4', () => {
    const s = mkState({ timeSigs: [] });
    const bars = s.barBoundaries(0, 1920 * 2);
    expect(bars[0]).toMatchObject({ tick: 0,    bar: 1 });
    expect(bars[1]).toMatchObject({ tick: 1920, bar: 2 });
  });

  test('time sig change at bar 3', () => {
    const s = mkState({ timeSigs: [
      { tick: 0,    numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 3, denominator: 4 },
    ]});
    const bars = s.barBoundaries(0, 3840 + 1440);
    expect(bars[2]).toMatchObject({ tick: 3840, bar: 3 });
    expect(bars[3]).toMatchObject({ tick: 5280, bar: 4 });
  });

  test('range starting mid-bar excludes bar start', () => {
    const s = mkState({ timeSigs: [{ tick: 0, numerator: 4, denominator: 4 }] });
    const bars = s.barBoundaries(960, 3840);
    expect(bars[0]).toMatchObject({ tick: 1920, bar: 2 });
  });

  test('bar numbers correct after skipped early segment', () => {
    const s = mkState({ timeSigs: [{ tick: 0, numerator: 4, denominator: 4 }] });
    const bars = s.barBoundaries(7680, 9600);
    expect(bars[0]).toMatchObject({ tick: 7680, bar: 5 });
  });
});

// ── snapTick ──────────────────────────────────────────────────────────────────

describe('snapTick', () => {
  test('1/8, snap down', () => {
    const s = mkState(); s.snapGrid = '1/8';
    expect(s.snapTick(100)).toBe(0);
  });

  test('1/8, snap up', () => {
    const s = mkState(); s.snapGrid = '1/8';
    expect(s.snapTick(200)).toBe(240);
  });

  test('already on grid', () => {
    const s = mkState(); s.snapGrid = '1/4';
    expect(s.snapTick(480)).toBe(480);
  });
});

// ── tick↔time (no tempo curve) ────────────────────────────────────────────────

describe('baseTickToTime', () => {
  test('tick 0 → 0', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }] });
    expect(s.baseTickToTime(0)).toBeCloseTo(0);
  });

  test('1 beat at 120 bpm = 0.5 s', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }] });
    expect(s.baseTickToTime(TPB)).toBeCloseTo(0.5);
  });

  test('tempo change mid-piece', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }, { tick: TPB, bpm: 60 }] });
    expect(s.baseTickToTime(TPB * 2)).toBeCloseTo(1.5);
  });

  test('round-trip (no curve)', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }] });
    s.totalTicks = 9600;
    expect(s.timeToTick(s.tickToTime(1234))).toBeCloseTo(1234, 0);
  });
});

// ── curvedTickToTime ──────────────────────────────────────────────────────────

describe('curvedTickToTime', () => {
  test('no tempo points = baseTickToTime', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }], tempoPoints: [] });
    expect(s.curvedTickToTime(TPB)).toBeCloseTo(s.baseTickToTime(TPB), 10);
  });

  test('constant ratio > 1 → shorter time', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }],
                        tempoPoints: [{ tick: 0, value: 1.5 }, { tick: 9600, value: 1.5 }] });
    expect(s.curvedTickToTime(TPB)).toBeLessThan(s.baseTickToTime(TPB));
  });

  test('constant ratio 1.5 = base / 1.5', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }],
                        tempoPoints: [{ tick: 0, value: 1.5 }, { tick: 9600, value: 1.5 }] });
    expect(s.curvedTickToTime(TPB)).toBeCloseTo(s.baseTickToTime(TPB) / 1.5, 9);
  });

  test('constant ratio < 1 → longer time', () => {
    const s = mkState({ tempoMap: [{ tick: 0, bpm: 120 }],
                        tempoPoints: [{ tick: 0, value: 0.5 }, { tick: 9600, value: 0.5 }] });
    expect(s.curvedTickToTime(TPB)).toBeGreaterThan(s.baseTickToTime(TPB));
  });

  test('round-trip with varying curve', () => {
    const s = mkState({
      tempoMap:    [{ tick: 0, bpm: 120 }],
      tempoPoints: [{ tick: 0, value: 1.0 }, { tick: TPB, value: 1.2 }, { tick: TPB * 2, value: 1.0 }],
    });
    s.totalTicks = 9600;
    expect(s.timeToTick(s.curvedTickToTime(720))).toBeCloseTo(720, 0);
  });

  // A run of baseline (1.0) points must stay exactly at base time — the rubato
  // balance feature depends on the monotone spline keeping flats flat.
  test('all-baseline region preserves base time', () => {
    const s = mkState({
      tempoMap:    [{ tick: 0, bpm: 120 }],
      tempoPoints: [{ tick: 0, value: 1.0 }, { tick: TPB, value: 1.0 }, { tick: TPB * 2, value: 1.0 }],
    });
    expect(s.curvedTickToTime(TPB * 2)).toBeCloseTo(s.baseTickToTime(TPB * 2), 9);
  });

  // PCHIP must not overshoot: between a baseline anchor and a peak the ratio
  // stays within [1.0, 1.2], so the curved time never runs faster than the peak
  // ratio nor slower than baseline would allow.
  test('monotone spline does not overshoot the point range', () => {
    const s = mkState({
      tempoMap:    [{ tick: 0, bpm: 120 }],
      tempoPoints: [{ tick: 0, value: 1.0 }, { tick: TPB, value: 1.2 }, { tick: TPB * 2, value: 1.2 }],
    });
    for (let tk = 0; tk <= TPB * 2; tk += 40) {
      const r = s._tempoValueAtTick(tk);
      expect(r).toBeGreaterThanOrEqual(1.0 - 1e-9);
      expect(r).toBeLessThanOrEqual(1.2 + 1e-9);
    }
  });

  // Smooth, not piecewise-linear: a symmetric 1.0→1.2→1.0 arch has a zero-slope
  // apex, so the spline eases into the peak (mirror-symmetric about it) and is
  // distinct from the linear interpolant.
  test('spline eases into a symmetric apex', () => {
    const s = mkState({
      tempoMap:    [{ tick: 0, bpm: 120 }],
      tempoPoints: [{ tick: 0, value: 1.0 }, { tick: TPB, value: 1.2 }, { tick: TPB * 2, value: 1.0 }],
    });
    // Mirror symmetry about the apex at TPB.
    for (const d of [40, 120, 200]) {
      expect(s._tempoValueAtTick(TPB - d)).toBeCloseTo(s._tempoValueAtTick(TPB + d), 9);
    }
    // Eased, not linear: the apex flattens, so the midpoint sits above the
    // straight-line 1.1 the old interpolant would have given.
    expect(s._tempoValueAtTick(TPB / 2)).toBeGreaterThan(1.1);
    // Zero slope at the apex.
    expect(s._tempoValueAtTick(TPB - 1)).toBeLessThan(s._tempoValueAtTick(TPB));
    expect(s._tempoValueAtTick(TPB + 1)).toBeLessThan(s._tempoValueAtTick(TPB));
  });
});
