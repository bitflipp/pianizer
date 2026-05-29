import { describe, test, expect } from 'vitest';
import { AppState } from '../../engine/state.js';

const TPB = 480;

function mkState(notes = []) {
  const s = new AppState();
  s.ticksPerBeat   = TPB;
  s.tempoMap       = [{ tick: 0, bpm: 120 }];
  s.timeSignatures = [{ tick: 0, numerator: 4, denominator: 4 }];
  s.totalTicks     = 9600;
  s.notes          = notes.map(n => ({ ...n }));
  s.loaded         = true;
  return s;
}

function n(startTick, endTick, pitch = 60, velocity = 64) {
  return { pitch, velocity, startTick, endTick, track: 0, channel: 0, articulation: null };
}

// ── addNote ───────────────────────────────────────────────────────────────────

describe('addNote', () => {
  test('appends note with correct fields', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 80);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0]).toMatchObject({ pitch: 60, startTick: 0, endTick: 480, velocity: 80 });
  });

  test('inserted note is selected', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 64);
    expect([...s.selectedNoteIndices]).toContain(0);
  });

  test('notes are sorted by startTick after insert', () => {
    const s = mkState([n(480, 960, 62)]);
    s.addNote(60, 0, 480, 64);
    expect(s.notes[0].startTick).toBe(0);
    expect(s.notes[1].startTick).toBe(480);
  });
});

// ── deleteNotes ───────────────────────────────────────────────────────────────

describe('deleteNotes', () => {
  test('removes the note at the given index', () => {
    const s = mkState([n(0, 480, 60), n(480, 960, 62)]);
    s.deleteNotes([0]);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].pitch).toBe(62);
  });

  test('clears selection', () => {
    const s = mkState([n(0, 480, 60)]);
    s.selectedNoteIndices = new Set([0]);
    s.deleteNotes([0]);
    expect(s.selectedNoteIndices.size).toBe(0);
  });

  test('deleting multiple indices', () => {
    const s = mkState([n(0, 480), n(480, 960), n(960, 1440)]);
    s.deleteNotes([0, 2]);
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].startTick).toBe(480);
  });
});

// ── setNoteVelocities ─────────────────────────────────────────────────────────

describe('setNoteVelocities', () => {
  test('sets velocity on given indices', () => {
    const s = mkState([n(0, 480, 60, 64), n(480, 960, 62, 64)]);
    s.setNoteVelocities([0, 1], 100);
    expect(s.notes[0].velocity).toBe(100);
    expect(s.notes[1].velocity).toBe(100);
  });

  test('clamps below 1', () => {
    const s = mkState([n(0, 480)]);
    s.setNoteVelocities([0], 0);
    expect(s.notes[0].velocity).toBe(1);
  });

  test('clamps above 127', () => {
    const s = mkState([n(0, 480)]);
    s.setNoteVelocities([0], 200);
    expect(s.notes[0].velocity).toBe(127);
  });
});

// ── setNoteArticulations ──────────────────────────────────────────────────────

describe('setNoteArticulations', () => {
  test('sets articulation', () => {
    const s = mkState([n(0, 480)]);
    s.setNoteArticulations([0], 'stacc');
    expect(s.notes[0].articulation).toBe('stacc');
  });

  test('clears articulation with null', () => {
    const s = mkState([{ ...n(0, 480), articulation: 'stacc' }]);
    s.setNoteArticulations([0], null);
    expect(s.notes[0].articulation).toBeNull();
  });
});

// ── setNoteVelocitiesMap ──────────────────────────────────────────────────────

describe('setNoteVelocitiesMap', () => {
  test('sets different velocities per note', () => {
    const s = mkState([n(0, 480), n(480, 960)]);
    s.setNoteVelocitiesMap([[0, 40], [1, 100]]);
    expect(s.notes[0].velocity).toBe(40);
    expect(s.notes[1].velocity).toBe(100);
  });

  test('clamps each value', () => {
    const s = mkState([n(0, 480), n(480, 960)]);
    s.setNoteVelocitiesMap([[0, -5], [1, 300]]);
    expect(s.notes[0].velocity).toBe(1);
    expect(s.notes[1].velocity).toBe(127);
  });
});

// ── moveNotes ─────────────────────────────────────────────────────────────────

