// engine/musicxml.js
// MusicXML (score-partwise) parser — no external dependencies.
// Handles multi-part scores, ties, backup/forward, per-part dynamics,
// tempo/time-signature changes, multi-measure rests, and tremolo expansion.

import { state } from './state.js';

// ── Parser ────────────────────────────────────────────────────────────────

export function parseMusicXml(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML parse error: ' + parseErr.textContent.slice(0, 200));

  const root = doc.documentElement;
  if (root.tagName !== 'score-partwise')
    throw new Error('Only score-partwise MusicXML is supported (got: ' + root.tagName + ').\n'
      + 'Re-export from MuseScore with File → Export → MusicXML.');

  // The first <divisions> value seeds our global ticks-per-beat; all other
  // divisions values are scaled relative to it. Low-divisions files (some tools
  // export 1–24, vs MuseScore's 480) are scaled up by an integer factor to at
  // least 480 — durations stay exact integers, and snap grids, triplets, and
  // tremolo strokes keep a usable tick resolution.
  const firstDivEl = doc.querySelector('divisions');
  const rawTpb = firstDivEl ? parseInt(firstDivEl.textContent, 10) : 480;
  const tpb = rawTpb > 0 ? rawTpb * Math.ceil(480 / rawTpb) : 480;

  const tempoMap = [];
  const timeSigs = [];
  const notes    = [];

  // Reads <duration> from a child element and scales it by the part's current
  // divisions value. `divs` is mutated by <attributes> handlers in the loop.
  let divs = tpb;
  const durTicks = el =>
    Math.round(parseInt(el.querySelector('duration')?.textContent ?? '0', 10) * tpb / divs);

  // Direct children of root that are <part> elements (skips <part-list>)
  const parts = [...root.children].filter(el => el.tagName === 'part');

  for (let pi = 0; pi < parts.length; pi++) {
    // Map part index to MIDI channel, skipping channel 9 (GM drums)
    const channel = pi < 9 ? pi : pi + 1;

    let tick = 0;   // absolute position in tpb-scaled ticks
    divs = tpb;     // reset per part (each part declares its own <divisions>)
    let vel  = 64;  // running velocity from <sound dynamics="...">
    let curNumerator = 4, curDenominator = 4; // current time sig for multiple-rest math
    let pendingTremolo = null; // buffered start-note of a two-note tremolo

    // Tie tracking: `voice|pitch` → index into notes[], so we can extend endTick.
    // Keyed per voice so two voices holding ties on the same pitch don't collide.
    const ties = new Map();

    const measures = [...parts[pi].children].filter(el => el.tagName === 'measure');

    for (const measure of measures) {
      let noteTick = tick; // onset shared by chord notes
      const measureStartTick = tick;
      let multiRestCount = 0;

      for (const child of measure.children) {
        switch (child.tagName) {

          case 'attributes': {
            const d = child.querySelector('divisions');
            if (d) divs = parseInt(d.textContent, 10);

            // Time signature — read from first part only (global)
            const t = child.querySelector('time');
            if (t) {
              const num = parseInt(t.querySelector('beats').textContent, 10);
              const den = parseInt(t.querySelector('beat-type').textContent, 10);
              curNumerator = num; curDenominator = den;
              if (pi === 0) {
                const last = timeSigs[timeSigs.length - 1];
                if (!last || last.numerator !== num || last.denominator !== den) {
                  timeSigs.push({ tick, numerator: num, denominator: den });
                }
              }
            }

            // Multiple-rest: MuseScore omits the intermediate measures from the XML,
            // so we must advance tick to cover all N measures after this one is done.
            const mrEl = child.querySelector('multiple-rest');
            if (mrEl) multiRestCount = parseInt(mrEl.textContent, 10) || 0;
            break;
          }

          case 'direction': {
            const sound = child.querySelector('sound');
            if (!sound) break;

            // Tempo — first part only (acts as conductor)
            if (pi === 0) {
              const t = sound.getAttribute('tempo');
              if (t) {
                const bpm = parseFloat(t);
                const last = tempoMap[tempoMap.length - 1];
                if (!last || Math.abs(last.bpm - bpm) > 0.01) {
                  tempoMap.push({ tick, bpm });
                }
              }
            }

            // Dynamics — per part, 0–127 (MIDI velocity range)
            const dyn = sound.getAttribute('dynamics');
            if (dyn) vel = Math.max(1, Math.min(127, Math.round(parseFloat(dyn))));
            break;
          }

          case 'note': {
            const isRest  = !!child.querySelector('rest');
            const isChord = !!child.querySelector('chord');
            const isGrace = !!child.querySelector('grace');

            const durTick = durTicks(child);

            // Grace notes carry no rhythmic duration in our model
            if (isGrace) break;

            if (!isChord) {
              noteTick = tick;
              tick += durTick;
            }

            if (isRest) break;

            const pitchEl = child.querySelector('pitch');
            if (!pitchEl) break;

            const pitch = pitchToMidi(pitchEl);

            // Measured tremolo expansion
            const tremoloEl = child.querySelector('tremolo');
            if (tremoloEl) {
              const result = expandTremolo(tremoloEl, {
                pitch, vel, noteTick, durTick, tpb, pi, channel, notes, pendingTremolo,
              });
              if (result.handled) {
                pendingTremolo = result.pending;
                break;
              }
              // 'unmeasured' or unmatched 'stop': fall through to normal note
            }

            // Normal note handling (includes ties)
            const tieEls  = [...child.querySelectorAll('tie')];
            const tieStop = tieEls.some(t => t.getAttribute('type') === 'stop');
            const tieStart= tieEls.some(t => t.getAttribute('type') === 'start');
            const tieKey  = (tieStop || tieStart)
              ? (child.querySelector('voice')?.textContent.trim() ?? '') + '|' + pitch
              : null;

            if (tieStop && ties.has(tieKey)) {
              notes[ties.get(tieKey)].endTick = noteTick + durTick;
              if (!tieStart) ties.delete(tieKey);
            } else {
              const ni = notes.length;
              notes.push({
                pitch,
                velocity:  vel,
                startTick: noteTick,
                endTick:   noteTick + durTick,
                track:     pi,
                channel,
              });
              if (tieStart) ties.set(tieKey, ni);
            }
            break;
          }

          // <backup> moves the cursor backwards for a new voice in the same measure
          case 'backup': {
            tick = Math.max(0, tick - durTicks(child));
            break;
          }

          case 'forward': {
            tick += durTicks(child);
            break;
          }
        }
      }

      // If this measure started a multi-measure rest block, advance tick to cover
      // all N measures. The single rest note only covers 1; the rest are absent.
      if (multiRestCount > 1) {
        const ticksPerMeasure = tpb * curNumerator * (4 / curDenominator);
        const expectedEnd = measureStartTick + multiRestCount * ticksPerMeasure;
        if (tick < expectedEnd) tick = expectedEnd;
      }
    }
  }

  if (!tempoMap.length || tempoMap[0].tick > 0) tempoMap.unshift({ tick: 0, bpm: 120 });
  if (!timeSigs.length) timeSigs.push({ tick: 0, numerator: 4, denominator: 4 });
  tempoMap.sort((a, b) => a.tick - b.tick);
  timeSigs.sort((a, b) => a.tick - b.tick);
  notes.sort((a, b) => a.startTick - b.startTick || b.pitch - a.pitch);

  return { tpb, tempoMap, timeSigs, notes };
}

