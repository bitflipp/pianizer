// ui/tempo-lane.js
import { CurveLane } from './curve-lane.js';
import { state, monotoneTangents, evalMonotoneCubic } from '../engine/state.js';
import { KEY_WIDTH } from './dom-utils.js';

export class TempoLane extends CurveLane {
  constructor(canvas, roll) {
    super(canvas, roll, {
      label:           'TEMPO',
      stateEvent:      'tempochanged',
      getPoints:       () => state.tempoPoints,
      valueMin:        0.8,
      valueMax:        1.2,
      emptyValue:      1.0,
      color:           '#c8a050',
      colorHot:        '#e8c070',
      reticleColor:    'rgba(200,160,80,0.45)',
      reticleHotColor: 'rgba(232,192,112,0.75)',
      addPoint:        (tick, value) => state.addTempoPoint(tick, value),
      removePoint:     (index) => state.removeTempoPointAt(index),
      movePoint:       (point, tick, value) => state.moveTempoPoint(point, tick, value),
      // Render the curve as the monotone cubic spline that drives playback
      // (state.curvedTickToTime), not straight segments — tangents once, sample per pixel.
      makeSampler:     (points) => {
        const m = monotoneTangents(points);
        return (tick) => evalMonotoneCubic(points, m, tick, 1);
      },
      drawAnnotations: (ctx, canvas, lane) => drawRubatoLabels(ctx, canvas, lane),
    });
  }
}

// Rubato regions are spans between two consecutive control points whose value
// is exactly the baseline (1.0). The label shows how many ms the region
// gains or loses relative to playing it at baseline tempo — i.e. how unbalanced
// the gesture is. Hit 0 ms and the meter is preserved across the gesture.
// The same delta is drawn next to every non-baseline point in the region so it
// stays visible even if other points are scrolled off-screen.
function drawRubatoLabels(ctx, canvas, lane) {
  const regions = computeRubatoRegions(state.tempoPoints);
  if (!regions.length) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(KEY_WIDTH, 0, canvas.width - KEY_WIDTH, canvas.height);
  ctx.clip();

  ctx.font = '9px monospace';
  ctx.textAlign = 'center';

  for (const region of regions) {
    const ms = Math.round(region.deltaMs);
    const sign = ms > 0 ? '+' : ms < 0 ? '−' : '';
    const text = `${sign}${Math.abs(ms)} ms`;
    ctx.fillStyle = Math.abs(ms) <= 1 ? '#7cc97c' : '#e8c070';

    for (const pt of region.innerPoints) {
      const x = lane.roll.tickToX(pt.tick);
      if (x < KEY_WIDTH || x > canvas.width) continue;
      // Each label flips to the lane edge opposite its own point's value.
      if (pt.value > 1) {
        ctx.textBaseline = 'bottom';
        ctx.fillText(text, x, canvas.height - 3);
      } else {
        ctx.textBaseline = 'top';
        ctx.fillText(text, x, 4);
      }
    }
  }
  ctx.restore();
}

function computeRubatoRegions(points) {
  if (points.length < 2) return [];

  const anchorIdx = [];
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(points[i].value - 1) < 1e-9) anchorIdx.push(i);
  }
  if (anchorIdx.length < 2) return [];

  const regions = [];
  for (let k = 0; k < anchorIdx.length - 1; k++) {
    const i = anchorIdx[k], j = anchorIdx[k + 1];
    const startTick = points[i].tick;
    const endTick   = points[j].tick;
    if (endTick - startTick < 1) continue;

    const innerPoints = [];
    for (let m = i + 1; m < j; m++) {
      if (Math.abs(points[m].value - 1) >= 1e-9) innerPoints.push(points[m]);
    }
    if (innerPoints.length === 0) continue; // no rubato between these anchors

    const curved = state.curvedTickToTime(endTick) - state.curvedTickToTime(startTick);
    const base   = state.baseTickToTime(endTick)   - state.baseTickToTime(startTick);
    const deltaMs = (curved - base) * 1000;

    regions.push({ innerPoints, deltaMs });
  }
  return regions;
}
