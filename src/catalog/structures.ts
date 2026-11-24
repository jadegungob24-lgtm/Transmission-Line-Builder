import * as THREE from 'three';
import { Builder, COL, V3, crossarm, gantry, latticeBody, taperLevels, v3 } from '../models/builder';
import { TRANSMISSION_VOLTAGES, VOLTAGES, VoltageId, VoltageSpec } from './voltages';

// Structure catalogue. To add a structure: write a build function that returns
// geometry + attachment points, then register a StructureDef below. Nothing
// else in the app needs to change.

export interface BuiltModel {
  geometry: THREE.BufferGeometry;
  /** Optional parts that pulse when energised (busbars etc). */
  glow?: THREE.BufferGeometry;
  /** Low-detail silhouette shown when the structure is small on screen. */
  lod?: THREE.BufferGeometry;
  /** Per circuit: three phase attachment points (local coords). */
  circuits: V3[][];
  groundWires: V3[];
  /** Strain structure: attachments are mirrored in y for the back span. */
  strain: boolean;
  /** Each circuit position (bay) can terminate only one line. */
  exclusive: boolean;
  height: number;
  /** Footprint radius for spacing checks. */
  radius: number;
}

export type Category = 'tower' | 'pole' | 'substation' | 'other';
export type Role = 'line' | 'substation' | 'source';

export interface StructureDef {
  id: string;
  name: string;
  short: string;
  category: Category;
  description: string;
  icon: string;
  /** Allowed voltage classes, or 'any' for stations that accept every class. */
  voltages: VoltageId[] | 'any';
  role: Role;
  circuits: number;
  /** Multiplier on the voltage class max span. */
  spanFactor: number;
  /** Max recommended line deflection angle in degrees (line structures). */
  maxAngle?: number;
  capacityMW?: number;
  loadMW?: number;
  /** Required land area in hectares (for substations). */
  areaHa?: number;
  /** Yard footprint [widthM, depthM] in local metres (for substations). */
  footprint?: [number, number];
  /** Primary voltage class badge for substations (still accepts any interconnecting line voltage). */
  nominalVoltage?: VoltageId;
  /** Keep legacy definition loadable for saved projects without listing in toolbar. */
  hidden?: boolean;
  /** Standard insulator length when it differs from the voltage class's (m). */
  insDefault?: (v: VoltageSpec) => number;
  /** `ins`: insulator string length (m); omitted = the standard for this class. */
  build: (v: VoltageSpec, ins?: number) => BuiltModel;
}

// ---------------------------------------------------------------- lattice towers

interface TowerOpts {
  circuits: 1 | 2;
  strain: boolean;
  extraHeight?: number;
  baseScale?: number;
  waistScale?: number;
  banded?: boolean;
}

