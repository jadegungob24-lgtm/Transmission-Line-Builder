import { DEF_BY_ID, modelOf } from '../catalog/structures';
import { VOLTAGES, VoltageId } from '../catalog/voltages';
import { layoutSpan, wireHeightAt } from '../conductors/spanWires';
import { bearingDeg, distanceM } from '../core/geo';
import { structureTag } from '../core/store';
import type { Selection, Span, Structure } from '../core/types';
import { neighbours } from './connectivity';

// Plan & profile of a transmission line: the run of structures from one end of the
// line to the other (through every tower/pole with exactly two connections),
// the ground along it, and the lowest conductor of each span with its clearance.

/** Minimum ground clearance target by voltage class (m). */
export function clearanceTarget(v: VoltageId): number {
  const kv = VOLTAGES[v].kv;
  return kv >= 500 ? 12 : kv >= 230 ? 9 : kv >= 69 ? 7 : 6;
}

/** Ordered structure ids of the whole line through a structure or span, or null. */
export function lineRoute(sel: Selection, structures: Record<string, Structure>, spans: Record<string, Span>): string[] | null {
  const through = (id: string) => {
    const st = structures[id];
    return !!st && DEF_BY_ID[st.defId].role === 'line' && neighbours(id, spans).length === 2;
  };
  const walk = (from: string, prev: string) => {
    const out = [from];
    const seen = new Set([prev, from]);
    let cur = from;
    let back = prev;
    while (through(cur)) {
      const next = neighbours(cur, spans).map((n) => n.other).find((o) => o !== back);
      if (!next || seen.has(next)) break;
      out.push(next);
      seen.add(next);
      back = cur;
      cur = next;
    }
    return out;
  };
  let route: string[];
  if (sel.kind === 'span') {
    const sp = spans[sel.id];
    if (!sp) return null;
    route = [...walk(sp.a, sp.b).reverse(), ...walk(sp.b, sp.a)];
  } else {
    const nb = neighbours(sel.id, spans);
    if (!structures[sel.id] || nb.length === 0 || nb.length > 2) return null;
    route = nb.length === 1 ? [sel.id, ...walk(nb[0].other, sel.id)] : [...walk(nb[0].other, sel.id).reverse(), sel.id, ...walk(nb[1].other, sel.id)];
  }
  const no = (id: string) => structures[id]?.no ?? 0;
  if (no(route[0]) > no(route[route.length - 1])) route.reverse();
  return route.length >= 2 ? route : null;
}

export interface ProfilePoint {
  /** Chainage from the start of the line (m). */
  x: number;
  ground: number;
  cond: number;
  clear: number;
}
export interface ProfileSpan {
  from: string;
  to: string;
  voltage: VoltageId;
  x0: number;
  length: number;
  pts: ProfilePoint[];
  /** Earth wire / OPGW, if the span has one. */
  gw: { x: number; z: number }[];
  minClear: ProfilePoint;
  target: number;
  sag: number;
}
export interface ProfileStation {
  id: string;
  tag: string;
  type: string;
  strain: boolean;
  x: number;
  ground: number;
  top: number;
  /** Line deflection (°, + = turns right), null at the ends. */
  deflection: number | null;
}
export interface Profile {
  stations: ProfileStation[];
  spans: ProfileSpan[];
  length: number;
  minClear: { span: number; pt: ProfilePoint } | null;
  below: number;
}

type Ground = (lng: number, lat: number) => number | null;

/**
 * Sample the profile. `ground` returns terrain elevation in scene units (including
 * the terrain exaggeration) or null where no terrain is loaded; `cache` keeps the
 * samples of spans whose ends have not moved, so live edits stay quick.
 */
export function computeProfile(
  route: string[], structures: Record<string, Structure>, spans: Record<string, Span>,
  ground: Ground, exaggeration: number, cache: Map<string, (number | null)[]>,
): Profile | null {
  const ex = exaggeration || 1;
  const sts = route.map((id) => structures[id]);
  if (sts.some((s) => !s)) return null;
  const spanBetween = (a: string, b: string) => Object.values(spans).find((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a));

  const stations: ProfileStation[] = [];
  const out: ProfileSpan[] = [];
  let x = 0;
  for (let i = 0; i < sts.length; i++) {
    const st = sts[i];
    const m = modelOf(st);
    let deflection: number | null = null;
    if (i > 0 && i < sts.length - 1) {
      let d = bearingDeg(st, sts[i + 1]) - bearingDeg(sts[i - 1], st);
      d = ((d + 540) % 360) - 180;
      deflection = d;
    }
    stations.push({
      id: st.id, tag: structureTag(st), type: DEF_BY_ID[st.defId].short, strain: m.strain || DEF_BY_ID[st.defId].role !== 'line',
      x, ground: st.elev / ex, top: st.elev / ex + m.height, deflection,
    });
    if (i === sts.length - 1) break;

    const P = st;
    const Q = sts[i + 1];
    const sp = spanBetween(P.id, Q.id);
    const len = distanceM(P, Q);
    if (!sp) return null;
    const A = structures[sp.a];
    const B = structures[sp.b];
    const lay = layoutSpan(sp, A, B);
    const low = lay.lowest;
    const gwWire = lay.wires.filter((w) => w.kind === 1).sort((p, q) => q.a.z + q.b.z - (p.a.z + p.b.z))[0];
    const rev = sp.a !== P.id;
    const n = Math.max(8, Math.min(60, Math.round(len / 15)));
    const key = `${P.lng},${P.lat}|${Q.lng},${Q.lat}|${n}`;
    let gs = cache.get(key);
    if (!gs || gs.some((g) => g == null)) {
      gs = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        gs.push(ground(P.lng + (Q.lng - P.lng) * t, P.lat + (Q.lat - P.lat) * t));
      }
      cache.set(key, gs);
    }
    const pts: ProfilePoint[] = [];
    const gw: { x: number; z: number }[] = [];
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const tt = rev ? 1 - t : t;
      const gScene = gs[k] ?? P.elev + (Q.elev - P.elev) * t; // no terrain loaded: straight line between footings
      const gTrue = gScene / ex;
      const condScene = low ? A.elev + wireHeightAt(low, tt) : gScene;
      const clear = condScene - gScene;
      pts.push({ x: x + len * t, ground: gTrue, cond: gTrue + clear, clear });
      if (gwWire) gw.push({ x: x + len * t, z: gTrue + (A.elev + wireHeightAt(gwWire, tt) - gScene) });
    }
    // the ends of the profile ground should sit on the footings
    pts[0].ground = P.elev / ex;
    pts[pts.length - 1].ground = Q.elev / ex;
    const inner = pts.slice(1, -1);
    const minClear = (inner.length ? inner : pts).reduce((a, b) => (b.clear < a.clear ? b : a));
    out.push({ from: P.id, to: Q.id, voltage: sp.voltage, x0: x, length: len, pts, gw, minClear, target: clearanceTarget(sp.voltage), sag: lay.sag });
    x += len;
  }
  let minClear: Profile['minClear'] = null;
  out.forEach((s, i) => { if (!minClear || s.minClear.clear < minClear.pt.clear) minClear = { span: i, pt: s.minClear }; });
  return { stations, spans: out, length: x, minClear, below: out.filter((s) => s.minClear.clear < s.target).length };
}

/** 12345.6 → "12+345.6" (km + m), the usual chainage notation. */
export function chainage(m: number, digits = 0): string {
  const km = Math.floor(m / 1000);
  const rest = m - km * 1000;
  return `${km}+${rest.toFixed(digits).padStart(digits ? 4 + digits : 3, '0')}`;
}
