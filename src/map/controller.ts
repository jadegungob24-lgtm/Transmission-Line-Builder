import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl';
import { DEF_BY_ID, getModel, StructureDef } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { bearingDeg, distanceM, enuOffset, inPhilippines, LL, offsetLL } from '../core/geo';
import { checkLink, useHud, useStore } from '../core/store';
import type { Span, Structure } from '../core/types';
import { neighbours } from '../network/connectivity';
import { runtime } from './runtime';
import { GhostState, SceneLayer } from './sceneLayer';

// Turns mouse and keyboard input into construction actions, and keeps the
// placement ghost (structure + preview conductors) in sync with the cursor.

const ROUTE_END: Record<string, string> = {
  'dc-suspension': 'dc-deadend',
  'sc-suspension': 'sc-deadend',
  'pole-sc': 'pole-sc',
  'pole-dc': 'pole-dc',
  'pole-dist': 'pole-dist',
};

const GHOST = '__ghost';

export class Controller {
  private mouse: { x: number; y: number; lng: number; lat: number } | null = null;
  private rightDown: { x: number; y: number } | null = null;
  private lastGhostRot = 0;
  private elevTimer: number;
  private unsub: () => void;
  private removeDom: () => void;

  constructor(private map: MLMap, private layer: SceneLayer) {
    map.on('mousemove', this.onMove);
    map.on('click', this.onClick);
    const el = map.getCanvasContainer();
    // Camera drags (middle / right / modifier drags) live in navigation.ts.
    // Here a right-click without dragging cancels the current action.
    const down = (e: MouseEvent) => {
      if (e.button === 2) this.rightDown = { x: e.clientX, y: e.clientY };
    };
    const move = () => {};
    const up = (e: MouseEvent) => {
      if (e.button === 2 && this.rightDown) {
        if (Math.hypot(e.clientX - this.rightDown.x, e.clientY - this.rightDown.y) < 5) this.cancel();
        this.rightDown = null;
      }
    };
    const ctx = (e: Event) => e.preventDefault();
    const leave = () => {
      this.mouse = null;
      this.layer.setGhost(null);
      this.layer.setHighlight(null);
    };
    el.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    el.addEventListener('contextmenu', ctx);
    el.addEventListener('mouseleave', leave);
    this.removeDom = () => {
      el.removeEventListener('mousedown', down, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      el.removeEventListener('contextmenu', ctx);
      el.removeEventListener('mouseleave', leave);
    };

    this.unsub = useStore.subscribe((s, p) => {
      if (s.tool !== p.tool || s.buildDefId !== p.buildDefId || s.voltage !== p.voltage || s.chainFrom !== p.chainFrom ||
          s.ghostRot !== p.ghostRot || s.autoConnect !== p.autoConnect) this.refresh();
    });

    // terrain tiles stream in progressively, so re-sample structure elevations
    this.elevTimer = window.setInterval(() => this.resampleElevations(), 1500);
  }

  dispose() {
    this.map.off('mousemove', this.onMove);
    this.map.off('click', this.onClick);
    this.removeDom();
    this.unsub();
    window.clearInterval(this.elevTimer);
  }

  private elev(p: LL): number {
    return this.map.queryTerrainElevation(p) ?? 0;
  }

  private resampleElevations() {
    const { structures, movingId } = useStore.getState();
    const b = this.map.getBounds();
    if (this.map.getZoom() < 9) return;
    const e: Record<string, number> = {};
    for (const s of Object.values(structures)) {
      if (s.id === movingId || !b.contains([s.lng, s.lat])) continue;
      const z = this.map.queryTerrainElevation(s);
      if (z != null) e[s.id] = z;
    }
    useStore.getState().setElevs(e);
  }

  // ------------------------------------------------------------------ helpers

  private msg(msg: string, ok = true) {
    const h = useHud.getState();
    if (h.msg !== msg || h.ok !== ok) useHud.setState({ msg, ok });
  }

  private ghostStruct(def: StructureDef, p: LL, rotation: number, id = GHOST): Structure {
    const s = useStore.getState();
    const voltage = def.voltages === 'any' || def.voltages.includes(s.voltage) ? s.voltage : def.voltages[def.voltages.length - 1];
    return { id, defId: def.id, voltage, lng: p.lng, lat: p.lat, rotation, manualRot: false, elev: this.elev(p), builtAt: 0 };
  }

  /** Placement validity for a new or moved structure. */
  private siteProblem(st: Structure, ignore: Set<string> = new Set()): string | null {
    if (!inPhilippines(st.lng, st.lat)) return 'Outside Philippine territory';
    if (st.elev < 0.5) return 'Cannot build on water';
    const r = getModel(st.defId, st.voltage).radius;
    const { structures } = useStore.getState();
    for (const o of Object.values(structures)) {
      if (o.id === st.id || ignore.has(o.id)) continue;
      const lim = (r + getModel(o.defId, o.voltage).radius) * 0.75;
      if (Math.abs(o.lat - st.lat) > 0.01) continue;
      if (distanceM(o, st) < lim) return `Too close to ${DEF_BY_ID[o.defId].short}`;
    }
    return null;
  }

  /** Validity of an existing structure at a new position (site + its spans' lengths). */
  private moveProblem(moved: Structure): string | null {
    const prob = this.siteProblem(moved);
    if (prob) return prob;
    const { structures, spans } = useStore.getState();
    for (const nb of neighbours(moved.id, spans)) {
      const other = structures[nb.other];
      if (!other) continue;
      const V = VOLTAGES[nb.span.voltage];
      const max = V.maxSpan * Math.min(DEF_BY_ID[moved.defId].spanFactor, DEF_BY_ID[other.defId].spanFactor);
      const d = distanceM(moved, other);
      if (d > max) return `Span too long: ${d.toFixed(0)} m (max ${max.toFixed(0)} m)`;
    }
    return null;
  }

  /**
   * Move a structure to typed-in coordinates. If the spot is off screen the camera
   * goes there first, so the terrain under it is loaded before the elevation is read.
   * Resolves to an error message, or null once the structure has moved.
   */
  async relocate(id: string, p: LL): Promise<string | null> {
    if (!inPhilippines(p.lng, p.lat)) return 'Outside Philippine territory';
    const map = this.map;
    const back = { center: map.getCenter(), zoom: map.getZoom() };
    let flew = false;
    if (!map.getBounds().contains([p.lng, p.lat]) || map.getZoom() < 13) {
      flew = true;
      runtime.nav?.interrupt();
      await new Promise<void>((done) => {
        map.once('moveend', () => (map.areTilesLoaded() ? done() : map.once('idle', () => done())));
        map.easeTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), duration: 900 });
      });
    }
    const st = useStore.getState().structures[id];
    if (!st) return 'Structure no longer exists';
    const moved = { ...st, lng: p.lng, lat: p.lat, elev: this.elev(p) };
    const prob = this.moveProblem(moved);
    if (prob) {
      // rejected: take the camera back to where the structure still is
      if (flew) map.easeTo({ ...back, duration: 900 });
      return prob;
    }
    useStore.getState().patchStructure(id, { lng: p.lng, lat: p.lat, elev: moved.elev }, true);
    this.refresh();
    return null;
  }

  private ghostSpan(A: Structure, B: Structure, extra?: Record<string, Span>) {
    const s = useStore.getState();
    const spans = extra ? { ...s.spans, ...extra } : s.spans;
    const chk = checkLink(A, B, spans, s.voltage);
    const span: Span = {
      id: `g${A.id}${B.id}`, a: A.id, b: B.id,
      voltage: chk.ok ? chk.voltage : DEF_BY_ID[A.defId].voltages !== 'any' ? A.voltage : B.voltage,
      slotsA: chk.ok ? chk.slotsA : getModel(A.defId, A.voltage).exclusive ? [0] : [],
      slotsB: chk.ok ? chk.slotsB : getModel(B.defId, B.voltage).exclusive ? [0] : [],
      builtAt: 0,
    };
    return { span, chk };
  }

  private routeDef(): StructureDef {
    const s = useStore.getState();
    return DEF_BY_ID[s.buildDefId && ROUTE_END[s.buildDefId] ? s.buildDefId : 'dc-suspension'];
  }

  private planRoute(start: Structure, endP: LL, endSt: Structure | null) {
    const s = useStore.getState();
    const def = this.routeDef();
    const endDef = DEF_BY_ID[ROUTE_END[def.id]];
    const V = VOLTAGES[this.ghostStruct(def, endP, 0).voltage];
    const end = endSt ?? this.ghostStruct(endDef, endP, 0, '__r_end');
    const [e, n] = enuOffset(start, end);
    const len = Math.hypot(e, n);
    const spacing = V.maxSpan * def.spanFactor * 0.82;
    const count = Math.max(1, Math.ceil(len / spacing));
    if (count > 150) return { problem: 'Route too long for one click: add a waypoint first', structs: [], valid: [], spans: [] as GhostState['spans'] };
    const brg = bearingDeg(start, end);
    const nodes: Structure[] = [start];
    for (let i = 1; i < count; i++) {
      const p = offsetLL(start, (e * i) / count, (n * i) / count);
      nodes.push(this.ghostStruct(def, p, brg, `__r${i}`));
    }
    if (!endSt) end.rotation = brg;
    nodes.push(end);
    const newOnes = nodes.filter((x) => !s.structures[x.id]);
    const ignore = new Set(nodes.map((x) => x.id));
    const valid = newOnes.map((x) => !this.siteProblem(x, ignore));
    let problem: string | null = null;
    const bad = newOnes.findIndex((_, i) => !valid[i]);
    if (bad >= 0) problem = `Tower ${bad + 1}: ${this.siteProblem(newOnes[bad], ignore)}`;
    const spans: GhostState['spans'] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const g = this.ghostSpan(nodes[i], nodes[i + 1]);
      spans.push({ A: nodes[i], B: nodes[i + 1], span: g.span, valid: g.chk.ok });
      if (!g.chk.ok && !problem) problem = g.chk.reason;
    }
    return { problem, structs: newOnes, valid, spans, nodes, len, count };
  }

  // ------------------------------------------------------------------ ghost / hover

  refresh() {
    if (this.mouse) this.update(this.mouse.x, this.mouse.y, { lng: this.mouse.lng, lat: this.mouse.lat });
    else this.layer.setGhost(null);
  }

  private onMove = (e: MapMouseEvent) => {
    this.mouse = { x: e.point.x, y: e.point.y, lng: e.lngLat.lng, lat: e.lngLat.lat };
    useHud.setState({ lng: e.lngLat.lng, lat: e.lngLat.lat, elev: this.elev(e.lngLat) / (useStore.getState().env.exaggeration || 1) });
    this.update(e.point.x, e.point.y, e.lngLat);
  };

  private update(px: number, py: number, p: LL) {
    const s = useStore.getState();
    const hit = this.layer.pick(px, py, s.tool === 'select' || s.tool === 'bulldoze');
    const hitSt = hit?.kind === 'structure' ? s.structures[hit.id] : null;
    this.map.getCanvas().style.cursor = hit ? 'pointer' : s.tool === 'select' ? '' : 'crosshair';

    switch (s.tool) {
      case 'select': {
        this.layer.setGhost(null);
        this.layer.setHighlight(hit ? { ...hit, mode: 'hover' } : null);
        this.msg(hit ? 'Click to inspect' : '');
        return;
      }
      case 'bulldoze': {
        this.layer.setGhost(null);
        this.layer.setHighlight(hit ? { ...hit, mode: 'delete' } : null);
        this.msg(hit ? `Click to demolish ${hit.kind === 'span' ? 'this span' : DEF_BY_ID[s.structures[hit.id].defId].short}` : 'Bulldozer: click a structure or conductor', !!hit || true);
        return;
      }
      case 'move': {
        if (s.movingId) {
          const st = s.structures[s.movingId];
          if (!st) return;
          s.patchStructure(st.id, { lng: p.lng, lat: p.lat, elev: this.elev(p) }, true);
          const prob = this.moveProblem(useStore.getState().structures[st.id]);
          this.layer.setHighlight({ kind: 'structure', id: st.id, mode: prob ? 'delete' : 'hover' });
          this.msg(prob ?? 'Click to drop · T rotate · right-click to cancel', !prob);
        } else {
          this.layer.setHighlight(hitSt ? { kind: 'structure', id: hitSt.id, mode: 'hover' } : null);
          this.msg(hitSt ? 'Click to pick up' : 'Move: click a structure to pick it up');
        }
        this.layer.setGhost(null);
        return;
      }
      case 'connect': {
        const from = s.chainFrom ? s.structures[s.chainFrom] : null;
        this.layer.setHighlight(hitSt ? { kind: 'structure', id: hitSt.id, mode: 'hover' } : from ? { kind: 'structure', id: from.id, mode: 'select' } : null);
        if (from && hitSt && hitSt.id !== from.id) {
          const g = this.ghostSpan(from, hitSt);
          this.layer.setGhost({ structures: [], valid: [], spans: [{ A: from, B: hitSt, span: g.span, valid: g.chk.ok }] });
          this.msg(g.chk.ok ? `Click to string ${VOLTAGES[g.chk.voltage].label} conductors · ${g.chk.dist.toFixed(0)} m` : g.chk.reason, g.chk.ok);
        } else {
          this.layer.setGhost(null);
          this.msg(from ? 'Click the next structure to string conductors · right-click to stop' : 'Click a structure to start stringing conductors');
        }
        return;
      }
      case 'route': {
        const def = this.routeDef();
        const from = s.chainFrom ? s.structures[s.chainFrom] : null;
        if (!from) {
          this.layer.setHighlight(hitSt ? { kind: 'structure', id: hitSt.id, mode: 'hover' } : null);
          if (hitSt) {
            this.layer.setGhost(null);
            this.msg('Click to start the route from this structure');
          } else {
            const g = this.ghostStruct(DEF_BY_ID[ROUTE_END[def.id]], p, this.lastGhostRot);
            const prob = this.siteProblem(g);
            this.layer.setGhost({ structures: [g], valid: [!prob], spans: [] });
            this.msg(prob ?? `Route (${def.short}): click the starting point`, !prob);
          }
          return;
        }
        this.layer.setHighlight({ kind: 'structure', id: from.id, mode: 'select' });
        const plan = this.planRoute(from, hitSt ?? p, hitSt && hitSt.id !== from.id ? hitSt : null);
        this.layer.setGhost({ structures: plan.structs, valid: plan.valid, spans: plan.spans });
        this.msg(plan.problem ?? `${(plan.len! / 1000).toFixed(2)} km · ${plan.structs.length} new structures · click to build`, !plan.problem);
        return;
      }
      case 'build': {
        const def = s.buildDefId ? DEF_BY_ID[s.buildDefId] : null;
        if (!def) return;
        const from = s.chainFrom ? s.structures[s.chainFrom] : null;
        if (hitSt && hitSt.id !== from?.id) {
          this.layer.setHighlight({ kind: 'structure', id: hitSt.id, mode: 'hover' });
          if (from && s.autoConnect) {
            const g = this.ghostSpan(from, hitSt);
            this.layer.setGhost({ structures: [], valid: [], spans: [{ A: from, B: hitSt, span: g.span, valid: g.chk.ok }] });
            this.msg(g.chk.ok ? `Click to connect to ${DEF_BY_ID[hitSt.defId].short} · ${g.chk.dist.toFixed(0)} m` : g.chk.reason, g.chk.ok);
          } else {
            this.layer.setGhost(null);
            this.msg(`Click to continue the line from this ${DEF_BY_ID[hitSt.defId].short}`);
          }
          return;
        }
        this.layer.setHighlight(from ? { kind: 'structure', id: from.id, mode: 'select' } : null);
        let rot = s.ghostRot;
        if (rot == null) {
          if (from) rot = def.role === 'line' ? bearingDeg(from, p) : bearingDeg(p, from);
          else rot = this.lastGhostRot;
        }
        this.lastGhostRot = rot;
        const g = this.ghostStruct(def, p, rot);
        let prob = this.siteProblem(g);
        const spans: GhostState['spans'] = [];
        if (from && s.autoConnect) {
          const gs = this.ghostSpan(from, g);
          spans.push({ A: from, B: g, span: gs.span, valid: gs.chk.ok });
          if (!prob && !gs.chk.ok) prob = gs.chk.reason;
          if (!prob) {
            const V = VOLTAGES[gs.span.voltage];
            this.msg(`${def.short} · ${V.label} · span ${gs.chk.dist.toFixed(0)} m · click to place, right-click to end line`, true);
          }
        } else if (!prob) {
          this.msg(`${def.short} · T to rotate · click to place`, true);
        }
        if (prob) this.msg(prob, false);
        this.layer.setGhost({ structures: [g], valid: [!prob], spans });
        return;
      }
    }
  }

  // ------------------------------------------------------------------ actions

  private onClick = (e: MapMouseEvent) => {
    const s = useStore.getState();
    const p = e.lngLat;
    const hit = this.layer.pick(e.point.x, e.point.y, s.tool === 'select' || s.tool === 'bulldoze');
    const hitSt = hit?.kind === 'structure' ? s.structures[hit.id] : null;

    switch (s.tool) {
      case 'select':
        s.set({ selected: hit });
        break;
      case 'bulldoze':
        if (hit?.kind === 'structure') s.removeStructure(hit.id);
        else if (hit?.kind === 'span') s.removeSpan(hit.id);
        break;
      case 'move':
        if (s.movingId) {
          const h = useHud.getState();
          if (!h.ok) return;
          s.set({ movingId: null, moveOrigin: null, selected: { kind: 'structure', id: s.movingId } });
        } else if (hitSt) {
          s.set({ movingId: hitSt.id, moveOrigin: { lng: hitSt.lng, lat: hitSt.lat, rotation: hitSt.rotation } });
        }
        break;
      case 'connect':
        if (!hitSt) return;
        if (s.chainFrom && s.chainFrom !== hitSt.id) {
          const err = s.connect(s.chainFrom, hitSt.id);
          if (err) return this.msg(err, false);
        }
        s.set({ chainFrom: hitSt.id });
        break;
      case 'route': {
        if (!s.chainFrom) {
          if (hitSt) s.set({ chainFrom: hitSt.id });
          else {
            const def = this.routeDef();
            const g = this.ghostStruct(DEF_BY_ID[ROUTE_END[def.id]], p, this.lastGhostRot);
            if (this.siteProblem(g)) return;
            const { id: _i, builtAt: _b, ...rest } = g;
            s.set({ chainFrom: s.placeStructure(rest) });
          }
          break;
        }
        const from = s.structures[s.chainFrom];
        const plan = this.planRoute(from, hitSt ?? p, hitSt && hitSt.id !== from.id ? hitSt : null);
        if (plan.problem || !plan.nodes) return;
        const t0 = performance.now();
        const ids = new Map<string, string>();
        plan.nodes.forEach((n, i) => {
          if (useStore.getState().structures[n.id]) ids.set(n.id, n.id);
          else {
            const { id: _i, builtAt: _b, ...rest } = n;
            ids.set(n.id, useStore.getState().placeStructure(rest, t0 + i * 110));
          }
        });
        for (let i = 0; i < plan.nodes.length - 1; i++) {
          useStore.getState().connect(ids.get(plan.nodes[i].id)!, ids.get(plan.nodes[i + 1].id)!, t0 + (i + 1) * 110 + 300);
        }
        const last = ids.get(plan.nodes[plan.nodes.length - 1].id)!;
        s.set({ chainFrom: last });
        break;
      }
      case 'build': {
        const def = s.buildDefId ? DEF_BY_ID[s.buildDefId] : null;
        if (!def) return;
        if (hitSt && hitSt.id !== s.chainFrom) {
          if (s.chainFrom && s.autoConnect) {
            const err = s.connect(s.chainFrom, hitSt.id);
            if (err) return this.msg(err, false);
          }
          s.set({ chainFrom: hitSt.id });
          break;
        }
        if (!useHud.getState().ok) return;
        const g = this.ghostStruct(def, p, this.lastGhostRot);
        if (this.siteProblem(g)) return;
        const { id: _i, builtAt: _b, ...rest } = g;
        const id = s.placeStructure({ ...rest, manualRot: s.ghostRot != null });
        if (s.chainFrom && s.autoConnect) s.connect(s.chainFrom, id);
        s.set({ chainFrom: id, ghostRot: null });
        break;
      }
    }
    this.refresh();
  };

  /** Right-click / Escape: step back out of the current action. */
  cancel() {
    const s = useStore.getState();
    if (s.movingId && s.moveOrigin) {
      s.patchStructure(s.movingId, { ...s.moveOrigin, elev: this.elev(s.moveOrigin) }, true);
      s.set({ movingId: null, moveOrigin: null });
    } else if (s.chainFrom) {
      s.set({ chainFrom: null, ghostRot: null });
    } else if (s.tool !== 'select') {
      s.setTool('select');
    } else {
      s.set({ selected: null });
    }
    this.msg('');
    this.refresh();
  }

  rotate(deg: number) {
    const s = useStore.getState();
    if ((s.tool === 'build' || s.tool === 'route') && !s.movingId) s.set({ ghostRot: (((s.ghostRot ?? this.lastGhostRot) + deg) % 360 + 360) % 360 });
    else s.rotateSelected(deg);
    this.refresh();
  }
}
