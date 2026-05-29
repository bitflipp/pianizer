// ui/pedal-lane.js
import { CurveLane } from './curve-lane.js';
import { state } from '../engine/state.js';

export class PedalLane extends CurveLane {
  constructor(canvas, roll) {
    super(canvas, roll, {
      label:           'PED',
      stateEvent:      'pedalchanged',
      getPoints:       () => state.pedalPoints,
      valueMin:        0,
      valueMax:        1,
      emptyValue:      0,
      color:           '#5cc8c8',
      colorHot:        '#a0ecec',
      reticleColor:    'rgba(92,200,200,0.45)',
      reticleHotColor: 'rgba(160,236,236,0.75)',
      addPoint:        (tick, value) => state.addPedalPoint(tick, value),
      removePoint:     (index) => state.removePedalPointAt(index),
      movePoint:       (point, tick, value) => state.movePedalPoint(point, tick, value),
    });
  }
}
