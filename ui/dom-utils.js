// ui/dom-utils.js
// Shared layout constants and small DOM helpers used by the canvas UI
// classes and the host page.

export const KEY_WIDTH     = 36;       // pixel width of the piano key strip
export const HEADER_HEIGHT = 24;       // pixel height of the bar/beat ruler
export const PITCH_MIN     = 21;       // A0
export const PITCH_MAX     = 108;      // C8
export const PITCH_RANGE   = PITCH_MAX - PITCH_MIN + 1;

// Scales mouse CSS coordinates to canvas logical coordinates. The two differ
// when the canvas logical size (set from clientWidth/Height) doesn't match its
// CSS-rendered size — e.g. before the toolbar has taken its layout space.
// Without this, hit testing drifts at non-1:1 ratios.
export function canvasPos(canvas, e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width  / r.width),
    y: (e.clientY - r.top)  * (canvas.height / r.height),
  };
}

// True when the keyboard event originates from a form element — used to skip
// keyboard shortcuts so typing in an input/select/textarea doesn't trigger app
// actions. Takes the event, not its target: events from inside a shadow DOM
// (the toolbar's selects) retarget `e.target` to the host element, hiding the
// real control; composedPath()[0] sees through that.
export function isFormFocused(e) {
  const t = e.composedPath ? e.composedPath()[0] : e.target;
  return t instanceof HTMLInputElement
      || t instanceof HTMLSelectElement
      || t instanceof HTMLTextAreaElement;
}
