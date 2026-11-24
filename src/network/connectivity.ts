import { DEF_BY_ID } from '../catalog/structures';
import { bearingDeg, distanceM } from '../core/geo';
import type { Span, Structure } from '../core/types';

// Connectivity only (no load flow): a structure is energised when a path of
// spans links it to a generating source.

export interface NetworkInfo {
  energizedStructures: Set<string>;
  energizedSpans: Set<string>;
  islands: number;
  energizedIslands: number;
  capacityMW: number;
  solarMW: number;
  loadMW: number;
  servedMW: number;
  circuitKm: Record<string, number>;
  routeKm: number;
  /** Line structures whose deflection angle exceeds what their type is meant for. */
  angleWarnings: Record<string, number>;
}

export function neighbours(id: string, spans: Record<string, Span>): { span: Span; other: string }[] {
  const out: { span: Span; other: string }[] = [];
  for (const s of Object.values(spans)) {
    if (s.a === id) out.push({ span: s, other: s.b });
    else if (s.b === id) out.push({ span: s, other: s.a });
  }
  return out;
}

/** Deflection angle of the line at a structure with exactly two spans, else null. */
export function lineAngle(st: Structure, structures: Record<string, Structure>, spans: Record<string, Span>): number | null {
  const nb = neighbours(st.id, spans);
  if (nb.length !== 2) return null;
  const b1 = bearingDeg(st, structures[nb[0].other]);
  const b2 = bearingDeg(st, structures[nb[1].other]);
  let d = Math.abs(b1 - b2) % 360;
  if (d > 180) d = 360 - d;
  return 180 - d;
}

/** Warning remark when a structure's deflection angle exceeds its design limit, else null. */
export function angleRemark(st: Structure, angle: number | null): string | null {
  const d = DEF_BY_ID[st.defId];
  if (!d || d.role !== 'line' || d.maxAngle == null || angle == null) return null;
  if (angle <= d.maxAngle + 0.5) return null;
  if (angle > 90) return `Exceeds ${d.maxAngle}° limit (above 90° max)`;
  if (angle > 30) return `Exceeds ${d.maxAngle}° limit — use Dead-End tower`;
  return `Exceeds ${d.maxAngle}° limit — use Angle or Dead-End tower`;
}

export function computeNetwork(structures: Record<string, Structure>, spans: Record<string, Span>): NetworkInfo {
  const adj = new Map<string, { span: Span; other: string }[]>();
  for (const id of Object.keys(structures)) adj.set(id, []);
  for (const s of Object.values(spans)) {
    adj.get(s.a)?.push({ span: s, other: s.b });
    adj.get(s.b)?.push({ span: s, other: s.a });
  }

  const info: NetworkInfo = {
    energizedStructures: new Set(), energizedSpans: new Set(), islands: 0, energizedIslands: 0,
    capacityMW: 0, solarMW: 0, loadMW: 0, servedMW: 0, circuitKm: {}, routeKm: 0, angleWarnings: {},
  };

  const seen = new Set<string>();
  for (const start of Object.keys(structures)) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const id = queue.pop()!;
      comp.push(id);
      for (const n of adj.get(id) ?? []) {
        if (!seen.has(n.other)) {
          seen.add(n.other);
          queue.push(n.other);
        }
      }
    }
    let gen = 0;
    let load = 0;
    for (const id of comp) {
      const d = DEF_BY_ID[structures[id].defId];
      gen += d.capacityMW ?? 0;
      load += d.loadMW ?? 0;
      if (d.id === 'solar-farm') info.solarMW += d.capacityMW ?? 0;
    }
    info.capacityMW += gen;
    info.loadMW += load;
    if (comp.length > 1) info.islands++;
    if (gen > 0) {
      if (comp.length > 1) info.energizedIslands++;
      info.servedMW += Math.min(gen, load);
      for (const id of comp) {
        info.energizedStructures.add(id);
        for (const n of adj.get(id) ?? []) info.energizedSpans.add(n.span.id);
      }
    }
  }

  for (const s of Object.values(spans)) {
    const A = structures[s.a];
    const B = structures[s.b];
    if (!A || !B) continue;
    const km = distanceM(A, B) / 1000;
    const circuits = Math.max(1, Math.min(
      s.slotsA.length || DEF_BY_ID[A.defId].circuits,
      s.slotsB.length || DEF_BY_ID[B.defId].circuits,
    ));
    info.routeKm += km;
    info.circuitKm[s.voltage] = (info.circuitKm[s.voltage] ?? 0) + km * circuits;
  }

  for (const st of Object.values(structures)) {
    const d = DEF_BY_ID[st.defId];
    if (d.role !== 'line' || d.maxAngle == null) continue;
    const a = lineAngle(st, structures, spans);
    if (a != null && a > d.maxAngle + 0.5) info.angleWarnings[st.id] = a;
  }
  return info;
}
