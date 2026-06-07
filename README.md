# Pianizer

A piano roll editor for adding musical expression to quantized MIDI scores.
Import a MusicXML file, shape note velocities and articulations by hand, draw
sustain pedal and tempo curves, then play the result back through an external
synth via Web MIDI.

**Expression comes from deliberate editing, not randomness.** There is no
auto-humanization — the tool is an instrument.

---

## Features

- **MusicXML import** — parses `score-partwise` exports from MuseScore and
  similar software, including ties, dynamics, multi-voice measures, multiple
  rests, and tremolo expansion
- **Piano roll canvas** — 88-key range (A0–C8), velocity-colored notes,
  snap-to-grid note placement and resizing, rect selection, undo/redo
- **Velocity editing** — apply a shaped ramp across a selection (Linear / Ease in /
  Ease out / S-curve), set absolute values (5–120 grid), or nudge by ±1/5/10; per-key
  velocity curve for device calibration
- **Selection groups** — bind a set of notes into a reusable selection: double-click any
  member to select the whole group at once, while members stay individually selectable and
  fully editable. Groups are color-coded on the roll
- **Duration delta** — scale selected notes' durations by −50/−25/−10/+10/+25/+50%
  without mutating the underlying score
- **Sustain pedal lane** — draw a CC64 curve with snappable control points;
  interpolated value is seeded correctly on mid-piece playback start
- **Tempo lane** — draw a tempo ratio curve (×0.8–×1.2) as a monotone-cubic spline
  that shapes playback timing and overall piece duration
- **Minimap** — full-piece overview with viewport indicator; click or drag to pan
- **Bookmarks** — ruler markers added with Ctrl+click; `←`/`→` seek between them
- **Web MIDI output** — lookahead scheduler (30 ms tick / 150 ms window) sends
  note on/off and CC64 to any browser MIDI port (e.g. FluidSynth, hardware piano);
  an adjustable re-strike gap gives a repeated key's action time to reset
- **Project save/load** — versioned JSON preserving all edits; auto-save to
  `localStorage` with per-piece view state restoration
- **No build step, no dependencies** — vanilla JS ES modules, Canvas 2D, served
  with any static HTTP server

---

## Requirements

- A browser with [Web MIDI API](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API)
  support (Chrome / Edge; Firefox needs a site-permission add-on, which it
  prompts to install on first MIDI request)
- A MIDI output port the browser can see (e.g.
  [FluidSynth](https://www.fluidsynth.org/) via a virtual MIDI loopback, or a
  hardware instrument)
- Python 3 (or any static file server) to serve the files over localhost

---

## Getting started

```sh
git clone https://github.com/phinau/pianizer.git
cd pianizer
python3 -m http.server
```

Open `http://localhost:8000` in Chrome or Edge, click **Connect** in the toolbar
to pick a MIDI output port, then load a MusicXML file.

---

## Keyboard shortcuts

### Selection

| Key / gesture | Action |
|---|---|
| Click note | Add note to selection (grouped notes select individually) |
| Double-click note | Add its whole group to selection |
| Drag | Rectangle select (adds; works anywhere, even over notes) |
| Ctrl+drag | Red rectangle: removes covered notes from selection |
| Ctrl+click note | Remove that note from selection |
| Click empty | Clear selection |
| Ctrl+Z | Undo (removes the last selection change) |
| Escape | Clear selection |

### Editing

| Key / gesture | Action |
|---|---|
| 1 | Group tool (group / ungroup the selection) |
| 2 | Curve tool (bake an eased velocity ramp over the selection) |
| 3 | Velocity tool |
| 4 | Duration delta tool |
| 5 | Velocity delta tool |
| Alt+click empty | Insert note at cursor |
| Shift+drag note body | Move selection (axis-locked: timing or pitch) |
| Shift+drag left / right edge | Resize note start / end (handles show while Shift held) |
| Delete / Backspace | Delete selected notes |
| Ctrl+Z / Ctrl+Y | Undo / redo |

### View

| Key / gesture | Action |
|---|---|
| Scroll | Pan horizontal |
| Ctrl+scroll | Zoom horizontal |
| Right-drag | Pan (horizontal + vertical) |
| Home / End | Scroll to start / end |

### Playback

| Key / gesture | Action |
|---|---|
| Space | Play / pause |
| Click empty roll / ruler | Seek playhead |
| Drag ruler | Scrub playhead |
| Ctrl+click ruler | Add bookmark |
| Ctrl+right-click bookmark | Remove bookmark |
| ← / → | Seek to prev / next bookmark |

### Curve lanes (pedal / tempo)

| Key / gesture | Action |
|---|---|
| Click empty | Add control point (snaps to grid and Y to neighbours / baseline) |
| Ctrl+click | Add without snapping |
| Drag point | Move control point (snaps to grid and Y; hold Ctrl to disable) |
| Right-click | Remove nearest control point |

---

## Project structure

```
pianizer/
  index.html          entry point, layout, tool windows, velocity curve editor, autosave
  engine/
    state.js          AppState (EventTarget) — single source of truth
    musicxml.js       MusicXML score-partwise parser
    midi-out.js       Web MIDI output and lookahead scheduler
  ui/
    roll.js           PianoRoll canvas — render, selection, pan, note editing
    curve-lane.js     CurveLane base class — shared pedal/tempo lane logic
    pedal-lane.js     PedalLane — sustain pedal curve (CC64, value 0–1)
    tempo-lane.js     TempoLane — tempo ratio curve (0.8–1.2)
    minimap.js        MiniMap — full-piece overview, viewport indicator
    toolbar.js        <ph-toolbar> custom element
    dom-utils.js      Layout constants and shared helpers
```

---

## Testing

```sh
npm install          # installs Vitest + Playwright (dev only)
npm test             # engine unit tests + Playwright UI smoke tests
npm run test:engine  # unit tests only
npm run test:ui      # UI tests only (starts a static server automatically)
```

---

## License

MIT — see [LICENSE](LICENSE).
