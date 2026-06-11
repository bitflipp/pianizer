# Piano Humanizer — Project Context

## Purpose

Transform a mechanically quantized score (MusicXML exported from MuseScore or similar)
into a musically expressive MIDI rendition. The user selects notes and shapes their
velocity and articulation directly on a piano roll, then plays the result back through
an external synth via Web MIDI (e.g. FluidSynth or a hardware piano).

The core philosophy: expression comes from **deliberate editing**, not randomness.
There is no auto-humanization magic — the tool is an instrument, not an algorithm.

---

## Stack

- **Vanilla JS + Canvas 2D** for the piano roll (no framework overhead; Canvas gives
  full control for high-performance rendering and precise pointer interaction)
- **Plain custom element** for the toolbar — shadow DOM for style encapsulation,
  manual patch-on-event updates (no framework)
- **Web MIDI API** (`navigator.requestMIDIAccess`) for playback output — sends note
  on/off and CC64 (sustain pedal) to a user-selected MIDI port (e.g. FluidSynth).
  Scheduling uses `performance.now()` timestamps with a 30ms/150ms lookahead interval.
- **No build step** — ES modules loaded directly in the browser, served with
  `python3 -m http.server`. Everything must work by opening index.html via localhost.
- **No runtime dependencies** — no CDN imports, nothing the browser fetches beyond
  the source tree. MusicXML parsed with browser `DOMParser`. The shipped app stays
  dep-free; the only npm presence is the test harness (Vitest + Playwright,
  devDependencies only).

---

## File Structure

```
pianizer/
  index.html                 ← entry point, layout, app wiring, tool windows, help overlay, velocity curve editor, autosave
  engine/
    state.js                 ← AppState (EventTarget), single source of truth
    musicxml.js              ← MusicXML score-partwise parser
    midi-out.js              ← Web MIDI output: MidiOut class, lookahead scheduler
  ui/
    roll.js                  ← PianoRoll canvas: render, rect selection, hover, pan, note editing
    curve-lane.js            ← CurveLane base class: shared pedal/tempo lane logic
    pedal-lane.js            ← PedalLane extends CurveLane (sustain pedal, value 0–1)
    tempo-lane.js            ← TempoLane extends CurveLane (tempo ratio 0.8–1.2)
    minimap.js               ← MiniMap lane: full-piece overview, viewport indicator, click-to-pan
    toolbar.js               ← <ph-toolbar> custom element
    dom-utils.js             ← shared layout constants (KEY_WIDTH, HEADER_HEIGHT, PITCH_MIN/MAX/RANGE) + canvasPos/isFormFocused helpers
```

---

## Design Principles

- **High contrast dark theme** — background `#1a1a1a`, UI panels `#111`, text `#fff`,
  control borders `#666`. Monospace font throughout (`12px monospace`).
- **5 px padding** on all control panels. Use a `.inner` wrapper div inside custom
  elements rather than `:host { padding }` — the wrapper approach is immune to
  shadow DOM padding quirks in some browsers. (Exception: the toolbar ribbon's
  `.inner` has no outer padding so its collapsed-border groups span edge to edge;
  the padding lives in each group's body instead — see ui/CLAUDE.md.)
- **No rounded corners, drop shadows, or decorative glows.**
- **No dependencies** — no npm, no CDN imports. If something can be done in vanilla
  JS, do it there; otherwise write it ourselves.
- **No build step** — ever. ES modules loaded directly by the browser.
- **On file load**: auto-fit horizontal zoom (entire piece visible), scroll to show
  the top of the used pitch range. Note height is fixed at 16 px.

---

## Testing

Two suites, both run by `npm test`:

- **Vitest engine tests** (`tests/engine/test.js`, `test.state.js`,
  `test.musicxml.js`) cover `engine/state.js` and `engine/musicxml.js` in
  isolation — pure JS, no DOM beyond `DOMParser`. Coverage is collected for
  those two files only (`vitest.config.js`). Run alone with `npm run test:engine`.
- **Playwright UI tests** (`tests/ui/smoke.test.js`, `notes.test.js`,
  `project-io.test.js`, helpers in `helpers.js`, fixture in
  `fixtures/project.json`) drive the real page via
  a `python3 -m http.server` web server started by `playwright.config.js`. Run
  alone with `npm run test:ui`. Single worker, serial — these tests share the
  static server.
