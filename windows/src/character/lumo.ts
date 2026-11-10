// The agents' minis (minibots.ts): a round little ball with big eyes, drawn by
// engine.ts in its body space: origin at the body centre, y down, R the body's
// size unit, rx/ry its half width/height. Lumo himself is Filo (looks.ts).

export type RGB = readonly [number, number, number]; // components 0…1

/**
 * His body: a round little ball, a touch taller than wide. Half width and half
 * height in units of R, and the superellipse exponent of its outline (2 would
 * be a true ellipse).
 */
export const LUMO_RX = 1.0;
export const LUMO_RY = 0.96;
export const LUMO_EXP = 2.2;
/** His eyes: big and round, set a little apart and low (units of R, radians). */
export const LUMO_EYE = { w: 0.3, h: 0.33, spread: 0.42, pitch: -0.1 } as const;

/** His body: warm butter, lighter at the top. */
export const LUMO_TOP: RGB = [1, 0.965, 0.847]; // #FFF6D8
export const LUMO_BOTTOM: RGB = [0.953, 0.851, 0.541]; // #F3D98A

export const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
