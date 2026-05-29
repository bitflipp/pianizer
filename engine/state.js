// engine/state.js
// Single source of truth. The canvas engine reads and writes here.
// The toolbar custom element reads via events dispatched from here.

export class AppState extends EventTarget {
  constructor() {
    super();

    this.loaded = false;
    this.notes = [];           // NoteEvent[]
    this.tempoMap = [];        // [{tick, bpm, time}]
    this.timeSignatures = [];  // [{tick, numerator, denominator}]
    this.ticksPerBeat = 480;
    this.totalTicks = 0;
    this.totalTime = 0;        // seconds

    // Selection
    this.selectedNoteIndices = new Set(); // Set<int>

    // Playback
    this.playing = false;
    this.playheadTime = 0;     // seconds

    this.snapGrid = '1/8';     // current snap resolution

    // Bookmarks — [tick] sorted, navigation only (not part of undo)
    this.bookmarks = [];

    // Pedal curve — [{tick, value}] sorted by tick, value 0–1
    this.pedalPoints = [];

    // Tempo envelope — [{tick, value}] sorted by tick, value 0.8–1.2
    this.tempoPoints = [];

    this.pieceId = null;

    // Undo / redo stacks — each entry is {notes, pedalPoints, tempoPoints}
    this._undoStack = [];
    this._redoStack = [];

    // Per-pitch velocity offset (device calibration), pitch 21-108 → index 0-87
    this.velocityCurve = new Array(88).fill(0);

    // Playback speed multiplier (piece-specific view setting, persisted separately)
    this.playSpeed = 1.0;
  }

  // ── Notes ──────────────────────────────────────────────────────────

  loadScore(notes, tempoMap, timeSigs, tpb) {
    this.notes          = notes.slice().sort((a, b) => a.startTick - b.startTick);
    this.tempoMap       = tempoMap;
    this.timeSignatures = timeSigs;
    this.ticksPerBeat   = tpb;
    this.totalTicks     = Math.max(...notes.map(n => n.endTick));
    this.pedalPoints    = [];
    this.tempoPoints    = [];
    this.bookmarks      = [];
    this.pieceId        = crypto.randomUUID();
    this._finishLoad();
  }

  // Common tail of loadScore and loadProject: derive totalTime, reset session
  // state, dispatch load events.
  _finishLoad() {
    this.totalTime           = this.tickToTime(this.totalTicks);
    this.loaded              = true;
    this.selectedNoteIndices = new Set();
    this.playheadTime        = 0;
    this._undoStack          = [];
    this._redoStack          = [];
    this.dispatch('loaded');
    this.dispatch('undochanged');
  }

  // ── Selection ──────────────────────────────────────────────────────

  setSelection(indices) {
    this._pushUndo();
    this.selectedNoteIndices = new Set(indices);
    this.dispatch('selectionchanged');
  }

  setNoteVelocities(indices, velocity) {
    this._pushUndo();
    const v = clampVelocity(velocity);
    for (const i of indices) {
      if (this.notes[i]) this.notes[i].velocity = v;
    }
    this.dispatch('selectionchanged');
  }

  setNoteArticulations(indices, articulation) {
    this._pushUndo();
    for (const i of indices) {
      if (this.notes[i]) this.notes[i].articulation = articulation;
    }
    this.dispatch('selectionchanged');
  }

  setNoteVelocitiesMap(pairs) {
    this._pushUndo();
    for (const [i, v] of pairs) {
      if (this.notes[i]) this.notes[i].velocity = clampVelocity(v);
    }
    this.dispatch('selectionchanged');
  }

  setVelocityCurve(curve) {
    this.velocityCurve = curve.slice();
    this.dispatch('velocitycurvechanged');
  }

  addBookmark(tick) {
    if (!this.bookmarks.includes(tick)) {
      this.bookmarks.push(tick);
      this.bookmarks.sort((a, b) => a - b);
    }
    this.dispatch('bookmarkschanged');
  }

  removeBookmark(index) {
    this.bookmarks.splice(index, 1);
    this.dispatch('bookmarkschanged');
  }