describe('moveNotes', () => {
  test('shifts startTick and preserves duration', () => {
    const s = mkState([n(480, 960)]);
    s.moveNotes([0], 0, 480);
    expect(s.notes[0].startTick).toBe(960);
    expect(s.notes[0].endTick).toBe(1440);
  });

  test('clamps startTick at 0', () => {
    const s = mkState([n(100, 580)]);
    s.moveNotes([0], 0, -9999);
    expect(s.notes[0].startTick).toBe(0);
    expect(s.notes[0].endTick).toBe(480);
  });

  test('clamps pitch between 21 and 108', () => {
    const s = mkState([n(0, 480, 21)]);
    s.moveNotes([0], -10, 0);
    expect(s.notes[0].pitch).toBe(21);
    const s2 = mkState([n(0, 480, 108)]);
    s2.moveNotes([0], 10, 0);
    expect(s2.notes[0].pitch).toBe(108);
  });

  test('re-sorts and updates selectedNoteIndices after tick move', () => {
    const s = mkState([n(0, 480, 60), n(960, 1440, 62)]);
    s.selectedNoteIndices = new Set([0]);
    s.moveNotes([0], 0, 1920);
    // note originally at 0 is now last
    expect(s.notes[1].pitch).toBe(60);
    expect([...s.selectedNoteIndices]).toContain(1);
  });
});

// ── resizeNote ────────────────────────────────────────────────────────────────

describe('resizeNote', () => {
  test('sets endTick', () => {
    const s = mkState([n(0, 480)]);
    s.resizeNoteStart();
    s.resizeNote(0, 960);
    expect(s.notes[0].endTick).toBe(960);
  });

  test('endTick cannot go below startTick + 1', () => {
    const s = mkState([n(480, 960)]);
    s.resizeNoteStart();
    s.resizeNote(0, 0);
    expect(s.notes[0].endTick).toBe(481);
  });
});

describe('resizeNoteLeft', () => {
  test('sets startTick', () => {
    const s = mkState([n(0, 480)]);
    s.resizeNoteStart();
    s.resizeNoteLeft(0, 240);
    expect(s.notes[0].startTick).toBe(240);
  });

  test('startTick cannot go below 0', () => {
    const s = mkState([n(0, 480)]);
    s.resizeNoteStart();
    s.resizeNoteLeft(0, -100);
    expect(s.notes[0].startTick).toBe(0);
  });

  test('startTick cannot reach endTick', () => {
    const s = mkState([n(0, 480)]);
    s.resizeNoteStart();
    s.resizeNoteLeft(0, 9999);
    expect(s.notes[0].startTick).toBe(479);
  });
});

// ── pedal / tempo curve CRUD ──────────────────────────────────────────────────

describe('pedal curve', () => {
  test('addPedalPoint inserts sorted', () => {
    const s = mkState();
    s.addPedalPoint(960, 1.0);
    s.addPedalPoint(0, 0.5);
    expect(s.pedalPoints[0].tick).toBe(0);
    expect(s.pedalPoints[1].tick).toBe(960);
  });

  test('addPedalPoint upserts existing tick', () => {
    const s = mkState();
    s.addPedalPoint(0, 0.5);
    s.addPedalPoint(0, 0.8);
    expect(s.pedalPoints).toHaveLength(1);
    expect(s.pedalPoints[0].value).toBe(0.8);
  });

  test('removePedalPointAt removes by index', () => {
    const s = mkState();
    s.addPedalPoint(0, 0.5);
    s.addPedalPoint(960, 1.0);
    s.removePedalPointAt(0);
    expect(s.pedalPoints).toHaveLength(1);
    expect(s.pedalPoints[0].tick).toBe(960);
  });

  test('removePedalPointAt ignores out-of-range index', () => {
    const s = mkState();
    s.addPedalPoint(0, 0.5);
    s.removePedalPointAt(99);
    expect(s.pedalPoints).toHaveLength(1);
  });
});

describe('tempo curve', () => {
  test('addTempoPoint inserts sorted', () => {
    const s = mkState();
    s.addTempoPoint(960, 1.1);
    s.addTempoPoint(0, 0.9);
    expect(s.tempoPoints[0].tick).toBe(0);
    expect(s.tempoPoints[1].tick).toBe(960);
  });

  test('removeTempoPointAt removes by index', () => {
    const s = mkState();
    s.addTempoPoint(0, 0.9);
    s.addTempoPoint(960, 1.1);
    s.removeTempoPointAt(1);
    expect(s.tempoPoints).toHaveLength(1);
    expect(s.tempoPoints[0].tick).toBe(0);
  });
});

