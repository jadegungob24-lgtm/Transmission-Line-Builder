import * as THREE from 'three';
import { modelOf } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { enuOffset, LL } from '../core/geo';
import type { Span, Structure } from '../core/types';
import { catSag, catZ, makeCatenary, maxSag } from './catenary';

// Works out which attachment point on tower A connects to which on tower B,
// then builds one merged tube geometry for every wire in the span.
// All coordinates are metres East/North/Up relative to structure A's base.

const D2R = Math.PI / 180;

export interface Wire {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** 0 = phase conductor, 1 = ground wire / OPGW. */
  kind: 0 | 1;
  C: number;
}

export interface SpanLayout {
  wires: Wire[];
  length: number;
  dE: number;
  dN: number;
  dz: number;
  /** Sag of the lowest phase conductor (m). */
  sag: number;
  circuits: number;
  /** Lowest phase wire, for clearance checks. */
  lowest: Wire | null;
}

function toENU(S: Structure, p: THREE.Vector3, flip: number): THREE.Vector3 {
  const b = S.rotation * D2R;
  const y = p.y * flip;
  return new THREE.Vector3(p.x * Math.cos(b) + y * Math.sin(b), -p.x * Math.sin(b) + y * Math.cos(b), p.z);
}

function kPerms<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  arr.forEach((x, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of kPerms(rest, k - 1)) out.push([x, ...p]);
  });
  return out;
}

const centroid = (pts: THREE.Vector3[]) =>
  pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);

/** Attachment points of one end, in that structure's own ENU frame. */
export function endAttachments(S: Structure, towards: LL, slots: number[]) {
  const m = modelOf(S);
  let flip = 1;
  if (m.strain) {
    const [e, n] = enuOffset(S, towards);
    const b = S.rotation * D2R;
    flip = e * Math.sin(b) + n * Math.cos(b) >= 0 ? 1 : -1;
  }
  const idx = m.exclusive ? slots : m.circuits.map((_, i) => i);
  return {
    circuits: idx.map((i) => m.circuits[i].map((p) => toENU(S, p, flip))),
    gws: (m.exclusive ? slots.map((i) => m.groundWires[i]) : m.groundWires).map((p) => toENU(S, p, flip)),
    exclusive: m.exclusive,
  };
}

export function layoutSpan(span: Span, A: Structure, B: Structure): SpanLayout {
  const v = VOLTAGES[span.voltage];
  const [dE, dN] = enuOffset(A, B);
  const dz = B.elev - A.elev;
  const length = Math.hypot(dE, dN) || 1;
  const px = -dN / length;
  const py = dE / length;
  const lat = (p: THREE.Vector3) => p.x * px + p.y * py;

  const ea = endAttachments(A, B, span.slotsA);
  const eb = endAttachments(B, A, span.slotsB);
  const off = new THREE.Vector3(dE, dN, dz);
  const cB = eb.circuits.map((c) => c.map((p) => p.clone().add(off)));
  const gB = eb.gws.map((p) => p.clone().add(off));
  const slack = ea.exclusive || eb.exclusive ? 0.4 : 1;

  const wires: Wire[] = [];
  const n = Math.min(ea.circuits.length, cB.length);

  // circuit assignment: minimise sideways crossing
  let best: { a: number[]; b: number[] } | null = null;
  let bestCost = Infinity;
  const ia = ea.circuits.map((_, i) => i);
  const ib = cB.map((_, i) => i);
  const latA = ea.circuits.map((c) => lat(centroid(c)));
  const latB = cB.map((c) => lat(centroid(c)));
  for (const pa of kPerms(ia, n)) {
    for (const pb of kPerms(ib, n)) {
      let cost = 0;
      for (let k = 0; k < n; k++) cost += Math.abs(latA[pa[k]] - latB[pb[k]]);
      if (cost < bestCost - 1e-6) {
        bestCost = cost;
        best = { a: pa, b: pb };
      }
    }
  }

  const bundleOffsets: [number, number][] =
    v.bundle >= 4 ? [[-0.23, 0.23], [0.23, 0.23], [-0.23, -0.23], [0.23, -0.23]]
    : v.bundle === 2 ? [[-0.23, 0], [0.23, 0]]
    : [[0, 0]];

  let lowest: Wire | null = null;
  if (best) {
    for (let k = 0; k < n; k++) {
      const A3 = ea.circuits[best.a[k]];
      const B3 = cB[best.b[k]];
      // phase assignment within the circuit
      let bp = [0, 1, 2];
      let bc = Infinity;
      for (const perm of kPerms([0, 1, 2], 3)) {
        let cost = 0;
        for (let i = 0; i < 3; i++) {
          const dl = lat(A3[i]) - lat(B3[perm[i]]);
          const dh = A3[i].z - (B3[perm[i]].z - dz);
          cost += dl * dl + dh * dh;
        }
        if (cost < bc - 1e-6) {
          bc = cost;
          bp = perm;
        }
      }
      for (let i = 0; i < 3; i++) {
        for (const [bl, bz] of bundleOffsets) {
          const o = new THREE.Vector3(px * bl, py * bl, bz);
          const w: Wire = { a: A3[i].clone().add(o), b: B3[bp[i]].clone().add(o), kind: 0, C: v.catenaryC * slack };
          wires.push(w);
          if (!lowest || w.a.z + w.b.z < lowest.a.z + lowest.b.z) lowest = w;
        }
      }
    }
  }

  // ground wires
  const ng = Math.min(ea.gws.length, gB.length);
  if (ng > 0) {
    let bg: { a: number[]; b: number[] } | null = null;
    let bgc = Infinity;
    for (const pa of kPerms(ea.gws.map((_, i) => i), ng)) {
      for (const pb of kPerms(gB.map((_, i) => i), ng)) {
        let cost = 0;
        for (let k = 0; k < ng; k++) cost += Math.abs(lat(ea.gws[pa[k]]) - lat(gB[pb[k]]));
        if (cost < bgc - 1e-6) {
          bgc = cost;
          bg = { a: pa, b: pb };
        }
      }
    }
    if (bg) for (let k = 0; k < ng; k++) wires.push({ a: ea.gws[bg.a[k]].clone(), b: gB[bg.b[k]].clone(), kind: 1, C: v.catenaryC * 1.2 * slack });
  }

  let sag = 0;
  if (lowest) {
    const L = Math.hypot(lowest.b.x - lowest.a.x, lowest.b.y - lowest.a.y) || 1;
    sag = maxSag(makeCatenary(L, lowest.a.z, lowest.b.z, lowest.C));
  }
  return { wires, length, dE, dN, dz, sag, circuits: n, lowest };
}

