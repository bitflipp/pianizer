// engine/state.js
// Single source of truth. The canvas engine reads and writes here.
// The toolbar custom element reads via events dispatched from here.

// Piano key range — MIDI note numbers for A0…C8; note edits clamp pitch here.
const PITCH_LO = 21;
const PITCH_HI = 108;
const DEFAULT_BPM         = 120;  // assumed tempo before the first tempoMap entry
const UNDO_STACK_LIMIT    = 100;  // oldest snapshots drop once the stack passes this
const RESTRIKE_GAP_MAX_MS = 200;  // upper clamp for setRestrikeGap

export class AppState extends EventTarget {
  constructor() {
    super();

    this.loaded = false;
    this.notes = [];           // NoteEvent[]
    this._nextId = 0;          // monotonic source of stable note ids
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

    // Selection groups — each {id, members:[noteId]}. A pure selection convenience:
    // clicking one member selects the whole group and they highlight together, but
    // members stay fully editable (move/resize/delete/velocity). No velocity ramp is
    // stored — the curve tool bakes velocities one-shot, see applyVelocityCurve.
    this.groups = [];                // [{id, members:[noteId]}]
    this._nextGroupId = 0;
    this._groupByNoteId = new Map(); // noteId → group, rebuilt on any group change

    this.pieceId = null;

    // Undo / redo stacks — each entry is {notes, pedalPoints, tempoPoints}
    this._undoStack = [];
    this._redoStack = [];

    // Per-pitch velocity offset (device calibration), pitch 21-108 → index 0-87
    this.velocityCurve = new Array(88).fill(0);

    // Playback speed multiplier (piece-specific view setting, persisted separately)
    this.playSpeed = 1.0;

    // Re-strike gap (ms): minimum key-up before the same key is struck again, so
    // an acoustic grand's hammer/jack/damper can reset — a held-until-re-strike
    // note otherwise yields a weak or dropped repeat. Applied at scheduling time
    // in midi-out.js (wall-clock, independent of playSpeed and pedal state). A
    // property of the output instrument, not the score: device-scoped, persisted
    // separately. 0 disables it.
    this.restrikeGapMs = 60;
  }

  // ── Notes ──────────────────────────────────────────────────────────

