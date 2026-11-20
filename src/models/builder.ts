import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Procedural geometry kit. Models are built Z-up in metres with
//   x = across the line (crossarm axis), y = along the line, z = up
// and merged into one vertex-coloured geometry => one draw call per structure.

export type V3 = THREE.Vector3;
export const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const COL = {
  steel: 0xaeb6bc,
  steelDark: 0x8d969d,
  glass: 0x6f979c,
  porcelain: 0x7a4532,
  concrete: 0xbcb7aa,
  gravel: 0xa9a393,
  red: 0xd4402f,
  white: 0xf1f1ee,
  alu: 0xd5dade,
  roof: 0x5f6b78,
  wall: 0xd9d4c7,
  transformer: 0x7f8c8a,
  panel: 0x1c2f66,
  fence: 0x8a9096,
};

const Z = v3(0, 0, 1);
const Y = v3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpC = new THREE.Color();

export class Builder {
  private parts: THREE.BufferGeometry[] = [];

  private push(g: THREE.BufferGeometry, color: number) {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    tmpC.set(color);
    for (let i = 0; i < n; i++) {
      c[i * 3] = tmpC.r;
      c[i * 3 + 1] = tmpC.g;
      c[i * 3 + 2] = tmpC.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    this.parts.push(g);
  }

  /** Square-section member between two points. */
  beam(a: V3, b: V3, t: number, color: number = COL.steel) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new THREE.BoxGeometry(t, t, len);
    tmpQ.setFromUnitVectors(Z, d.normalize());
    g.applyQuaternion(tmpQ);
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.push(g, color);
  }

  /** Axis-aligned box given centre and size, optionally rotated about Z. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: number, rotZ = 0, tiltX = 0) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    if (tiltX) g.rotateX(tiltX);
    if (rotZ) g.rotateZ(rotZ);
    g.translate(cx, cy, cz);
    this.push(g, color);
  }

  /** Cylinder / cone frustum from a (radius r0) to b (radius r1). */
  cyl(a: V3, b: V3, r0: number, r1: number, color: number, sides = 8) {
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    const g = new THREE.CylinderGeometry(r1, r0, len, sides, 1, false);
    tmpQ.setFromUnitVectors(Y, d.normalize());
    g.applyQuaternion(tmpQ);
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.push(g, color);
  }

  /** Solid square frustum (used for distant-LOD tower bodies). */
  frustum(z0: number, hw0: number, z1: number, hw1: number, color: number) {
    const g = new THREE.BoxGeometry(2, 2, 1);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const t = p.getZ(i) + 0.5;
      const hw = hw0 + (hw1 - hw0) * t;
      p.setXYZ(i, p.getX(i) * hw, p.getY(i) * hw, z0 + (z1 - z0) * t);
    }
    g.computeVertexNormals();
    this.push(g, color);
  }

  /** Insulator string: core rod plus sheds. */
  insulator(a: V3, b: V3, color: number, shed = 0.17) {
    this.cyl(a, b, 0.05, 0.05, color, 5);
    const len = a.distanceTo(b);
    const n = Math.max(3, Math.min(10, Math.round(len / 0.45)));
    const dir = b.clone().sub(a).normalize();
    for (let i = 0; i < n; i++) {
      const p = a.clone().lerp(b, (i + 0.5) / n);
      this.cyl(p.clone().addScaledVector(dir, -0.05), p.clone().addScaledVector(dir, 0.05), shed, shed * 0.8, color, 7);
    }
  }

  get empty() {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false)!;
    this.parts.forEach((p) => p.dispose());
    this.parts = [];
    g.computeBoundingSphere();
    return g;
  }
}

export interface Level {
  z: number;
  hw: number;
}

/** Tapered panel levels between two heights; panels get shorter as the body narrows. */
export function taperLevels(z0: number, hw0: number, z1: number, hw1: number, ratio = 1.9): Level[] {
  const out: Level[] = [{ z: z0, hw: hw0 }];
  let z = z0;
  for (let guard = 0; guard < 40; guard++) {
    const hw = hw0 + ((hw1 - hw0) * (z - z0)) / (z1 - z0);
    const h = Math.max(hw * ratio, 1.2);
    if (z + h * 1.4 >= z1) break;
    z += h;
    out.push({ z, hw: hw0 + ((hw1 - hw0) * (z - z0)) / (z1 - z0) });
  }
  out.push({ z: z1, hw: hw1 });
  return out;
}