/** Height (relative to A's base) of a wire at fraction t of the span. */
export function wireHeightAt(w: Wire, t: number): number {
  const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
  return catZ(makeCatenary(L, w.a.z, w.b.z, w.C), L * t);
}

const SIDES = 3;

/** One merged triangular-tube geometry for all wires of a span. */
export function buildSpanGeometry(layout: SpanLayout): THREE.BufferGeometry {
  const segs = Math.max(8, Math.min(32, Math.round(layout.length / 22)));
  const rings = segs + 1;
  const nW = layout.wires.length;
  const vCount = nW * rings * SIDES;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const sway = new Float32Array(vCount * 3);
  const misc = new Float32Array(vCount * 3); // t, random phase, kind
  const index: number[] = [];
  const up = new THREE.Vector3(0, 0, 1);
  const tan = new THREE.Vector3();
  const side = new THREE.Vector3();
  const upv = new THREE.Vector3();

  layout.wires.forEach((w, wi) => {
    const hx = w.b.x - w.a.x;
    const hy = w.b.y - w.a.y;
    const L = Math.hypot(hx, hy) || 1;
    const ux = hx / L;
    const uy = hy / L;
    const cat = makeCatenary(L, w.a.z, w.b.z, w.C);
    const rnd = (Math.sin(wi * 12.9898 + L * 0.37) * 43758.5453) % 1;
    const base = wi * rings * SIDES;
    for (let i = 0; i < rings; i++) {
      const t = i / segs;
      const x = L * t;
      const z = catZ(cat, x);
      const slope = Math.sinh((x - cat.x0) / cat.C);
      tan.set(ux, uy, slope).normalize();
      side.crossVectors(tan, up).normalize();
      upv.crossVectors(side, tan);
      const sg = catSag(cat, x);
      for (let j = 0; j < SIDES; j++) {
        const a = (j / SIDES) * Math.PI * 2;
        const k = (base + i * SIDES + j) * 3;
        pos[k] = w.a.x + ux * x;
        pos[k + 1] = w.a.y + uy * x;
        pos[k + 2] = z;
        nor[k] = Math.cos(a) * side.x + Math.sin(a) * upv.x;
        nor[k + 1] = Math.cos(a) * side.y + Math.sin(a) * upv.y;
        nor[k + 2] = Math.cos(a) * side.z + Math.sin(a) * upv.z;
        // horizontal blow-out direction scaled by local sag
        sway[k] = -uy * sg;
        sway[k + 1] = ux * sg;
        sway[k + 2] = sg;
        misc[k] = t;
        misc[k + 1] = Math.abs(rnd);
        misc[k + 2] = w.kind;
      }
      if (i < segs) {
        for (let j = 0; j < SIDES; j++) {
          const a0 = base + i * SIDES + j;
          const a1 = base + i * SIDES + ((j + 1) % SIDES);
          const b0 = a0 + SIDES;
          const b1 = a1 + SIDES;
          index.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
  });

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aSway', new THREE.BufferAttribute(sway, 3));
  g.setAttribute('aMisc', new THREE.BufferAttribute(misc, 3));
  g.setIndex(index);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 30;
  return g;
}