function latticeTower(v: VoltageSpec, o: TowerOpts, ins = v.insLen): BuiltModel {
  const B = new Builder();
  const baseScale = o.baseScale ?? 1;
  const waistScale = o.waistScale ?? 1;
  const levelStep = o.circuits === 2 ? v.vSpacing : v.vSpacing * 0.72;
  // The tower body is sized for the standard string of its voltage class; a custom
  // string length only changes the strings, so longer ones hang the conductor lower.
  const zArm0 = v.baseHeight + (o.extraHeight ?? 0) + (o.strain ? 0 : v.insLen);
  const armZ = [zArm0, zArm0 + levelStep, zArm0 + 2 * levelStep];
  const depth = Math.min(levelStep * 0.45, 2.4);
  const hwTop = Math.max(0.7, v.armLen * 0.2) * waistScale;
  const hwBase = (v.baseWidth / 2) * baseScale;
  const zWaist = armZ[0] - levelStep * 0.35;
  const zTopArm = armZ[2] + depth;
  const peakZ = zTopArm + Math.max(levelStep * 0.85, 2.2);
  const leg = Math.min(0.42, Math.max(0.15, v.baseWidth * 0.034)) * (o.strain ? 1.2 : 1);
  const brace = leg * 0.55;
  const insCol = v.kv >= 230 ? COL.glass : COL.porcelain;
  const colorAt = (z: number) =>
    o.banded ? (Math.floor((z / peakZ) * 7) % 2 === 0 ? COL.red : COL.white) : COL.steel;

  // footings (sunk so they still meet the ground on slopes)
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) B.box(sx * hwBase, sy * hwBase, -1.6, leg * 4, leg * 4, 4, COL.concrete);

  const levels = [
    ...taperLevels(0, hwBase, zWaist, hwTop),
    ...taperLevels(zWaist, hwTop, zTopArm, hwTop, 2.4).slice(1),
  ];
  latticeBody(B, levels, leg, brace, colorAt);

  const twoGW = o.circuits === 2 && v.groundWires === 2;
  const groundWires: V3[] = [];
  if (twoGW) {
    latticeBody(B, [{ z: zTopArm, hw: hwTop }, { z: peakZ, hw: 0.3 }], leg * 0.8, brace, colorAt);
    for (const s of [-1, 1]) {
      const tip = v3(s * v.armLen * 0.78, 0, peakZ);
      B.beam(v3(s * hwTop, -hwTop, zTopArm), tip, brace * 1.2, colorAt(peakZ));
      B.beam(v3(s * hwTop, hwTop, zTopArm), tip, brace * 1.2, colorAt(peakZ));
      B.beam(v3(0, 0, peakZ), tip, brace * 1.2, colorAt(peakZ));
      groundWires.push(tip);
    }
  } else {
    latticeBody(B, [{ z: zTopArm, hw: hwTop }, { z: peakZ, hw: 0.12 }], leg * 0.8, brace, colorAt);
    groundWires.push(v3(0, 0, peakZ));
  }

  const circuits: V3[][] = o.circuits === 2 ? [[], []] : [[]];
  const barrel = [1, 1.22, 1];
  for (let i = 0; i < 3; i++) {
    const sides = o.circuits === 2 ? [-1, 1] : [i % 2 === 0 ? -1 : 1];
    for (const s of sides) {
      const L = v.armLen * (o.circuits === 2 ? barrel[i] : 1);
      const z = armZ[i];
      crossarm(B, z, s, hwTop, L, depth, leg * 0.6, colorAt(z));
      const ci = o.circuits === 2 ? (s < 0 ? 0 : 1) : 0;
      if (o.strain) {
        for (const f of [-1, 1]) B.insulator(v3(s * L, f * 0.25, z), v3(s * L, f * (ins + 0.25), z - 0.3), insCol);
        // jumper loop under the arm
        const a = v3(s * L, -(ins + 0.3), z - 0.35);
        const b = v3(s * L, ins + 0.3, z - 0.35);
        const dip = ins * 0.55 + 0.8;
        let prev = a;
        for (let k = 1; k <= 8; k++) {
          const t = k / 8;
          const p = a.clone().lerp(b, t);
          p.z -= dip * 4 * t * (1 - t);
          B.beam(prev, p, 0.07, COL.alu);
          prev = p;
        }
        circuits[ci].push(v3(s * L, ins + 0.3, z - 0.35));
      } else {
        B.insulator(v3(s * L, 0, z), v3(s * L, 0, z - ins), insCol);
        circuits[ci].push(v3(s * L, 0, z - ins - 0.1));
      }
    }
  }

  // distant LOD: solid tapered body + slab arms, slightly fattened so it reads at a distance
  const L = new Builder();
  const lodCol = o.banded ? COL.red : COL.steelDark;
  L.frustum(0, hwBase * 0.8, zWaist, hwTop * 1.1, lodCol);
  L.frustum(zWaist, hwTop * 1.1, zTopArm, hwTop, lodCol);
  L.frustum(zTopArm, hwTop, peakZ, twoGW ? hwTop * 0.6 : 0.2, lodCol);
  if (twoGW) L.box(0, 0, peakZ, v.armLen * 1.6, 0.9, 0.9, lodCol);
  for (let i = 0; i < 3; i++) {
    const L2 = o.circuits === 2 ? v.armLen * barrel[i] : v.armLen;
    const sides = o.circuits === 2 ? [-1, 1] : [i % 2 === 0 ? -1 : 1];
    for (const s of sides) L.box((s * L2) / 2, 0, armZ[i] + depth / 2, L2, depth * 0.8, depth * 0.7, lodCol);
  }

  return {
    geometry: B.build(),
    lod: L.build(),
    circuits,
    groundWires,
    strain: o.strain,
    exclusive: false,
    height: peakZ,
    radius: hwBase * 1.5 + 2,
  };
}

