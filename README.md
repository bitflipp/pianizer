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
  snap-to-grid note placement and resizing, rect selection, note muting and
  soloing, grouping (tag notes into four groups, then filter a selection to one),
  undo/redo
- **Velocity editing** — apply a shaped ramp across a selection (Linear / Ease in /
  Ease out / S-curve), set absolute values (5–120 grid), or nudge by ±1/5/10
- **Sustain pedal lane** — draw a CC64 curve with snappable control points;
  interpolated value is seeded correctly on mid-piece playback start
- **Tempo lane** — draw a tempo ratio curve (×0.8–×1.2) as a monotone-cubic spline
  that shapes playback timing and overall piece duration
- **Soft-pedal lane** — paint binary una corda (CC67) regions that switch the soft
  pedal on and off
- **Minimap** — full-piece overview with viewport indicator; click or drag to pan
- **Bookmarks** — ruler markers added with Ctrl+click; `←`/`→` seek between them
- **A/B loop** — Alt+click the ruler to cycle a loop start/end marker; playback
  wraps between them until cleared
- **Web MIDI output** — lookahead scheduler (30 ms tick / 150 ms window) sends
  note on/off, CC64 (sustain) and CC67 (soft pedal) to any browser MIDI port
  (e.g. FluidSynth, hardware piano); a fixed 50 ms re-strike gap gives a
  repeated key's action time to reset
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

Press **?** at any time to open an in-app overlay listing the shortcuts below.

### Selection

| Key / gesture | Action |
|---|---|
| Click note | Select just that note |
| Shift+click note | Toggle note in the selection (add, or remove if already selected) |
| Double-click grouped note | Select all visible members of that note's group |
| A | Select all notes |
| Drag empty | Rectangle select (replaces selection) |
| Shift+drag empty | Rectangle select (extends selection) |
| Click empty | Clear selection |
| Ctrl+Z | Undo (removes the last selection change) |
| Escape | Clear selection |

### Editing

| Key / gesture | Action |
|---|---|
| 1 | Velocity tool |
| 2 | Curve tool (bake an eased velocity ramp over the selection) |
| 3 | Velocity delta tool |
| 4 | Group tool (assign / clear group, or narrow selection to a group) |
| Alt+click | Insert note at cursor (one snap-step long) |
| Alt+drag | Insert note, dragging sets its duration |
| Drag note body | Move selection (axis-locked: timing or pitch) |
| Drag left / right edge | Resize note start / end (handles show on hover) |
| Delete / Backspace | Delete selected notes |
| M | Mute / unmute selected notes |
| S | Solo / unsolo selected notes (mutually exclusive with mute) |
| Ctrl+Z / Ctrl+Y | Undo / redo |

### View

| Key / gesture | Action |
|---|---|
| Scroll | Pan horizontal |
| Ctrl+scroll | Zoom horizontal (toward cursor) |
| + / − | Zoom in / out (toward center) |
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
| Alt+click ruler | Cycle A/B loop marker at the clicked position (unset → A → both → unset; also seeks) |

### Curve lanes (pedal / tempo)

| Key / gesture | Action |
|---|---|
| Click empty | Add control point (snaps to grid and Y to neighbours / baseline) |
| Ctrl+click | Add without snapping |
| Drag point | Move control point (snaps to grid and Y; hold Ctrl to disable) |
| Right-click | Remove nearest control point |

### Soft-pedal lane (una corda)

| Key / gesture | Action |
|---|---|
| Drag empty | Paint a soft-pedal region (binary CC67 on) |
| Click empty | Add a one-snap-step region |
| Drag region edge | Resize region start / end |
| Drag region body | Move region |
| Ctrl+drag | Paint / resize / move without snapping |
| Right-click region | Remove region |

---

## Project structure

```
pianizer/
  index.html          entry point, layout, tool windows, autosave
  engine/
    state.js          AppState (EventTarget) — single source of truth
    musicxml.js       MusicXML score-partwise parser
    midi-out.js       Web MIDI output and lookahead scheduler
  ui/
    roll.js           PianoRoll canvas — render, selection, pan, note editing
    curve-lane.js     CurveLane base class — shared pedal/tempo lane logic
    pedal-lane.js     PedalLane — sustain pedal curve (CC64, value 0–1)
    tempo-lane.js     TempoLane — tempo ratio curve (0.8–1.2)
    region-lane.js    RegionLane — soft-pedal (una corda) binary CC67 regions
    minimap.js        Minimap — full-piece overview, viewport indicator
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
