// Catenary between two supports at different heights.
//   z(x) = zA + C * (cosh((x - x0) / C) - cosh(x0 / C))
// where C = H / w is the catenary constant and x0 is the low point.

export interface Catenary {
  L: number;
  C: number;
  x0: number;
  zA: number;
  zB: number;
}

export function makeCatenary(L: number, zA: number, zB: number, C: number): Catenary {
  const h = zB - zA;
  const x0 = L / 2 - C * Math.asinh(h / (2 * C * Math.sinh(L / (2 * C))));
  return { L, C, x0, zA, zB };
}

export function catZ(c: Catenary, x: number): number {
  return c.zA + c.C * (Math.cosh((x - c.x0) / c.C) - Math.cosh(c.x0 / c.C));
}

/** Vertical distance of the wire below the straight chord at x. */
export function catSag(c: Catenary, x: number): number {
  return c.zA + ((c.zB - c.zA) * x) / c.L - catZ(c, x);
}

/** Maximum sag below the chord (occurs where the wire slope equals the chord slope). */
export function maxSag(c: Catenary): number {
  const xs = c.x0 + c.C * Math.asinh((c.zB - c.zA) / c.L);
  return catSag(c, Math.min(c.L, Math.max(0, xs)));
}

export function wireLength(c: Catenary): number {
  return c.C * (Math.sinh((c.L - c.x0) / c.C) + Math.sinh(c.x0 / c.C));
}