// ---------------------------------------------------------------- poles

function steelPole(v: VoltageSpec, nCircuits: 1 | 2, ins = v.insLen): BuiltModel {
  const B = new Builder();
  const z0 = v.baseHeight * 0.82;
  const step = v.vSpacing * (nCircuits === 2 ? 1 : 0.75);
  const H = z0 + 2 * step + Math.max(2, v.vSpacing * 0.8);
  const r0 = 0.3 + v.kv / 500;
  const insCol = COL.glass;
  B.cyl(v3(0, 0, -2), v3(0, 0, H), r0, r0 * 0.42, COL.steelDark, 12);
  const circuits: V3[][] = nCircuits === 2 ? [[], []] : [[]];
  for (let i = 0; i < 3; i++) {
    const z = z0 + i * step;
    const sides = nCircuits === 2 ? [-1, 1] : [i % 2 === 0 ? -1 : 1];
    for (const s of sides) {
      const ci = nCircuits === 2 ? (s < 0 ? 0 : 1) : 0;
      if (nCircuits === 2) {
        const L = v.armLen * 0.85;
        // davit arm end is fixed; the suspension string hangs `ins` below it
        const armEnd = z + v.insLen + 0.5;
        B.beam(v3(0, 0, z + 0.2), v3(s * L, 0, armEnd), 0.16, COL.steelDark);
        B.insulator(v3(s * L, 0, armEnd), v3(s * L, 0, armEnd - ins), insCol, 0.14);
        circuits[ci].push(v3(s * L, 0, armEnd - ins - 0.1));
      } else {
        const tip = v3(s * (0.3 + ins), 0, z + 0.35);
        B.insulator(v3(s * 0.2, 0, z), tip, insCol, 0.14);
        circuits[ci].push(tip);
      }
    }
  }
  const L = new Builder();
  L.cyl(v3(0, 0, -1), v3(0, 0, H), r0 * 2.2, r0 * 1.4, COL.steelDark, 8);
  for (let i = 0; i < 3; i++) {
    const z = z0 + i * step;
    const sides = nCircuits === 2 ? [-1, 1] : [i % 2 === 0 ? -1 : 1];
    for (const s of sides) L.box(s * v.armLen * 0.45, 0, z + 0.4, v.armLen * 0.9, 0.7, 0.7, COL.steelDark);
  }
  return { geometry: B.build(), lod: L.build(), circuits, groundWires: [v3(0, 0, H)], strain: false, exclusive: false, height: H, radius: 2.5 };
}

function distributionPole(ins = 0.33): BuiltModel {
  const B = new Builder();
  const H = 11;
  B.cyl(v3(0, 0, -1.5), v3(0, 0, H), 0.2, 0.12, COL.concrete, 10);
  B.box(0, 0, 10.2, 2.5, 0.12, 0.14, COL.steelDark);
  B.beam(v3(-0.8, 0, 10.15), v3(0, 0, 9.4), 0.05, COL.steelDark);
  B.beam(v3(0.8, 0, 10.15), v3(0, 0, 9.4), 0.05, COL.steelDark);
  const phases: V3[] = [];
  for (const x of [-1.1, 0.45, 1.1]) {
    // pin insulators stand up from the crossarm
    B.cyl(v3(x, 0, 10.27), v3(x, 0, 10.27 + ins), 0.08, 0.05, COL.porcelain, 6);
    phases.push(v3(x, 0, 10.29 + ins));
  }
  B.cyl(v3(0.16, 0, 8.5), v3(0.3, 0, 8.5), 0.07, 0.07, COL.porcelain, 6);
  // pole-mounted distribution transformer
  B.cyl(v3(-0.45, 0, 7.2), v3(-0.45, 0, 8.1), 0.28, 0.28, COL.transformer, 10);
  return { geometry: B.build(), circuits: [phases], groundWires: [v3(0.32, 0, 8.5)], strain: false, exclusive: false, height: H, radius: 1.2 };
}