  saveProject() {
    return {
      version:        1,
      pieceId:        this.pieceId,
      ticksPerBeat:   this.ticksPerBeat,
      tempoMap:       this.tempoMap.map(s => ({ tick: s.tick, bpm: s.bpm, time: s.time ?? 0 })),
      timeSignatures: this.timeSignatures.map(s => ({ tick: s.tick, numerator: s.numerator, denominator: s.denominator })),
      totalTicks:     this.totalTicks,
      totalTime:      this.totalTime,
      notes:          this.notes.map(n => ({ pitch: n.pitch, velocity: n.velocity, startTick: n.startTick, endTick: n.endTick, track: n.track ?? 0, channel: n.channel ?? 0, articulation: n.articulation ?? null })),
      pedalPoints:    this.pedalPoints.map(p => ({ tick: p.tick, value: p.value })),
      tempoPoints:    this.tempoPoints.map(p => ({ tick: p.tick, value: p.value })),
      bookmarks:      this.bookmarks.slice(),
    };
  }

  loadProject(data) {
    if (!data || typeof data.version !== 'number') throw new Error('Invalid project file');
    this.notes          = (data.notes ?? []).map(n => ({ ...n })).sort((a, b) => a.startTick - b.startTick);
    this.tempoMap       = (data.tempoMap ?? [{ tick: 0, bpm: 120, time: 0 }]).map(s => ({ ...s }));
    this.timeSignatures = (data.timeSignatures ?? [{ tick: 0, numerator: 4, denominator: 4 }]).map(s => ({ ...s }));
    this.ticksPerBeat   = data.ticksPerBeat ?? 480;
    this.totalTicks     = data.totalTicks ?? (this.notes.length ? Math.max(...this.notes.map(n => n.endTick)) : 0);
    this.pedalPoints    = (data.pedalPoints ?? []).map(p => ({ ...p }));
    this.tempoPoints    = (data.tempoPoints ?? []).map(p => ({ ...p }));
    this.bookmarks      = (data.bookmarks  ?? []).map(Number).sort((a, b) => a - b);
    this.pieceId        = data.pieceId ?? crypto.randomUUID();
    this._finishLoad();
  }

  // ── Time / tick conversion ─────────────────────────────────────────

  tickToTime(tick) {
    if (this.tempoPoints.length === 0) return this.baseTickToTime(tick);
    return this.curvedTickToTime(tick);
  }

