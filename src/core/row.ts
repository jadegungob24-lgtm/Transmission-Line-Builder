import { DEF_BY_ID } from '../catalog/structures';
import { VOLTAGES, type VoltageId } from '../catalog/voltages';
import { distanceM, enuOffset, offsetLL, type LL } from './geo';
import { structureTag } from './store';
import type { Span, Structure } from './types';

// Right-of-Way (ROW) corridor geometry along transmission line alignments.
// Offsets each contiguous same-voltage chain of spans to left & right by
// VOLTAGES[voltage].rowHalfWidthM (NGCP Circular No. 2010-17, metres from
// centerline), with clean miter joins at every intermediate angle tower.

export interface AlignmentChain {
  voltage: VoltageId;
  halfWidthM: number;
  structureIds: string[];
  label: string;
}

export interface RowCorridorGeo {
  voltage: VoltageId;
  halfWidthM: number;
  /** NGCP voltage color code (hex) for centerline & ROW corridor styling. */
  color: string;
  label: string;
  lengthM: number;
  areaM2: number;
  centerline: LL[];
  left: LL[];
  right: LL[];
  /** Closed polygon ring (first === last) enclosing the full ROW corridor. */
  polygon: LL[];
}

export interface Point2D {
  x: number;
  y: number;
}

export interface RowCorridorPlan {
  voltage: VoltageId;
  halfWidthM: number;
  label: string;
  lengthM: number;
  areaM2: number;
  centerline: Point2D[];
  left: Point2D[];
  right: Point2D[];
  /** Closed polygon vertices (without repeating the first vertex; suitable for closed LwPolyline). */
  ring: Point2D[];
}

const MAX_MITER = 3.0;

/**
 * Compute left-hand unit normal for a 2D vector (dx, dy).
 * Returns null if the segment has zero length.
 */
function leftNormal(dx: number, dy: number): [number, number] | null {
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return [-dy / len, dx / len];
}

/**
 * Given incoming and outgoing unit left normals at a vertex, return the
 * miter offset vector [mx, my] for a corridor half-width `w` on the left side
 * (right side is simply [-mx, -my]).
 */
function miterOffset(
  prevN: [number, number] | null,
  nextN: [number, number] | null,
  w: number,
): [number, number] {
  if (!prevN && !nextN) return [0, 0];
  if (!prevN) return [nextN![0] * w, nextN![1] * w];
  if (!nextN) return [prevN[0] * w, prevN[1] * w];
  const bx = prevN[0] + nextN[0];
  const by = prevN[1] + nextN[1];
  const blen = Math.hypot(bx, by);
  if (blen < 1e-6) {
    // 180° reversal fallback
    return [prevN[0] * w, prevN[1] * w];
  }
  const ux = bx / blen;
  const uy = by / blen;
  const cosHalf = ux * prevN[0] + uy * prevN[1];
  const scale = cosHalf > 1 / MAX_MITER ? 1 / cosHalf : MAX_MITER;
  return [ux * w * scale, uy * w * scale];
}

/**
 * Partition all spans into contiguous same-voltage alignment chains.
 * Chains stop at endpoints, substations/power plants, voltage transitions,
 * and T-junctions (degree != 2 for that voltage).
 */
export function traceAlignmentChains(
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
): AlignmentChain[] {
  const byVoltage = new Map<VoltageId, Span[]>();
  for (const sp of Object.values(spans)) {
    if (!structures[sp.a] || !structures[sp.b]) continue;
    let arr = byVoltage.get(sp.voltage);
    if (!arr) {
      arr = [];
      byVoltage.set(sp.voltage, arr);
    }
    arr.push(sp);
  }

  const chains: AlignmentChain[] = [];

  for (const [voltage, vSpans] of byVoltage) {
    const halfWidthM = VOLTAGES[voltage].rowHalfWidthM;
    if (!(halfWidthM > 0)) continue;

    const adj = new Map<string, { span: Span; other: string }[]>();
    for (const sp of vSpans) {
      if (!adj.has(sp.a)) adj.set(sp.a, []);
      if (!adj.has(sp.b)) adj.set(sp.b, []);
      adj.get(sp.a)!.push({ span: sp, other: sp.b });
      adj.get(sp.b)!.push({ span: sp, other: sp.a });
    }

    const isPassThrough = (id: string) => {
      const st = structures[id];
      if (!st) return false;
      if (DEF_BY_ID[st.defId]?.role !== 'line') return false;
      return (adj.get(id)?.length ?? 0) === 2;
    };

    const visitedSpans = new Set<string>();

    const walkFrom = (startId: string, firstEdge: { span: Span; other: string }) => {
      const ids: string[] = [startId];
      let curr = startId;
      let edge: { span: Span; other: string } | undefined = firstEdge;

      while (edge && !visitedSpans.has(edge.span.id)) {
        visitedSpans.add(edge.span.id);
        const next = edge.other;
        ids.push(next);
        curr = next;
        if (!isPassThrough(curr)) break;
        edge = adj.get(curr)?.find((e) => !visitedSpans.has(e.span.id));
      }

      if (ids.length >= 2) {
        // Order chain cleanly from lower structure number to higher
        const firstSt = structures[ids[0]];
        const lastSt = structures[ids[ids.length - 1]];
        if ((firstSt.no ?? 0) > (lastSt.no ?? 0)) ids.reverse();
        const aTag = structureTag(structures[ids[0]]);
        const bTag = structureTag(structures[ids[ids.length - 1]]);
        chains.push({
          voltage,
          halfWidthM,
          structureIds: ids,
          label: `${aTag} – ${bTag} (${VOLTAGES[voltage].label}, ±${halfWidthM} m ROW)`,
        });
      }
    };

    // Start from every terminal / junction / station node first
    const terminals = Array.from(adj.keys())
      .filter((id) => !isPassThrough(id))
      .sort((a, b) => (structures[a].no ?? 0) - (structures[b].no ?? 0));

    for (const startId of terminals) {
      for (const edge of adj.get(startId) ?? []) {
        if (!visitedSpans.has(edge.span.id)) walkFrom(startId, edge);
      }
    }

    // Any remaining unvisited spans belong to closed loops
    for (const sp of vSpans) {
      if (!visitedSpans.has(sp.id)) {
        walkFrom(sp.a, { span: sp, other: sp.b });
      }
    }
  }

  return chains;
}