// ---------------------------------------------------------------- stations

function fence(B: Builder, hx: number, hy: number) {
  const corners = [v3(-hx, -hy, 0), v3(hx, -hy, 0), v3(hx, hy, 0), v3(-hx, hy, 0)];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const len = a.distanceTo(b);
    B.beam(a.clone().setZ(2.2), b.clone().setZ(2.2), 0.1, COL.fence);
    B.beam(a.clone().setZ(1.1), b.clone().setZ(1.1), 0.08, COL.fence);
    const step = Math.max(8, len / 28);
    const n = Math.max(4, Math.round(len / step));
    for (let k = 0; k < n; k++) {
      const p = a.clone().lerp(b, k / n);
      B.beam(p.clone().setZ(-0.5), p.clone().setZ(2.4), 0.14, COL.fence);
    }
  }
}

function transformer(B: Builder, G: Builder, x: number, y: number, busY: number) {
  B.box(x, y, 0.5, 8, 6, 0.6, COL.concrete);
  B.box(x, y, 2.9, 5.5, 3.6, 4.2, COL.transformer);
  B.box(x - 3.6, y, 2.6, 1.2, 3.2, 3.4, COL.steelDark);
  B.box(x + 3.6, y, 2.6, 1.2, 3.2, 3.4, COL.steelDark);
  B.cyl(v3(x - 2.4, y, 6), v3(x + 2.4, y, 6), 0.55, 0.55, COL.transformer, 8);
  for (const dx of [-1.6, 0, 1.6]) {
    B.insulator(v3(x + dx, y + 1, 5), v3(x + dx, y + 1.6, 7.4), COL.porcelain, 0.22);
    G.beam(v3(x + dx, y + 1.6, 7.4), v3(x + dx, busY, 7 + (dx === 0 ? 0 : 0)), 0.08, COL.alu);
    B.insulator(v3(x + dx * 0.6, y - 1, 5), v3(x + dx * 0.6, y - 1.5, 6.4), COL.porcelain, 0.16);
  }
}

function busbars(B: Builder, G: Builder, x0: number, x1: number, y: number) {
  for (const dy of [-1.6, 0, 1.6]) {
    G.cyl(v3(x0, y + dy, 7), v3(x1, y + dy, 7), 0.12, 0.12, COL.alu, 6);
    for (let x = x0 + 2; x < x1; x += 10) {
      B.cyl(v3(x, y + dy, 0), v3(x, y + dy, 5), 0.16, 0.12, COL.steelDark, 6);
      B.insulator(v3(x, y + dy, 5), v3(x, y + dy, 6.9), COL.porcelain, 0.18);
    }
  }
}

interface SubstationOpts {
  width: number;
  depth: number;
  baysPerSide: number;
  bayW: number;
  gantryH: number;
  transformers: number;
}

