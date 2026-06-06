// ui/tempo-lane.js
import { CurveLane } from './curve-lane.js';
import { state, monotoneTangents, evalMonotoneCubic } from '../engine/state.js';

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
    });
  }
}