  timeToTick(time) {
    if (this.tempoPoints.length === 0) return this._baseTimeToTick(time);
    // Binary search on the curved mapping
    let lo = 0, hi = Math.max(this.totalTicks * 1.1 + 960, 1e5);
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (this.curvedTickToTime(mid) < time) lo = mid; else hi = mid;
      if (hi - lo < 0.5) break;
    }
    return Math.round((lo + hi) / 2);
  }

  // tick→time using only the step-wise tempoMap (ignores the tempo envelope).
  baseTickToTime(tick) {
    let t = 0, lastTick = 0, lastBpm = 120;
    for (const seg of this.tempoMap) {
      if (seg.tick >= tick) break;
      t += (seg.tick - lastTick) / this.ticksPerBeat * (60 / lastBpm);
      lastTick = seg.tick;
      lastBpm = seg.bpm;
    }
    t += (tick - lastTick) / this.ticksPerBeat * (60 / lastBpm);
    return t;
  }

  _baseTimeToTick(time) {
    let t = 0, lastTick = 0, lastBpm = 120;
    for (const seg of this.tempoMap) {
      const segTime = this.baseTickToTime(seg.tick);
      if (segTime >= time) break;
      t = segTime;
      lastTick = seg.tick;
      lastBpm = seg.bpm;
    }
    const remaining = time - t;
    return Math.round(lastTick + remaining * this.ticksPerBeat * lastBpm / 60);
  }

  // BPM from tempoMap at a given tick (step-wise, no interpolation).
  _baseBpmAtTick(tick) {
    let bpm = 120;
    for (const seg of this.tempoMap) {
      if (seg.tick > tick) break;
      bpm = seg.bpm;
    }
    return bpm;
  }

  // Linearly interpolated tempo ratio at a given tick. Defaults to 1 (no scaling).
  _tempoValueAtTick(tick) {
    return interpolateCurveAtTick(this.tempoPoints, tick, 1);
  }

  // tick→time integrating both tempoMap and tempo envelope.
  // Within each sub-segment baseBpm is constant and ratio is linear, so the
  // integral has a closed-form solution via ln(r1/r0)/(r1-r0).
  curvedTickToTime(tick) {
    if (tick <= 0) return 0;
    const tpb = this.ticksPerBeat;
    const breaks = new Set([0, tick]);
    for (const seg of this.tempoMap)    { if (seg.tick > 0 && seg.tick < tick) breaks.add(seg.tick); }
    for (const pt  of this.tempoPoints) { if (pt.tick  > 0 && pt.tick  < tick) breaks.add(pt.tick); }
    const sorted = [...breaks].sort((a, b) => a - b);

    let t = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const tick0 = sorted[i], tick1 = sorted[i + 1];
      const D     = tick1 - tick0;
      const baseBpm = this._baseBpmAtTick(tick0);
      const r0 = this._tempoValueAtTick(tick0);
      const r1 = this._tempoValueAtTick(tick1);
      const scale = D * 60 / (tpb * baseBpm); // time if ratio=1
      if (Math.abs(r1 - r0) < 1e-9) {
        t += scale / r0;
      } else {
        t += scale * Math.log(r1 / r0) / (r1 - r0);
      }
    }
    return t;
  }

  // ── Note editing ───────────────────────────────────────────────────

  deleteNotes(indices) {
    this._pushUndo();
    const toDelete = new Set(indices);
    this.notes = this.notes.filter((_, i) => !toDelete.has(i));
    this.selectedNoteIndices = new Set();
    this.dispatch('selectionchanged');
  }

  // deltaPitch and deltaTick may each be 0.
  moveNotes(indices, deltaPitch, deltaTick) {
    this._pushUndo();
    const moved = indices.map(i => this.notes[i]).filter(Boolean);
    for (const n of moved) {
      if (deltaPitch) n.pitch = Math.max(21, Math.min(108, n.pitch + deltaPitch));
      if (deltaTick) {
        const dur = n.endTick - n.startTick;
        n.startTick = Math.max(0, n.startTick + deltaTick);
        n.endTick   = n.startTick + dur;
      }
    }
    if (deltaTick) {
      this.notes.sort((a, b) => a.startTick - b.startTick);
      const movedSet = new Set(moved);
      this.selectedNoteIndices = new Set(
        this.notes.flatMap((n, i) => movedSet.has(n) ? [i] : [])
      );
    }
    this.dispatch('selectionchanged');
  }

  addNote(pitch, startTick, endTick, velocity) {
    this._pushUndo();
    const note = { pitch, velocity, startTick, endTick, track: 0, channel: 0, articulation: null };
    this.notes.push(note);
    this.notes.sort((a, b) => a.startTick - b.startTick);
    const idx = this.notes.indexOf(note);
    this.selectedNoteIndices = new Set(idx >= 0 ? [idx] : []);
    this.dispatch('selectionchanged');
  }

  // Call once when a resize drag begins; pushes undo before any mutation.
  resizeNoteStart() {
    this._pushUndo();
  }

  // Called each frame during a right-edge resize drag — no undo push.
  resizeNote(index, newEndTick) {
    const n = this.notes[index];
    if (!n) return;
    n.endTick = Math.max(n.startTick + 1, newEndTick);
    this.dispatch('selectionchanged');
  }

  // Called each frame during a left-edge resize drag — no undo push.
  resizeNoteLeft(index, newStartTick) {
    const n = this.notes[index];
    if (!n) return;
    n.startTick = Math.max(0, Math.min(n.endTick - 1, newStartTick));
    this.dispatch('selectionchanged');
  }

  // Call once when a note drag begins. Pushes undo and sets the dragged selection.
  moveNotesStart(indices) {
    this._pushUndo();
    this.selectedNoteIndices = new Set(indices);
    this.dispatch('selectionchanged');
  }

  // Called each frame during a note drag — no undo push.
  // moves: [{note, startTick, endTick, pitch}] — absolute positions from drag origins + delta.
  moveNotesLive(moves) {
    for (const { note, startTick, endTick, pitch } of moves) {
      note.startTick = Math.max(0, startTick);
      const dur = endTick - startTick;
      note.endTick = note.startTick + dur;
      note.pitch = Math.max(21, Math.min(108, pitch));
    }
    const movedSet = new Set(moves.map(m => m.note));
    this.notes.sort((a, b) => a.startTick - b.startTick);
    this.selectedNoteIndices = new Set(
      this.notes.flatMap((n, i) => movedSet.has(n) ? [i] : [])
    );
    this.dispatch('selectionchanged');
  }

  // ── Pedal curve ────────────────────────────────────────────────────

  addPedalPoint(tick, value) {
    this._pushUndo();
    this.pedalPoints = upsertCurvePoint(this.pedalPoints, tick, value);
    this.dispatch('pedalchanged');
  }

  removePedalPointAt(index) {
    if (index < 0 || index >= this.pedalPoints.length) return;
    this._pushUndo();
    this.pedalPoints.splice(index, 1);
    this.dispatch('pedalchanged');
  }

  // Called each frame during a pedal-point drag — no undo push.
  movePedalPoint(point, tick, value) {
    point.tick  = Math.max(0, tick);
    point.value = value;
    this.pedalPoints.sort((a, b) => a.tick - b.tick);
    this.dispatch('pedalchanged');
  }

  // ── Tempo envelope ─────────────────────────────────────────────────

  addTempoPoint(tick, value) {
    this._pushUndo();
    this.tempoPoints = upsertCurvePoint(this.tempoPoints, tick, value);
    this.totalTime = this.tickToTime(this.totalTicks);
    this.dispatch('tempochanged');
  }

  removeTempoPointAt(index) {
    if (index < 0 || index >= this.tempoPoints.length) return;
    this._pushUndo();
    this.tempoPoints.splice(index, 1);
    this.totalTime = this.tickToTime(this.totalTicks);
    this.dispatch('tempochanged');
  }

  // Called each frame during a tempo-point drag — no undo push.
  moveTempoPoint(point, tick, value) {
    point.tick  = Math.max(0, tick);
    point.value = value;
    this.tempoPoints.sort((a, b) => a.tick - b.tick);
    this.totalTime = this.tickToTime(this.totalTicks);
    this.dispatch('tempochanged');
  }

  // Call once when a curve-point drag begins; pushes undo before mutation.
  beginCurvePointMove() {
    this._pushUndo();
  }

  // ── Undo / redo ────────────────────────────────────────────────────

  get canUndo() { return this._undoStack.length > 0; }
  get canRedo() { return this._redoStack.length > 0; }

  _snapshot() {
    return {
      notes:       this.notes.map(n => ({ ...n })),
      pedalPoints: this.pedalPoints.map(p => ({ ...p })),
      tempoPoints: this.tempoPoints.map(p => ({ ...p })),
      selection:   [...this.selectedNoteIndices],
    };
  }

  _restore(snap) {
    this.notes               = snap.notes.map(n => ({ ...n }));
    this.pedalPoints         = snap.pedalPoints.map(p => ({ ...p }));
    this.tempoPoints         = snap.tempoPoints.map(p => ({ ...p }));
    this.selectedNoteIndices = new Set(snap.selection ?? []);
    this.totalTime           = this.tickToTime(this.totalTicks);
  }

  _pushUndo() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > 100) this._undoStack.shift();
    this._redoStack = [];
    this.dispatch('undochanged');
  }

  undo() {
    if (!this._undoStack.length) return;
    this._redoStack.push(this._snapshot());
    this._restore(this._undoStack.pop());
    this.dispatch('undochanged');
    this.dispatch('selectionchanged');
    this.dispatch('pedalchanged');
    this.dispatch('tempochanged');
  }

  redo() {
    if (!this._redoStack.length) return;
    this._undoStack.push(this._snapshot());
    this._restore(this._redoStack.pop());
    this.dispatch('undochanged');
    this.dispatch('selectionchanged');
    this.dispatch('pedalchanged');
    this.dispatch('tempochanged');
  }

  // ── Bar boundaries ─────────────────────────────────────────────────

  // Returns [{tick, bar}] for every bar line in [tickStart, tickEnd], respecting
  // time signature changes. bar is 1-indexed. Handles segments entirely before
  // the view efficiently without iterating every bar.
  barBoundaries(tickStart, tickEnd) {
    const tpb = this.ticksPerBeat;
    const timeSigs = this.timeSignatures.length
      ? this.timeSignatures
      : [{ tick: 0, numerator: 4, denominator: 4 }];
    const result = [];
    let bar = 1;

    for (let i = 0; i < timeSigs.length; i++) {
      const segTick    = timeSigs[i].tick;
      const nextTick   = i + 1 < timeSigs.length ? timeSigs[i + 1].tick : Infinity;
      const ticksPerBar = tpb * timeSigs[i].numerator * (4 / timeSigs[i].denominator);

      if (segTick > tickEnd) break;

      if (nextTick <= tickStart) {
        bar += Math.round((nextTick - segTick) / ticksPerBar);
        continue;
      }

      const barsBeforeView = segTick < tickStart
        ? Math.floor((tickStart - segTick) / ticksPerBar)
        : 0;
      bar += barsBeforeView;
      let t = segTick + barsBeforeView * ticksPerBar;

      while (t <= tickEnd && t < nextTick) {
        if (t >= tickStart) result.push({ tick: t, bar });
        t += ticksPerBar;
        bar++;
      }

      if (t > tickEnd) break;
    }

    return result;
  }

  // ── Snap ───────────────────────────────────────────────────────────

  /** Returns the nearest snap tick for a given tick value */
  snapTick(tick) {
    const tpb = this.ticksPerBeat;
    const gridTicks = snapGridTicks(this.snapGrid, tpb);
    return Math.round(tick / gridTicks) * gridTicks;
  }

  // ── Playback state ─────────────────────────────────────────────────

  setPlaying(val) {
    this.playing = val;
    this.dispatch('playbackchanged');
  }

  setPlayheadTime(t) {
    this.playheadTime = t;
    this.dispatch('playheadmoved', { time: t });
  }

  // ── Event dispatch ─────────────────────────────────────────────────

  dispatch(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ── Module helpers ─────────────────────────────────────────────────────

function clampVelocity(v) {
  return Math.max(1, Math.min(127, Math.round(v)));
}

// Inserts (or replaces) a curve control point at the given tick, returning a
// new array sorted by tick.
function upsertCurvePoint(points, tick, value) {
  const next = points.filter(p => p.tick !== tick);
  next.push({ tick, value });
  next.sort((a, b) => a.tick - b.tick);
  return next;
}

// Linearly interpolates a [{tick, value}] curve at `tick`. Returns `fallback`
// when the curve is empty; clamps to the endpoint values outside the range.
export function interpolateCurveAtTick(points, tick, fallback) {
  if (points.length === 0) return fallback;
  if (tick <= points[0].tick) return points[0].value;
  const last = points[points.length - 1];
  if (tick >= last.tick) return last.value;
  for (let i = 1; i < points.length; i++) {
    if (tick <= points[i].tick) {
      const span = points[i].tick - points[i - 1].tick;
      const u    = span > 0 ? (tick - points[i - 1].tick) / span : 0;
      return points[i - 1].value + u * (points[i].value - points[i - 1].value);
    }
  }
  return fallback;
}

// ── Snap grid ──────────────────────────────────────────────────────────

export const SNAP_GRIDS = ['1/1', '1/2', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T'];

export function snapGridTicks(grid, tpb) {
  switch (grid) {
    case '1/1':   return tpb * 4;
    case '1/2':   return tpb * 2;
    case '1/4':   return tpb;
    case '1/8':   return tpb / 2;
    case '1/8T':  return tpb * 2 / 3;
    case '1/16':  return tpb / 4;
    case '1/16T': return tpb / 3;
    case '1/32':  return tpb / 8;
    case '1/32T': return tpb / 6;
    default:      return tpb / 2;
  }
}

export const state = new AppState();