function substation(o: SubstationOpts = { width: 96, depth: 70, baysPerSide: 3, bayW: 12, gantryH: 14, transformers: 2 }): BuiltModel {
  const B = new Builder();
  const G = new Builder();
  const { width: w, depth: d, baysPerSide, bayW, gantryH, transformers } = o;
  const hx = w / 2;
  const hy = d / 2;

  // Gravel pad & perimeter security fence matching required land area (w × d)
  B.box(0, 0, -3.85, w, d, 8.2, COL.gravel);
  fence(B, hx - 1, hy - 1);

  // North & south switchyard gantries
  const gantryX = -w * 0.08;
  const gantryY = hy * 0.72;
  const g1 = gantry(B, gantryX, gantryY, 1, baysPerSide, bayW, gantryH);
  const g2 = gantry(B, gantryX, -gantryY, -1, baysPerSide, bayW, gantryH);

  // Main double busbars
  const busHalfSpan = Math.max(20, (baysPerSide * bayW) / 2 + 4);
  const busX0 = gantryX - busHalfSpan;
  const busX1 = gantryX + busHalfSpan;
  const busY = hy * 0.36;
  busbars(B, G, busX0, busX1, busY);
  busbars(B, G, busX0, busX1, -busY);

  // Power transformers evenly spaced along yard centerline
  const txSpread = Math.max(20, (busX1 - busX0) * 0.72);
  for (let i = 0; i < transformers; i++) {
    const t = transformers === 1 ? 0.5 : i / (transformers - 1);
    const txX = gantryX - txSpread / 2 + t * txSpread;
    transformer(B, G, txX, 0, busY - 1.6);
  }

  // Bus tie connecting north & south buses
  for (const dx of [-1.6, 0, 1.6]) G.beam(v3(busX0 - 1 + dx, -busY, 7), v3(busX0 - 1 + dx, busY, 7), 0.12, COL.alu);

  // Control building (scaled appropriately for larger 230/500 kV yards)
  const bldgW = Math.min(28, Math.max(12, w * 0.07));
  const bldgD = Math.min(48, Math.max(20, d * 0.18));
  const bldgH = w >= 400 ? 6.5 : 4.2;
  const bldgX = hx - bldgW / 2 - Math.max(8, w * 0.05);
  B.box(bldgX, 0, bldgH / 2 + 0.2, bldgW, bldgD, bldgH, COL.wall);
  B.box(bldgX, 0, bldgH + 0.5, bldgW + 1.6, bldgD + 1.6, 0.6, COL.roof);
  B.box(bldgX - bldgW / 2 - 0.1, -bldgD * 0.2, 1.3, 0.2, 1.8, 2.2, COL.roof);

  // Auxiliary GIS / relay hall on 500 kV (20 ha) substations
  if (w >= 400) {
    B.box(bldgX, -bldgD - 20, bldgH / 2 + 0.2, bldgW * 1.1, bldgD * 0.75, bldgH * 1.15, COL.wall);
    B.box(bldgX, -bldgD - 20, bldgH * 1.15 + 0.5, bldgW * 1.1 + 1.6, bldgD * 0.75 + 1.6, 0.6, COL.roof);
  }

  return {
    geometry: B.build(),
    glow: G.build(),
    circuits: [...g1.circuits, ...g2.circuits],
    groundWires: [...g1.gws, ...g2.gws],
    strain: false,
    exclusive: true,
    height: gantryH + 3.5,
    radius: Math.round(Math.min(w, d) * 0.52),
  };
}

function powerPlant(): BuiltModel {
  const B = new Builder();
  const G = new Builder();
  B.box(0, 0, -3.85, 124, 92, 8.2, COL.gravel);
  fence(B, 61, 45);
  // turbine hall + boiler house
  B.box(-22, -14, 11.3, 52, 30, 22, COL.wall);
  B.box(-22, -14, 22.8, 54, 32, 1.2, COL.roof);
  B.box(-34, -14, 30, 20, 22, 14, COL.steelDark);
  B.box(14, -20, 5.3, 16, 16, 10, COL.wall);
  // stacks with aviation banding
  for (const sx of [-48, -38]) {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const z0 = (i * 75) / n;
      const z1 = ((i + 1) * 75) / n;
      const r = (z: number) => 3.2 - (1.2 * z) / 75;
      B.cyl(v3(sx, 20, z0), v3(sx, 20, z1), r(z0), r(z1), i % 2 === 0 ? COL.white : COL.red, 14);
    }
  }
  // tanks
  B.cyl(v3(-20, 26, 0), v3(-20, 26, 11), 7, 7, COL.white, 16);
  B.cyl(v3(-4, 26, 0), v3(-4, 26, 11), 7, 7, COL.white, 16);
  // switchyard
  const g = gantry(B, 34, 36, 1, 3);
  busbars(B, G, 16, 52, 22);
  transformer(B, G, 26, 6, 20.4);
  transformer(B, G, 42, 6, 20.4);
  return { geometry: B.build(), glow: G.build(), circuits: g.circuits, groundWires: g.gws, strain: false, exclusive: true, height: 75, radius: 78 };
}