// Expands a <tremolo> note into the explicit alternating strokes that we'll show
// in the piano roll. Stroke speed is absolute: N slashes = 2^N strokes per
// quarter note. We use tpb (not durTick) so a 2-slash tremolo always means
// 16th-note speed regardless of the written note value or any tuplet.
//
// Returns { handled: true, pending: <next pendingTremolo or null> } when the
// tremolo was consumed (single, start, or matched stop). Returns { handled: false }
// for unmeasured tremolos or stops without a prior start — the caller falls
// through to normal note handling.
function expandTremolo(tremoloEl, ctx) {
  const type    = tremoloEl.getAttribute('type');
  const slashes = parseInt(tremoloEl.textContent, 10) || 0;
  const { pitch, vel, noteTick, durTick, tpb, pi, channel, notes, pendingTremolo } = ctx;

  if (type === 'single') {
    const strokeDur    = Math.round(tpb / Math.pow(2, slashes));
    const totalStrokes = Math.max(1, Math.round(durTick / strokeDur));
    for (let s = 0; s < totalStrokes; s++) {
      notes.push({
        pitch,
        velocity:  vel,
        startTick: noteTick + Math.round(s * durTick / totalStrokes),
        endTick:   noteTick + Math.round((s + 1) * durTick / totalStrokes),
        track: pi, channel,
      });
    }
    return { handled: true, pending: pendingTremolo };
  }

  if (type === 'start') {
    return { handled: true, pending: { pitch, noteTick, durTick, slashes, vel } };
  }

  if (type === 'stop' && pendingTremolo) {
    const combinedStart = pendingTremolo.noteTick;
    const combinedDur   = pendingTremolo.durTick + durTick;
    const strokeDur     = Math.round(tpb / Math.pow(2, pendingTremolo.slashes));
    const totalStrokes  = Math.max(2, Math.round(combinedDur / strokeDur));
    for (let s = 0; s < totalStrokes; s++) {
      const first = s % 2 === 0;
      notes.push({
        pitch:     first ? pendingTremolo.pitch : pitch,
        velocity:  first ? pendingTremolo.vel   : vel,
        startTick: combinedStart + Math.round(s * combinedDur / totalStrokes),
        endTick:   combinedStart + Math.round((s + 1) * combinedDur / totalStrokes),
        track: pi, channel,
      });
    }
    return { handled: true, pending: null };
  }

  return { handled: false, pending: pendingTremolo };
}

const STEP_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchToMidi(pitchEl) {
  const step    = pitchEl.querySelector('step').textContent.trim();
  const octave  = parseInt(pitchEl.querySelector('octave').textContent, 10);
  const alterEl = pitchEl.querySelector('alter');
  const alter   = alterEl ? Math.round(parseFloat(alterEl.textContent)) : 0;
  return (octave + 1) * 12 + STEP_SEMITONE[step] + alter;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function loadMusicXmlBuffer(arrayBuffer) {
  const text   = new TextDecoder().decode(arrayBuffer);
  const parsed = parseMusicXml(text);
  state.loadScore(parsed.notes, parsed.tempoMap, parsed.timeSigs, parsed.tpb);
}