/** Square lattice body: 4 legs, X-bracing on every face, horizontals per level. */
export function latticeBody(B: Builder, levels: Level[], leg: number, brace: number, colorAt: (z: number) => number) {
  const corner = (l: Level, k: number) =>
    v3(l.hw * (k === 0 || k === 3 ? -1 : 1), l.hw * (k < 2 ? -1 : 1), l.z);
  for (let i = 0; i < levels.length - 1; i++) {
    const lo = levels[i];
    const hi = levels[i + 1];
    const c = colorAt((lo.z + hi.z) / 2);
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      B.beam(corner(lo, k), corner(hi, k), leg, c);
      B.beam(corner(lo, k), corner(hi, k2), brace, c);
      B.beam(corner(lo, k2), corner(hi, k), brace, c);
      B.beam(corner(hi, k), corner(hi, k2), brace, c);
    }
  }
}

/** Pyramid crossarm from the tower face to a tip at (side*L, 0, z). */
export function crossarm(B: Builder, z: number, side: number, hw: number, L: number, depth: number, t: number, color: number) {
  const tip = v3(side * L, 0, z);
  const roots = [v3(side * hw, -hw, z), v3(side * hw, hw, z), v3(side * hw, -hw, z + depth), v3(side * hw, hw, z + depth)];
  roots.forEach((r) => B.beam(r, tip, t, color));
  const mid = roots.map((r) => r.clone().lerp(tip, 0.5));
  B.beam(mid[0], mid[1], t * 0.7, color);
  B.beam(mid[2], mid[3], t * 0.7, color);
  B.beam(mid[0], mid[2], t * 0.7, color);
  B.beam(mid[1], mid[3], t * 0.7, color);
  B.beam(roots[0], mid[1], t * 0.7, color);
  B.beam(roots[2], mid[0], t * 0.7, color);
  B.beam(roots[3], mid[1], t * 0.7, color);
}

/**
 * Line-entry gantry with strain strings. Returns attachment points per bay.
 * `f` is +1 / -1: the side (along y) the incoming line arrives from.
 */
export function gantry(B: Builder, cx: number, y: number, f: number, bays: number, bayW = 12, h = 14) {
  const circuits: V3[][] = [];
  const gws: V3[] = [];
  const x0 = cx - (bays * bayW) / 2;
  for (let i = 0; i <= bays; i++) {
    const x = x0 + i * bayW;
    B.beam(v3(x - 0.9, y, 0), v3(x, y, h), 0.28, COL.steel);
    B.beam(v3(x + 0.9, y, 0), v3(x, y, h), 0.28, COL.steel);
    B.beam(v3(x - 0.45, y, h / 2), v3(x + 0.45, y, h / 2), 0.16, COL.steel);
    B.beam(v3(x, y, h), v3(x, y, h + 3.5), 0.16, COL.steel);
    if (i < bays) gws.push(v3(x, y, h + 3.5));
  }
  const xe = x0 + bays * bayW;
  B.beam(v3(x0, y, h), v3(xe, y, h), 0.22, COL.steel);
  B.beam(v3(x0, y, h - 1.1), v3(xe, y, h - 1.1), 0.22, COL.steel);
  const zig = bays * 6;
  for (let i = 0; i < zig; i++) {
    const xa = x0 + ((xe - x0) * i) / zig;
    const xb = x0 + ((xe - x0) * (i + 1)) / zig;
    B.beam(v3(xa, y, i % 2 ? h : h - 1.1), v3(xb, y, i % 2 ? h - 1.1 : h), 0.1, COL.steel);
  }
  for (let i = 0; i < bays; i++) {
    const bc = x0 + (i + 0.5) * bayW;
    const phases: V3[] = [];
    for (const dx of [-3.5, 0, 3.5]) {
      const a = v3(bc + dx, y + f * 0.2, h - 0.55);
      const b = v3(bc + dx, y + f * 2.4, h - 0.9);
      B.insulator(a, b, COL.glass, 0.15);
      phases.push(b.clone().add(v3(0, f * 0.15, -0.05)));
      // dropper into the yard
      B.beam(b, v3(bc + dx, y - f * 5.5, 7), 0.07, COL.alu);
      // breaker / CT column
      B.cyl(v3(bc + dx, y - f * 5.5, 0), v3(bc + dx, y - f * 5.5, 4.2), 0.3, 0.22, COL.transformer, 6);
      B.insulator(v3(bc + dx, y - f * 5.5, 4.2), v3(bc + dx, y - f * 5.5, 7), COL.porcelain, 0.2);
    }
    circuits.push(phases);
  }
  return { circuits, gws };
}