function solarFarm(): BuiltModel {
  const B = new Builder();
  const G = new Builder();
  B.box(0, 0, -3.9, 130, 96, 8, 0x8f9a78);
  fence(B, 64, 47);
  for (let y = -40; y <= 12; y += 5.2) {
    for (const x of [-34, 26]) {
      B.box(x, y, 1.6, 54, 3.2, 0.1, COL.panel, 0, 0.26);
      B.box(x, y, 0.7, 54, 0.12, 0.12, COL.steelDark);
      for (let px = -24; px <= 24; px += 12) B.beam(v3(x + px, y, -0.5), v3(x + px, y, 1.5), 0.12, COL.steelDark);
    }
  }
  B.box(-44, 30, 2.1, 12, 8, 3.8, COL.wall);
  B.box(-44, 30, 4.3, 13, 9, 0.5, COL.roof);
  const g = gantry(B, 30, 38, 1, 2);
  busbars(B, G, 16, 44, 24);
  transformer(B, G, 30, 12, 22.4);
  return { geometry: B.build(), glow: G.build(), circuits: g.circuits, groundWires: g.gws, strain: false, exclusive: true, height: 17.5, radius: 80 };
}

// ---------------------------------------------------------------- registry

const HV: VoltageId[] = TRANSMISSION_VOLTAGES;
const SUBTRANS: VoltageId[] = ['v34', 'v69', 'v115', 'v138'];