  loadScore(notes, tempoMap, timeSigs, tpb) {
    this.notes          = notes.slice().sort((a, b) => a.startTick - b.startTick);
    this._assignIds(this.notes);
    this.groups         = [];
    this._nextGroupId   = 0;
    this._rebuildGroupIndex();
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

  // Assigns a stable id to every note missing one, seeding the counter past any
  // ids already present (e.g. from a loaded project) so new notes never collide.
  _assignIds(notes) {
    let maxId = -1;
    for (const n of notes) if (typeof n.id === 'number' && n.id > maxId) maxId = n.id;
    this._nextId = maxId + 1;
    for (const n of notes) if (typeof n.id !== 'number') n.id = this._nextId++;
  }

  // ── Selection ──────────────────────────────────────────────────────

  setSelection(indices) {
    this._pushUndo();
    this.selectedNoteIndices = new Set(indices);
    this.dispatch('selectionchanged');
  }

  // ── Note value edits (velocity / duration) ─────────────────────────

  setNoteVelocities(indices, velocity) {
    this._pushUndo();
    const v = clampVelocity(velocity);
    for (const i of indices) {
      if (this.notes[i]) this.notes[i].velocity = v;
    }
    this.dispatch('selectionchanged');
  }

  scaleNoteDurations(indices, factor) {
    this._pushUndo();
    for (const i of indices) {
      const n = this.notes[i];
      if (!n) continue;
      const dur = n.endTick - n.startTick;
      n.endTick = n.startTick + Math.max(1, Math.round(dur * factor));
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

  // ── Device calibration ─────────────────────────────────────────────

  setVelocityCurve(curve) {
    this.velocityCurve = curve.slice();
  }

  setRestrikeGap(ms) {
    this.restrikeGapMs = Math.max(0, Math.min(RESTRIKE_GAP_MAX_MS, Math.round(ms)));
    this.dispatch('restrikegapchanged');
  }

  // ── Bookmarks ──────────────────────────────────────────────────────

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

  // ── Project save / load ────────────────────────────────────────────

  saveProject() {
    return {
      version:        1,
      pieceId:        this.pieceId,
      ticksPerBeat:   this.ticksPerBeat,
      tempoMap:       this.tempoMap.map(s => ({ tick: s.tick, bpm: s.bpm, time: s.time ?? 0 })),
      timeSignatures: this.timeSignatures.map(s => ({ tick: s.tick, numerator: s.numerator, denominator: s.denominator })),
      totalTicks:     this.totalTicks,
      totalTime:      this.totalTime,
      notes:          this.notes.map(n => ({ id: n.id, pitch: n.pitch, velocity: n.velocity, startTick: n.startTick, endTick: n.endTick, track: n.track ?? 0, channel: n.channel ?? 0 })),
      pedalPoints:    this.pedalPoints.map(p => ({ tick: p.tick, value: p.value })),
      tempoPoints:    this.tempoPoints.map(p => ({ tick: p.tick, value: p.value })),
      groups:         this.groups.map(g => ({ id: g.id, members: g.members.slice() })),
      bookmarks:      this.bookmarks.slice(),
    };
  }

  loadProject(data) {
    if (!data || typeof data.version !== 'number') throw new Error('Invalid project file');
    this.notes          = (data.notes ?? []).map(n => ({ ...n })).sort((a, b) => a.startTick - b.startTick);
    this._assignIds(this.notes);
    this.tempoMap       = (data.tempoMap ?? [{ tick: 0, bpm: 120, time: 0 }]).map(s => ({ ...s }));
    this.timeSignatures = (data.timeSignatures ?? [{ tick: 0, numerator: 4, denominator: 4 }]).map(s => ({ ...s }));
    this.ticksPerBeat   = data.ticksPerBeat ?? 480;
    this.totalTicks     = data.totalTicks ?? (this.notes.length ? Math.max(...this.notes.map(n => n.endTick)) : 0);
    this.pedalPoints    = (data.pedalPoints ?? []).map(p => ({ ...p }));
    this.tempoPoints    = (data.tempoPoints ?? []).map(p => ({ ...p }));
    this._loadGroups(data.groups ?? []);
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
    let t = 0, lastTick = 0, lastBpm = DEFAULT_BPM;
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
    let t = 0, lastTick = 0, lastBpm = DEFAULT_BPM;
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
    let bpm = DEFAULT_BPM;
    for (const seg of this.tempoMap) {
      if (seg.tick > tick) break;
      bpm = seg.bpm;
    }
    return bpm;
  }

  // Monotone-cubic interpolated tempo ratio at a given tick. Defaults to 1.
  _tempoValueAtTick(tick) {
    const m = monotoneTangents(this.tempoPoints);
    return evalMonotoneCubic(this.tempoPoints, m, tick, 1);
  }

  // tick→time integrating both tempoMap and tempo envelope.
  // The ratio follows a monotone cubic (PCHIP) spline through the tempo points,
  // so there is no closed-form integral; each break sub-segment is integrated
  // numerically (composite Simpson). Tangents are computed once per call and
  // reused across every sample. tempoMap and tempoPoints ticks both seed the
  // break set so a panel never straddles a baseBpm step or a spline knot.
  curvedTickToTime(tick) {
    if (tick <= 0) return 0;
    const tpb = this.ticksPerBeat;
    const pts = this.tempoPoints;
    const m   = monotoneTangents(pts);
    const ratioAt = t => evalMonotoneCubic(pts, m, t, 1);

    const breaks = new Set([0, tick]);
    for (const seg of this.tempoMap) { if (seg.tick > 0 && seg.tick < tick) breaks.add(seg.tick); }
    for (const pt  of pts)           { if (pt.tick  > 0 && pt.tick  < tick) breaks.add(pt.tick); }
    const sorted = [...breaks].sort((a, b) => a - b);

    let t = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const tick0 = sorted[i], tick1 = sorted[i + 1];
      const baseBpm = this._baseBpmAtTick(tick0);
      const C = 60 / (tpb * baseBpm); // seconds per tick at ratio 1
      t += C * simpson(τ => 1 / ratioAt(τ), tick0, tick1, TEMPO_INTEGRATION_PANELS);
    }
    return t;
  }

  // Batched tick→time. Returns a closure `tick => seconds` numerically identical
  // to tickToTime() but with the tempo timeline precomputed once, so converting
  // many ticks is O(breaks + queries) instead of curvedTickToTime()'s O(breaks)
  // *per call* (which re-derives tangents and re-integrates from tick 0 each
  // time → O(N·breaks) for N notes). Used by the MIDI scheduler, which converts
  // every note's start/end up front. Rebuild after any tempo change.
  buildTickToTime() {
    if (this.tempoPoints.length === 0) return tick => this.baseTickToTime(tick);

    const tpb = this.ticksPerBeat;
    const pts = this.tempoPoints;
    const m   = monotoneTangents(pts);
    const ratioAt = t => evalMonotoneCubic(pts, m, t, 1);

    // Global break set: 0, every tempoMap step, every spline knot. baseBpm is
    // constant within each [breaks[i], breaks[i+1]] segment, so the partial
    // integral for a query tick uses the segment-start baseBpm — matching
    // curvedTickToTime's per-call partitioning exactly.
    const breakSet = new Set([0]);
    for (const seg of this.tempoMap) if (seg.tick > 0) breakSet.add(seg.tick);
    for (const pt  of pts)           if (pt.tick  > 0) breakSet.add(pt.tick);
    const breaks = [...breakSet].sort((a, b) => a - b);

    // cumTime[i] = time at breaks[i]; segC[i] = seconds-per-tick at ratio 1 for
    // the segment starting at breaks[i] (and for any tick beyond the last break).
    const cumTime = new Array(breaks.length);
    const segC    = new Array(breaks.length);
    cumTime[0] = 0;
    for (let i = 0; i < breaks.length; i++) {
      segC[i] = 60 / (tpb * this._baseBpmAtTick(breaks[i]));
      if (i + 1 < breaks.length) {
        cumTime[i + 1] = cumTime[i]
          + segC[i] * simpson(τ => 1 / ratioAt(τ), breaks[i], breaks[i + 1], TEMPO_INTEGRATION_PANELS);
      }
    }

    return tick => {
      if (tick <= 0) return 0;
      let lo = 0, hi = breaks.length - 1; // largest break <= tick
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (breaks[mid] <= tick) lo = mid; else hi = mid - 1;
      }
      if (breaks[lo] === tick) return cumTime[lo];
      return cumTime[lo] + segC[lo] * simpson(τ => 1 / ratioAt(τ), breaks[lo], tick, TEMPO_INTEGRATION_PANELS);
    };
  }

  // ── Note editing ───────────────────────────────────────────────────

  deleteNotes(indices) {
    this._pushUndo();
    const toDelete = new Set(indices);
    const deletedIds = new Set();
    for (const i of toDelete) if (this.notes[i]) deletedIds.add(this.notes[i].id);
    this.notes = this.notes.filter((_, i) => !toDelete.has(i));
    this._pruneGroups(deletedIds);
    this.selectedNoteIndices = new Set();
    this.dispatch('selectionchanged');
  }

  // Drops the given note ids from every group and discards groups left with <2
  // members (a one-note group is meaningless), then rebuilds the lookup index.
  _pruneGroups(removedIds) {
    let changed = false;
    for (const g of this.groups) {
      const kept = g.members.filter(id => !removedIds.has(id));
      if (kept.length !== g.members.length) { g.members = kept; changed = true; }
    }
    this.groups = this.groups.filter(g => g.members.length >= 2);
    if (changed) this._rebuildGroupIndex();
  }

  // Re-sorts notes by startTick and re-derives the selection indices for the given
  // note objects, whose array positions shift after the reorder. Call after any edit
  // that changes start ticks.
  _reselectByNotes(movedSet) {
    this.notes.sort((a, b) => a.startTick - b.startTick);
    this.selectedNoteIndices = new Set(
      this.notes.flatMap((n, i) => movedSet.has(n) ? [i] : [])
    );
  }

  // deltaPitch and deltaTick may each be 0.
  moveNotes(indices, deltaPitch, deltaTick) {
    this._pushUndo();
    const moved = indices.map(i => this.notes[i]).filter(Boolean);
    for (const n of moved) {
      if (deltaPitch) n.pitch = Math.max(PITCH_LO, Math.min(PITCH_HI, n.pitch + deltaPitch));
      if (deltaTick) {
        const dur = n.endTick - n.startTick;
        n.startTick = Math.max(0, n.startTick + deltaTick);
        n.endTick   = n.startTick + dur;
      }
    }
    if (deltaTick) this._reselectByNotes(new Set(moved));
    this.dispatch('selectionchanged');
  }

  addNote(pitch, startTick, endTick, velocity) {
    this._pushUndo();
    const note = { id: this._nextId++, pitch, velocity, startTick, endTick, track: 0, channel: 0 };
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

  // Called each frame during a right-edge resize drag of multiple notes — no undo push.
  // moves: [{note, endTick}]
  resizeNotesRight(moves) {
    for (const { note, endTick } of moves) {
      note.endTick = Math.max(note.startTick + 1, endTick);
    }
    this.dispatch('selectionchanged');
  }

  // Called each frame during a left-edge resize drag of multiple notes — no undo push.
  // moves: [{note, startTick}]
  resizeNotesLeft(moves) {
    for (const { note, startTick } of moves) {
      note.startTick = Math.max(0, Math.min(note.endTick - 1, startTick));
    }
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
      note.pitch = Math.max(PITCH_LO, Math.min(PITCH_HI, pitch));
    }
    this._reselectByNotes(new Set(moves.map(m => m.note)));
    this.dispatch('selectionchanged');
  }

  // ── Selection groups ───────────────────────────────────────────────

  _notesByIds(ids) {
    const set = new Set(ids);
    return this.notes.filter(n => set.has(n.id));
  }

  _rebuildGroupIndex() {
    this._groupByNoteId = new Map();
    for (const g of this.groups) {
      for (const id of g.members) this._groupByNoteId.set(id, g);
    }
  }

  groupOfNote(note)      { return note ? (this._groupByNoteId.get(note.id) ?? null) : null; }
  groupMembers(g)        { return this._notesByIds(g.members); }
  // Member ids → current selection indices, for selecting a group as a unit.
  groupMemberIndices(g) {
    const ids = new Set(g.members);
    return this.notes.flatMap((n, i) => ids.has(n.id) ? [i] : []);
  }

  // Drops the given note ids from every group and discards groups left with <2
  // members. Leaves the lookup index stale — the caller rebuilds once it's done
  // mutating groups.
  _detachIds(ids) {
    for (const g of this.groups) g.members = g.members.filter(id => !ids.has(id));
    this.groups = this.groups.filter(g => g.members.length >= 2);
  }

  // Records the selected notes as a selection group. Needs ≥2 notes. Any member
  // already in another group is detached from it first (a note belongs to one
  // group at most); groups left with <2 members are discarded.
  createGroup(indices) {
    const members = indices.map(i => this.notes[i]).filter(Boolean);
    if (members.length < 2) return;
    this._pushUndo();
    const ids = new Set(members.map(n => n.id));
    this._detachIds(ids);
    this.groups.push({ id: this._nextGroupId++, members: [...ids] });
    this._rebuildGroupIndex();
    this.dispatch('groupschanged');
  }

  // Extracts the given notes from whichever group each belongs to (a note is in one
  // group at most), then discards any group left with <2 members. Ungrouped notes are
  // ignored; a no-op (no undo entry) when none of them are grouped.
  removeFromGroup(indices) {
    const ids = new Set();
    for (const i of indices) { const note = this.notes[i]; if (note) ids.add(note.id); }
    if (!this.groups.some(g => g.members.some(id => ids.has(id)))) return;
    this._pushUndo();
    this._detachIds(ids);
    this._rebuildGroupIndex();
    this.dispatch('groupschanged');
  }

  // One-shot velocity shaper: bakes a start→end ramp (eased by `shape`) across the
  // selected notes by onset time — notes sharing a startTick (a chord) get one
  // value. Sets velocities directly; forms no group and locks nothing.
  applyVelocityCurve(indices, from, to, shape) {
    const members = indices.map(i => this.notes[i]).filter(Boolean);
    if (!members.length) return;
    this._pushUndo();
    const ease   = SCALE_EASINGS[shape] ?? SCALE_EASINGS.Linear;
    const sorted = members.slice().sort((a, b) => a.startTick - b.startTick);
    const minTick = sorted[0].startTick;
    const maxTick = sorted[sorted.length - 1].startTick;
    const range   = maxTick - minTick;
    for (const n of sorted) {
      const t = range === 0 ? 0 : (n.startTick - minTick) / range;
      n.velocity = clampVelocity(from + (to - from) * ease(t));
    }
    this.dispatch('selectionchanged');
  }

  // Rebuilds groups from saved data: drops member ids that no longer exist,
  // discards groups left with <2 members, and seeds the id counter past any
  // stored group id.
  _loadGroups(raw) {
    const noteIds = new Set(this.notes.map(n => n.id));
    let maxId = -1;
    const groups = [];
    for (const g of raw) {
      const members = (g.members ?? []).filter(id => noteIds.has(id));
      if (members.length < 2) continue;
      const id = typeof g.id === 'number' ? g.id : null;
      if (id !== null && id > maxId) maxId = id;
      groups.push({ id, members });
    }
    this._nextGroupId = maxId + 1;
    for (const g of groups) if (g.id === null) g.id = this._nextGroupId++;
    this.groups = groups;
    this._rebuildGroupIndex();
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
      groups:      this.groups.map(g => ({ ...g, members: g.members.slice() })),
      selection:   [...this.selectedNoteIndices],
    };
  }