// ── saveProject / loadProject ─────────────────────────────────────────────────

describe('project round-trip', () => {
  test('round-trips notes', () => {
    const s = mkState([n(0, 480, 60, 80), n(480, 960, 62, 90)]);
    const s2 = new AppState();
    s2.loadProject(s.saveProject());
    expect(s2.notes).toHaveLength(2);
    expect(s2.notes[0]).toMatchObject({ pitch: 60, startTick: 0, endTick: 480, velocity: 80 });
  });

  test('round-trips pedal and tempo points', () => {
    const s = mkState();
    s.addPedalPoint(0, 0.5);
    s.addTempoPoint(480, 1.1);
    const s2 = new AppState();
    s2.loadProject(s.saveProject());
    expect(s2.pedalPoints).toHaveLength(1);
    expect(s2.pedalPoints[0]).toMatchObject({ tick: 0, value: 0.5 });
    expect(s2.tempoPoints[0]).toMatchObject({ tick: 480, value: 1.1 });
  });

  test('round-trips bookmarks', () => {
    const s = mkState();
    s.addBookmark(960);
    s.addBookmark(1920);
    const s2 = new AppState();
    s2.loadProject(s.saveProject());
    expect(s2.bookmarks).toEqual([960, 1920]);
  });

  test('loadProject recomputes totalTime from tempoMap', () => {
    const s = new AppState();
    s.loadScore([n(0, TPB * 4)], [{ tick: 0, bpm: 120 }], [{ tick: 0, numerator: 4, denominator: 4 }], TPB);
    const proj = s.saveProject();
    proj.totalTime = 999; // stored value should be ignored on load
    const s2 = new AppState();
    s2.loadProject(proj);
    expect(s2.totalTime).toBeCloseTo(2, 5); // 4 beats at 120 bpm = 2 s
  });

  test('loadProject throws on invalid data', () => {
    const s = new AppState();
    expect(() => s.loadProject(null)).toThrow();
    expect(() => s.loadProject({ notes: [] })).toThrow(); // missing version
  });
});

// ── undo / redo ───────────────────────────────────────────────────────────────

describe('undo/redo', () => {
  test('canUndo is false on a fresh state', () => {
    expect(mkState().canUndo).toBe(false);
  });

  test('canUndo is true after a mutation', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 64);
    expect(s.canUndo).toBe(true);
  });

  test('undo restores prior state', () => {
    const s = mkState([n(0, 480, 60)]);
    s.addNote(62, 480, 960, 64);
    s.undo();
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].pitch).toBe(60);
  });

  test('canRedo is true after undo', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 64);
    s.undo();
    expect(s.canRedo).toBe(true);
  });

  test('redo re-applies the undone change', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 64);
    s.undo();
    s.redo();
    expect(s.notes).toHaveLength(1);
    expect(s.notes[0].pitch).toBe(60);
  });

  test('new mutation clears the redo stack', () => {
    const s = mkState();
    s.addNote(60, 0, 480, 64);
    s.undo();
    s.addNote(62, 0, 480, 64); // new edit
    expect(s.canRedo).toBe(false);
  });

  test('undo across multiple mutations', () => {
    const s = mkState([n(0, 480, 60)]);
    s.setNoteVelocities([0], 100);
    s.setNoteVelocities([0], 120);
    s.undo();
    expect(s.notes[0].velocity).toBe(100);
    s.undo();
    expect(s.notes[0].velocity).toBe(64);
  });

  test('undo stack is capped at 100 entries', () => {
    const s = mkState([n(0, 480)]);
    for (let i = 0; i < 110; i++) s.setNoteVelocities([0], (i % 127) + 1);
    expect(s._undoStack.length).toBe(100);
  });

  test('undo stack is cleared on load', () => {
    const s = mkState([n(0, 480)]);
    s.addNote(62, 480, 960, 64);
    s.loadProject(s.saveProject());
    expect(s.canUndo).toBe(false);
  });

  test('undo restores pedal points', () => {
    const s = mkState();
    s.addPedalPoint(0, 0.5);
    s.undo();
    expect(s.pedalPoints).toHaveLength(0);
  });

  test('undo restores tempo points', () => {
    const s = mkState();
    s.addTempoPoint(0, 1.1);
    s.undo();
    expect(s.tempoPoints).toHaveLength(0);
  });
});