export const STRUCTURE_DEFS: StructureDef[] = [
  {
    id: 'dc-suspension', name: 'Double-Circuit Suspension Tower', short: 'DC Suspension', category: 'tower', icon: 'dc',
    description: 'Vertical-configuration lattice tower carrying two circuits on I-string insulators. The standard tangent structure.',
    voltages: HV, role: 'line', circuits: 2, spanFactor: 1, maxAngle: 3,
    build: (v, ins) => latticeTower(v, { circuits: 2, strain: false }, ins),
  },
  {
    id: 'sc-suspension', name: 'Single-Circuit Suspension Tower', short: 'SC Suspension', category: 'tower', icon: 'sc',
    description: 'Triangular-configuration lattice tower for one circuit.',
    voltages: HV, role: 'line', circuits: 1, spanFactor: 1, maxAngle: 3,
    build: (v, ins) => latticeTower(v, { circuits: 1, strain: false }, ins),
  },
  {
    id: 'dc-angle', name: 'Angle Tower (Double Circuit)', short: 'Angle', category: 'tower', icon: 'angle',
    description: 'Strain tower with jumper loops for line deflections up to about 30°.',
    voltages: HV, role: 'line', circuits: 2, spanFactor: 1.1, maxAngle: 30,
    build: (v, ins) => latticeTower(v, { circuits: 2, strain: true, baseScale: 1.15, waistScale: 1.2 }, ins),
  },
  {
    id: 'dc-deadend', name: 'Tension / Dead-End Tower (Double Circuit)', short: 'Dead-End', category: 'tower', icon: 'deadend',
    description: 'Heavy strain tower for terminations, section points and large angles up to 90°.',
    voltages: HV, role: 'line', circuits: 2, spanFactor: 1.25, maxAngle: 90,
    build: (v, ins) => latticeTower(v, { circuits: 2, strain: true, baseScale: 1.35, waistScale: 1.45 }, ins),
  },
  {
    id: 'sc-deadend', name: 'Tension / Dead-End Tower (Single Circuit)', short: 'SC Dead-End', category: 'tower', icon: 'scdeadend',
    description: 'Single-circuit strain tower for terminations and angles.',
    voltages: HV, role: 'line', circuits: 1, spanFactor: 1.25, maxAngle: 90,
    build: (v, ins) => latticeTower(v, { circuits: 1, strain: true, baseScale: 1.3, waistScale: 1.4 }, ins),
  },
  {
    id: 'dc-crossing', name: 'Special Crossing Tower', short: 'Crossing', category: 'tower', icon: 'crossing',
    description: 'Extra-tall strain tower with aviation banding for river, strait and valley crossings. Allows spans up to 2.5× normal.',
    voltages: HV, role: 'line', circuits: 2, spanFactor: 2.5, maxAngle: 20,
    build: (v, ins) => latticeTower(v, { circuits: 2, strain: true, extraHeight: v.baseHeight * 0.9 + 10, baseScale: 1.7, waistScale: 1.5, banded: true }, ins),
  },
  {
    id: 'pole-sc', name: 'Steel Pole (Single Circuit)', short: 'Steel Pole SC', category: 'pole', icon: 'pole',
    description: 'Tubular steel pole with line-post insulators for sub-transmission along roads.',
    voltages: SUBTRANS, role: 'line', circuits: 1, spanFactor: 0.6, maxAngle: 8,
    build: (v, ins) => steelPole(v, 1, ins),
  },
  {
    id: 'pole-dc', name: 'Steel Pole (Double Circuit)', short: 'Steel Pole DC', category: 'pole', icon: 'poledc',
    description: 'Tubular steel pole with davit arms carrying two circuits.',
    voltages: SUBTRANS, role: 'line', circuits: 2, spanFactor: 0.6, maxAngle: 8,
    build: (v, ins) => steelPole(v, 2, ins),
  },
  {
    id: 'pole-dist', name: 'Distribution Pole (13.8–34.5 kV)', short: 'Dist. Pole', category: 'pole', icon: 'dist',
    description: 'Concrete distribution pole with crossarm, pin insulators, neutral and a pole-mounted transformer.',
    voltages: ['v13', 'v34'], role: 'line', circuits: 1, spanFactor: 1, maxAngle: 15,
    insDefault: () => 0.33,
    build: (_v, ins) => distributionPole(ins),
  },
  {
    id: 'substation-69', name: '69 kV Substation', short: '69 kV S/S', category: 'substation', icon: 'substation',
    description: '69 kV transmission substation (2.0 ha required land area, 160 × 125 m). Interconnects lines of any voltage and serves local load.',
    voltages: 'any', nominalVoltage: 'v69', role: 'substation', circuits: 4, spanFactor: 1.25, loadMW: 50,
    areaHa: 2.0, footprint: [160, 125],
    build: () => substation({ width: 160, depth: 125, baysPerSide: 2, bayW: 14, gantryH: 12, transformers: 2 }),
  },
  {
    id: 'substation-138', name: '138/115 kV Substation', short: '138/115 kV S/S', category: 'substation', icon: 'substation',
    description: '138/115 kV transmission substation (5.0 ha required land area, 250 × 200 m). Interconnects lines of any voltage and serves regional load.',
    voltages: 'any', nominalVoltage: 'v138', role: 'substation', circuits: 6, spanFactor: 1.25, loadMW: 100,
    areaHa: 5.0, footprint: [250, 200],
    build: () => substation({ width: 250, depth: 200, baysPerSide: 3, bayW: 18, gantryH: 15, transformers: 2 }),
  },
  {
    id: 'substation-230', name: '230 kV Substation', short: '230 kV S/S', category: 'substation', icon: 'substation',
    description: '230 kV backbone transmission substation (6.0 ha required land area, 300 × 200 m). Interconnects lines of any voltage and serves bulk load.',
    voltages: 'any', nominalVoltage: 'v230', role: 'substation', circuits: 8, spanFactor: 1.25, loadMW: 200,
    areaHa: 6.0, footprint: [300, 200],
    build: () => substation({ width: 300, depth: 200, baysPerSide: 4, bayW: 20, gantryH: 18, transformers: 3 }),
  },
  {
    id: 'substation-500', name: '500 kV Substation', short: '500 kV S/S', category: 'substation', icon: 'substation',
    description: '500 kV extra-high-voltage substation (20.0 ha required land area, 500 × 400 m). Major grid hub interconnecting 500 kV and lower-voltage lines.',
    voltages: 'any', nominalVoltage: 'v500', role: 'substation', circuits: 12, spanFactor: 1.25, loadMW: 500,
    areaHa: 20.0, footprint: [500, 400],
    build: () => substation({ width: 500, depth: 400, baysPerSide: 6, bayW: 28, gantryH: 24, transformers: 4 }),
  },
  {
    id: 'substation', name: 'Transmission Substation', short: 'Substation', category: 'substation', icon: 'substation',
    description: 'Switchyard with six line bays, busbars, two power transformers and a control building. Terminates and interconnects lines of any voltage, and draws load.',
    voltages: 'any', role: 'substation', circuits: 6, spanFactor: 1.25, loadMW: 120, hidden: true,
    build: () => substation(),
  },
  {
    id: 'power-plant', name: 'Thermal Power Plant', short: 'Power Plant', category: 'other', icon: 'plant',
    description: 'Generating station with a three-bay switchyard. Energises every line connected to it.',
    voltages: 'any', role: 'source', circuits: 3, spanFactor: 1.25, capacityMW: 600,
    build: () => powerPlant(),
  },
  {
    id: 'solar-farm', name: 'Solar Farm', short: 'Solar Farm', category: 'other', icon: 'solar',
    description: 'Photovoltaic plant with a two-bay switchyard. Output follows the sun.',
    voltages: 'any', role: 'source', circuits: 2, spanFactor: 1.25, capacityMW: 100,
    build: () => solarFarm(),
  },
];