/** Build WGS 84 ROW corridors for MapLibre map rendering and Google Earth KMZ export. */
export function buildRowCorridorsGeo(
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
): RowCorridorGeo[] {
  const chains = traceAlignmentChains(structures, spans);
  const out: RowCorridorGeo[] = [];

  for (const ch of chains) {
    const sts = ch.structureIds.map((id) => structures[id]).filter(Boolean);
    if (sts.length < 2) continue;

    // Segment unit left normals in local East/North metres
    const segNormals: ([number, number] | null)[] = [];
    let lengthM = 0;
    for (let i = 0; i < sts.length - 1; i++) {
      const [e, n] = enuOffset(sts[i], sts[i + 1]);
      lengthM += distanceM(sts[i], sts[i + 1]);
      segNormals.push(leftNormal(e, n));
    }

    const left: LL[] = [];
    const right: LL[] = [];
    for (let i = 0; i < sts.length; i++) {
      const prevN = i > 0 ? segNormals[i - 1] : null;
      const nextN = i < segNormals.length ? segNormals[i] : null;
      const [mx, my] = miterOffset(prevN, nextN, ch.halfWidthM);
      left.push(offsetLL(sts[i], mx, my));
      right.push(offsetLL(sts[i], -mx, -my));
    }

    const centerline: LL[] = sts.map((s) => ({ lng: s.lng, lat: s.lat }));
    const polygon: LL[] = [...left, ...right.slice().reverse(), left[0]];
    out.push({
      voltage: ch.voltage,
      halfWidthM: ch.halfWidthM,
      color: VOLTAGES[ch.voltage].centerlineColor,
      label: ch.label,
      lengthM,
      areaM2: lengthM * ch.halfWidthM * 2,
      centerline,
      left,
      right,
      polygon,
    });
  }

  return out;
}

function polygonArea(ring: Point2D[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Build PRS92 / PTM planar ROW corridors (Easting/Northing metres) for AutoCAD DWG export. */
export function buildRowCorridorsPlan(
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
  coords: Map<string, { x: number; y: number }>,
): RowCorridorPlan[] {
  const chains = traceAlignmentChains(structures, spans);
  const out: RowCorridorPlan[] = [];

  for (const ch of chains) {
    const pts = ch.structureIds.map((id) => coords.get(id)).filter((p): p is { x: number; y: number } => !!p);
    if (pts.length < 2) continue;

    const segNormals: ([number, number] | null)[] = [];
    let lengthM = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      lengthM += Math.hypot(dx, dy);
      segNormals.push(leftNormal(dx, dy));
    }

    const left: Point2D[] = [];
    const right: Point2D[] = [];
    for (let i = 0; i < pts.length; i++) {
      const prevN = i > 0 ? segNormals[i - 1] : null;
      const nextN = i < segNormals.length ? segNormals[i] : null;
      const [mx, my] = miterOffset(prevN, nextN, ch.halfWidthM);
      left.push({ x: pts[i].x + mx, y: pts[i].y + my });
      right.push({ x: pts[i].x - mx, y: pts[i].y - my });
    }

    const centerline: Point2D[] = pts.map((p) => ({ x: p.x, y: p.y }));
    const ring: Point2D[] = [...left, ...right.slice().reverse()];
    out.push({
      voltage: ch.voltage,
      halfWidthM: ch.halfWidthM,
      label: ch.label,
      lengthM,
      areaM2: polygonArea(ring),
      centerline,
      left,
      right,
      ring,
    });
  }

  return out;
}