  _restore(snap) {
    this.notes               = snap.notes.map(n => ({ ...n }));
    this.pedalPoints         = snap.pedalPoints.map(p => ({ ...p }));
    this.tempoPoints         = snap.tempoPoints.map(p => ({ ...p }));
    this.groups              = (snap.groups ?? []).map(g => ({ ...g, members: g.members.slice() }));
    this.selectedNoteIndices = new Set(snap.selection ?? []);
    this._rebuildGroupIndex();
    this.totalTime           = this.tickToTime(this.totalTicks);
  }

  _pushUndo() {
    this._undoStack.push(this._snapshot());
    if (this._undoStack.length > UNDO_STACK_LIMIT) this._undoStack.shift();
    this._redoStack = [];
    this.dispatch('undochanged');
  }

  // Pops one snapshot off `from`, banks the current state onto `to`, restores it, and
  // fires every event a restore can affect. undo/redo differ only in stack direction.
  _applyHistory(from, to) {
    if (!from.length) return;
    to.push(this._snapshot());
    this._restore(from.pop());
    this.dispatch('undochanged');
    this.dispatch('selectionchanged');
    this.dispatch('pedalchanged');
    this.dispatch('tempochanged');
    this.dispatch('groupschanged');
  }

  undo() { this._applyHistory(this._undoStack, this._redoStack); }
  redo() { this._applyHistory(this._redoStack, this._undoStack); }

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

// Velocity-ramp shapes for the curve tool. Each maps a normalized
// onset position t∈[0,1] → eased fraction of the start→end velocity span. A
// linear MIDI-velocity ramp is not a linear perceived-loudness ramp, so the
// eased shapes let the musician pick a crescendo/decrescendo contour deliberately.
export const SCALE_EASINGS = {
  'Linear':   t => t,
  'Ease in':  t => t * t,            // slow → fast
  'Ease out': t => t * (2 - t),      // fast → slow
  'S-curve':  t => t * t * (3 - 2 * t),
};

// Inserts (or replaces) a curve control point at the given tick, returning a
// new array sorted by tick.
function upsertCurvePoint(points, tick, value) {
  const next = points.filter(p => p.tick !== tick);
  next.push({ tick, value });
  next.sort((a, b) => a.tick - b.tick);
  return next;
}

// Subdivisions per break sub-segment for numeric tempo integration. The ratio
// spline is a single cubic within each segment, so Simpson with this many even
// panels is accurate to well below a millisecond over musical spans.
const TEMPO_INTEGRATION_PANELS = 16;

// Composite Simpson's rule for ∫_a^b f, with `panels` even subdivisions.
// Exact for constant and low-order integrands, so a flat ratio still maps to
// the base time precisely.
function simpson(f, a, b, panels) {
  if (b <= a) return 0;
  const h = (b - a) / panels;
  let s = f(a) + f(b);
  for (let k = 1; k < panels; k++) s += (k % 2 ? 4 : 2) * f(a + k * h);
  return s * h / 3;
}

// Monotone cubic (Fritsch–Carlson / PCHIP) tangents for a [{tick, value}] curve
// sorted by tick — one slope per point. Local extrema and equal-valued runs get
// a zero slope, so flats stay flat and the spline never overshoots the data
// range. That means an anchor placed to return to a tempo actually holds it
// (no wobble approaching the flat) and the ratio stays bounded within the
// points' own min/max — the curve never injects a tempo bump you didn't draw.
export function monotoneTangents(pts) {
  const n = pts.length;
  if (n < 2) return n ? [0] : [];
  const h = new Array(n - 1), d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = pts[i + 1].tick - pts[i].tick;
    d[i] = h[i] > 0 ? (pts[i + 1].value - pts[i].value) / h[i] : 0;
  }
  const m = new Array(n);
  if (n === 2) { m[0] = m[1] = d[0]; return m; } // two points ⇒ straight line
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); // weighted harmonic mean
    }
  }
  m[0]     = pchipEdgeTangent(h[0], h[1], d[0], d[1]);
  m[n - 1] = pchipEdgeTangent(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  return m;
}