export const DEF_BY_ID: Record<string, StructureDef> = Object.fromEntries(STRUCTURE_DEFS.map((d) => [d.id, d]));

const cache = new Map<string, BuiltModel>();
/**
 * Built models are cached per (definition, voltage, insulator length) and shared
 * by every instance. `insLen` omitted = the standard string for that class.
 */
export function getModel(defId: string, voltage: VoltageId, insLen?: number): BuiltModel {
  const def = DEF_BY_ID[defId];
  const custom = insLen != null && insulatorRange(defId, voltage) != null;
  const key = def.voltages === 'any' ? defId : `${defId}|${voltage}${custom ? `|${insLen.toFixed(2)}` : ''}`;
  let m = cache.get(key);
  if (!m) {
    m = def.build(VOLTAGES[voltage], custom ? insLen : undefined);
    cache.set(key, m);
  }
  return m;
}

/** The model for a placed structure, including its own insulator length. */
export function modelOf(st: { defId: string; voltage: VoltageId; insLen?: number }): BuiltModel {
  return getModel(st.defId, st.voltage, st.insLen);
}

/** Standard, minimum and maximum insulator length for a line structure (m); null for stations. */
export function insulatorRange(defId: string, voltage: VoltageId): { std: number; min: number; max: number } | null {
  const def = DEF_BY_ID[defId];
  if (!def || def.role !== 'line') return null;
  const v = VOLTAGES[voltage];
  const std = def.insDefault ? def.insDefault(v) : v.insLen;
  return { std, min: Math.max(0.1, Math.round(std * 0.3 * 10) / 10), max: Math.round(std * 2 * 10) / 10 };
}

export function defSupports(def: StructureDef, v: VoltageId) {
  return def.voltages === 'any' || def.voltages.includes(v);
}