// One-sided, non-overshooting endpoint slope (SciPy's pchip edge formula).
function pchipEdgeTangent(h0, h1, d0, d1) {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) m = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0)) m = 3 * d0;
  return m;
}

// Evaluates the monotone cubic Hermite spline (tangents from monotoneTangents)
// at `tick`. Returns `fallback` for an empty curve; holds flat at the endpoint
// values outside the point range, matching the linear interpolant's clamping.
export function evalMonotoneCubic(pts, m, tick, fallback) {
  const n = pts.length;
  if (n === 0) return fallback;
  if (tick <= pts[0].tick)     return pts[0].value;
  if (tick >= pts[n - 1].tick) return pts[n - 1].value;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].tick <= tick) lo = mid; else hi = mid; }
  const h  = pts[lo + 1].tick - pts[lo].tick;
  const t  = (tick - pts[lo].tick) / h;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * pts[lo].value
       + (t3 - 2 * t2 + t)     * h * m[lo]
       + (-2 * t3 + 3 * t2)    * pts[lo + 1].value
       + (t3 - t2)             * h * m[lo + 1];
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

export const SNAP_GRIDS = ['1/1', '1/2', '1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T', '1/64', '1/64T'];

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
    case '1/64':  return tpb / 16;
    case '1/64T': return tpb / 12;
    default:      return tpb / 2;
  }
}

export const state = new AppState();
