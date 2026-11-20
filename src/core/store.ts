import { create } from 'zustand';
import { DEF_BY_ID, getModel } from '../catalog/structures';
import { VOLTAGES, VoltageId } from '../catalog/voltages';
import { computeNetwork, neighbours, NetworkInfo } from '../network/connectivity';
import { bearingDeg, distanceM, enuOffset, LL, offsetLL } from './geo';
import type { ProjectMeta, Selection, Span, Structure, Tool } from './types';

const D2R = Math.PI / 180;
/** Single-network save used before projects existed; migrated into the first project. */
const SAVE_KEY = 'phgrid.save.v1';
const PROJECTS_KEY = 'phgrid.projects.v1';
const projectKey = (id: string) => `phgrid.project.${id}`;
let idSeq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export interface Env {
  wind: number;
  rain: boolean;
  clouds: boolean;
  shadows: boolean;
  glow: boolean;
  flow: boolean;
  /** Slowly orbit a structure or span after double-clicking it. */
  orbit: boolean;
  basemap: 'satellite' | 'streets' | 'topo';
  labels: boolean;
  exaggeration: number;
}

export type LinkCheck =
  | { ok: true; voltage: VoltageId; slotsA: number[]; slotsB: number[]; dist: number }
  | { ok: false; reason: string; dist: number };

interface State {
  structures: Record<string, Structure>;
  spans: Record<string, Span>;
  network: NetworkInfo;

  tool: Tool;
  buildDefId: string | null;
  voltage: VoltageId;
  chainFrom: string | null;
  selected: Selection | null;
  movingId: string | null;
  moveOrigin: { lng: number; lat: number; rotation: number } | null;
  autoConnect: boolean;
  autoOrient: boolean;
  /** Manual heading for the placement ghost, or null to follow the line. */
  ghostRot: number | null;
  showWelcome: boolean;
  env: Env;
  /** Saved projects (newest activity first) and the one being edited. */
  projects: ProjectMeta[];
  projectId: string;

  setTool: (t: Tool, defId?: string | null) => void;
  setVoltage: (v: VoltageId) => void;
  setEnv: (p: Partial<Env>) => void;
  set: (p: Partial<State>) => void;
  placeStructure: (s: Omit<Structure, 'id' | 'builtAt'>, builtAt?: number) => string;
  connect: (a: string, b: string, builtAt?: number) => string | null;
  removeStructure: (id: string) => void;
  removeSpan: (id: string) => void;
  patchStructure: (id: string, p: Partial<Structure>, reorientNeighbours?: boolean) => void;
  /** Patch several structures at once, then re-orient them and their neighbours. */
  patchStructures: (p: Record<string, Partial<Structure>>) => void;
  /** Positions before the last "Straighten section", for its Undo button. */
  alignUndo: { key: string; prev: Record<string, Partial<Structure>> } | null;
  setElevs: (e: Record<string, number>) => void;
  rotateSelected: (deg: number) => void;
  clearAll: () => void;
  importSave: (json: string) => boolean;
  exportSave: () => string;
  loadDemo: () => LL;
  newProject: (name: string) => void;
  openProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
}

function freeBays(S: Structure, spans: Record<string, Span>): number[] {
  const used = new Set<number>();
  for (const sp of Object.values(spans)) {
    if (sp.a === S.id) sp.slotsA.forEach((i) => used.add(i));
    if (sp.b === S.id) sp.slotsB.forEach((i) => used.add(i));
  }
  return getModel(S.defId, S.voltage).circuits.map((_, i) => i).filter((i) => !used.has(i));
}

/** Nearest free bays on a station to the structure the line comes from. */
function pickBays(S: Structure, towards: LL, n: number, free: number[]): number[] {
  const m = getModel(S.defId, S.voltage);
  const [e, nn] = enuOffset(S, towards);
  const b = S.rotation * D2R;
  const dist = (i: number) => {
    const c = m.circuits[i][1];
    const E = c.x * Math.cos(b) + c.y * Math.sin(b);
    const N = -c.x * Math.sin(b) + c.y * Math.cos(b);
    return Math.hypot(E - e, N - nn);
  };
  return [...free].sort((x, y) => dist(x) - dist(y)).slice(0, n).sort((x, y) => x - y);
}

/** Can a line be strung between A and B? B may be a not-yet-placed ghost. */
export function checkLink(A: Structure, B: Structure, spans: Record<string, Span>, fallbackVoltage: VoltageId): LinkCheck {
  const dA = DEF_BY_ID[A.defId];
  const dB = DEF_BY_ID[B.defId];
  const dist = distanceM(A, B);
  const fail = (reason: string): LinkCheck => ({ ok: false, reason, dist });
  if (A.id === B.id) return fail('Pick a different structure');
  for (const s of Object.values(spans)) {
    if ((s.a === A.id && s.b === B.id) || (s.a === B.id && s.b === A.id)) return fail('Already connected');
  }
  const lineA = dA.voltages !== 'any';
  const lineB = dB.voltages !== 'any';
  if (lineA && lineB && A.voltage !== B.voltage)
    return fail(`Voltage mismatch: ${VOLTAGES[A.voltage].label} ↔ ${VOLTAGES[B.voltage].label}. Use a substation to change voltage`);
  const voltage = lineA ? A.voltage : lineB ? B.voltage : fallbackVoltage;
  const V = VOLTAGES[voltage];
  const mA = getModel(A.defId, A.voltage);
  const mB = getModel(B.defId, B.voltage);
  const max = V.maxSpan * Math.min(dA.spanFactor, dB.spanFactor);
  const min = Math.max(V.minSpan, mA.radius + mB.radius);
  if (dist > max) return fail(`Span too long: ${dist.toFixed(0)} m (max ${max.toFixed(0)} m for ${V.label})`);
  if (dist < min) return fail(`Span too short: ${dist.toFixed(0)} m (min ${min.toFixed(0)} m)`);
  const fa = mA.exclusive ? freeBays(A, spans) : null;
  const fb = mB.exclusive ? freeBays(B, spans) : null;
  const n = Math.min(fa ? fa.length : mA.circuits.length, fb ? fb.length : mB.circuits.length);
  if (n === 0) return fail(`No free line bay at the ${(fa && !fa.length ? dA : dB).short.toLowerCase()}`);
  return {
    ok: true, voltage, dist,
    slotsA: fa ? pickBays(A, B, n, fa) : [],
    slotsB: fb ? pickBays(B, A, n, fb) : [],
  };
}

/** Heading that puts a line structure's crossarms square to the line (bisector at angles). */
export function autoRotation(st: Structure, structures: Record<string, Structure>, spans: Record<string, Span>): number | null {
  if (DEF_BY_ID[st.defId].role !== 'line' || st.manualRot) return null;
  const nb = neighbours(st.id, spans).filter((n) => structures[n.other]);
  if (nb.length === 1) return bearingDeg(st, structures[nb[0].other]);
  if (nb.length === 2) {
    const b1 = bearingDeg(st, structures[nb[0].other]) * D2R;
    const b2 = bearingDeg(st, structures[nb[1].other]) * D2R;
    const e = Math.sin(b2) - Math.sin(b1);
    const n = Math.cos(b2) - Math.cos(b1);
    if (Math.hypot(e, n) < 1e-3) return (b1 / D2R + 90) % 360;
    return ((Math.atan2(e, n) / D2R) + 360) % 360;
  }
  return null;
}

function reoriented(structures: Record<string, Structure>, spans: Record<string, Span>, ids: string[], enabled: boolean) {
  if (!enabled) return structures;
  let out = structures;
  for (const id of ids) {
    const st = out[id];
    if (!st) continue;
    const r = autoRotation(st, out, spans);
    if (r != null && Math.abs(r - st.rotation) > 0.01) {
      if (out === structures) out = { ...structures };
      out[id] = { ...st, rotation: r };
    }
  }
  return out;
}

type NetData = { structures: Record<string, Structure>; spans: Record<string, Span> };

function readJson(key: string): any {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // corrupt save or storage unavailable
  }
}
function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage full or unavailable */
  }
}

function loadProjectData(id: string): NetData {
  const d = readJson(projectKey(id));
  return d && d.structures && d.spans ? sanitize(d) : { structures: {}, spans: {} };
}

/** Project list + the current project's network; migrates the old single save into "My network". */
function loadProjects(): { projects: ProjectMeta[]; projectId: string; data: NetData } {
  const idx = readJson(PROJECTS_KEY);
  if (idx && Array.isArray(idx.list) && idx.list.length) {
    const projects: ProjectMeta[] = idx.list;
    const projectId = projects.some((p) => p.id === idx.current) ? idx.current : projects[0].id;
    return { projects, projectId, data: loadProjectData(projectId) };
  }
  const now = Date.now();
  const first: ProjectMeta = { id: newId('p'), name: 'My network', created: now, updated: now };
  const old = readJson(SAVE_KEY);
  const data = old && old.structures && old.spans ? sanitize(old) : { structures: {}, spans: {} };
  writeJson(projectKey(first.id), { version: 1, ...data });
  writeJson(PROJECTS_KEY, { current: first.id, list: [first] });
  return { projects: [first], projectId: first.id, data };
}

function sanitize(d: any): NetData {
  const structures: Record<string, Structure> = {};
  const spans: Record<string, Span> = {};
  for (const s of Object.values<any>(d.structures)) {
    if (s && DEF_BY_ID[s.defId] && VOLTAGES[s.voltage as VoltageId] && isFinite(s.lng) && isFinite(s.lat))
      structures[s.id] = { ...s, elev: s.elev ?? 0, builtAt: 0, insLen: typeof s.insLen === 'number' && s.insLen > 0 ? s.insLen : undefined };
  }
  // number any structures saved before numbering existed, in their saved order
  let next = nextNo(structures);
  for (const st of Object.values(structures)) if (!(st.no! > 0)) st.no = next++;
  for (const s of Object.values<any>(d.spans)) {
    if (s && structures[s.a] && structures[s.b] && VOLTAGES[s.voltage as VoltageId])
      spans[s.id] = { ...s, slotsA: s.slotsA ?? [], slotsB: s.slotsB ?? [], builtAt: 0 };
  }
  return { structures, spans };
}

function nextNo(structures: Record<string, Structure>): number {
  let max = 0;
  for (const s of Object.values(structures)) if (s.no! > max) max = s.no!;
  return max + 1;
}

/** "T-007" for line structures, "SS-002" for stations etc. Numbering is shared across the project. */
export function structureTag(st: Structure): string {
  const role = DEF_BY_ID[st.defId]?.role;
  const p = role === 'substation' ? 'SS' : role === 'source' ? 'PP' : 'T';
  return `${p}-${String(st.no ?? 0).padStart(3, '0')}`;
}

const boot = loadProjects();
const initial = boot.data;

export const useStore = create<State>()((set, get) => ({
  structures: initial.structures,
  spans: initial.spans,
  network: computeNetwork(initial.structures, initial.spans),

  tool: 'select',
  buildDefId: null,
  voltage: 'v230',
  chainFrom: null,
  selected: null,
  movingId: null,
  moveOrigin: null,
  autoConnect: true,
  autoOrient: true,
  ghostRot: null,
  showWelcome: true,
  env: {
    wind: 0.35, rain: false, clouds: true, shadows: true,
    glow: true, flow: true, orbit: true, basemap: 'satellite', labels: true, exaggeration: 1,
  },
  projects: boot.projects,
  projectId: boot.projectId,

  set: (p) => set(p),

  newProject: (name) => {
    flushSave();
    const now = Date.now();
    const p: ProjectMeta = { id: newId('p'), name: name.trim() || 'Untitled project', created: now, updated: now };
    writeJson(projectKey(p.id), { version: 1, structures: {}, spans: {} });
    switchTo(p.id, [p, ...get().projects], { structures: {}, spans: {} });
  },

  openProject: (id) => {
    if (id === get().projectId || !get().projects.some((p) => p.id === id)) return;
    flushSave();
    switchTo(id, get().projects, loadProjectData(id));
  },

  renameProject: (id, name) => {
    const projects = get().projects.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p));
    set({ projects });
    writeJson(PROJECTS_KEY, { current: get().projectId, list: projects });
  },

  deleteProject: (id) => {
    const rest = get().projects.filter((p) => p.id !== id);
    try {
      localStorage.removeItem(projectKey(id));
    } catch {
      /* storage unavailable */
    }
    if (id !== get().projectId) {
      set({ projects: rest });
      writeJson(PROJECTS_KEY, { current: get().projectId, list: rest });
      return;
    }
    window.clearTimeout(saveTimer); // don't write the deleted project back
    if (rest.length) switchTo(rest[0].id, rest, loadProjectData(rest[0].id));
    else {
      const now = Date.now();
      const p: ProjectMeta = { id: newId('p'), name: 'Untitled project', created: now, updated: now };
      writeJson(projectKey(p.id), { version: 1, structures: {}, spans: {} });
      switchTo(p.id, [p], { structures: {}, spans: {} });
    }
  },

  setTool: (t, defId = null) => {
    const s = get();
    // leaving a move in progress puts the structure back
    if (s.movingId && s.moveOrigin && t !== 'move') get().patchStructure(s.movingId, s.moveOrigin, true);
    let voltage = s.voltage;
    if ((t === 'build' || t === 'route') && defId) {
      const def = DEF_BY_ID[defId];
      if (def.voltages !== 'any' && !def.voltages.includes(voltage)) voltage = def.voltages[def.voltages.length - 1];
    }
    set({
      tool: t, buildDefId: t === 'build' || t === 'route' ? defId : null, voltage, movingId: null, moveOrigin: null, ghostRot: null,
      chainFrom: t === 'build' || t === 'connect' || t === 'route' ? (t === s.tool ? s.chainFrom : null) : null,
      selected: t === 'select' ? s.selected : null,
    });
  },

  setVoltage: (v) => {
    const s = get();
    const def = s.buildDefId ? DEF_BY_ID[s.buildDefId] : null;
    if (def && def.voltages !== 'any' && !def.voltages.includes(v)) return;
    set({ voltage: v, chainFrom: null });
  },

  setEnv: (p) => set({ env: { ...get().env, ...p } }),

  placeStructure: (s, builtAt = performance.now()) => {
    const id = newId('s');
    const structures = { ...get().structures, [id]: { ...s, id, builtAt, no: nextNo(get().structures) } };
    set({ structures, network: computeNetwork(structures, get().spans) });
    return id;
  },

  connect: (a, b, builtAt = performance.now()) => {
    const s = get();
    const A = s.structures[a];
    const B = s.structures[b];
    if (!A || !B) return 'Missing structure';
    const chk = checkLink(A, B, s.spans, s.voltage);
    if (!chk.ok) return chk.reason;
    const id = newId('c');
    const spans = { ...s.spans, [id]: { id, a, b, voltage: chk.voltage, slotsA: chk.slotsA, slotsB: chk.slotsB, builtAt } };
    const structures = reoriented(s.structures, spans, [a, b], s.autoOrient);
    set({ spans, structures, network: computeNetwork(structures, spans) });
    return null;
  },

  removeStructure: (id) => {
    const s = get();
    if (!s.structures[id]) return;
    const structures = { ...s.structures };
    delete structures[id];
    const spans: Record<string, Span> = {};
    const touched: string[] = [];
    for (const sp of Object.values(s.spans)) {
      if (sp.a === id || sp.b === id) touched.push(sp.a === id ? sp.b : sp.a);
      else spans[sp.id] = sp;
    }
    const st2 = reoriented(structures, spans, touched, s.autoOrient);
    set({
      structures: st2, spans, network: computeNetwork(st2, spans),
      selected: null, chainFrom: s.chainFrom === id ? null : s.chainFrom,
      movingId: s.movingId === id ? null : s.movingId,
    });
  },

  removeSpan: (id) => {
    const s = get();
    const sp = s.spans[id];
    if (!sp) return;
    const spans = { ...s.spans };
    delete spans[id];
    const structures = reoriented(s.structures, spans, [sp.a, sp.b], s.autoOrient);
    set({ spans, structures, network: computeNetwork(structures, spans), selected: null });
  },

  patchStructure: (id, p, reorientNeighbours = false) => {
    const s = get();
    const st = s.structures[id];
    if (!st) return;
    let structures = { ...s.structures, [id]: { ...st, ...p } };
    if (reorientNeighbours) {
      const ids = [id, ...neighbours(id, s.spans).map((n) => n.other)];
      structures = reoriented(structures, s.spans, ids, s.autoOrient);
    }
    set({ structures, network: computeNetwork(structures, s.spans) });
  },

  patchStructures: (p) => {
    const s = get();
    let structures = { ...s.structures };
    const ids = new Set<string>();
    for (const [id, patch] of Object.entries(p)) {
      if (!structures[id]) continue;
      structures[id] = { ...structures[id], ...patch };
      ids.add(id);
      neighbours(id, s.spans).forEach((n) => ids.add(n.other));
    }
    structures = reoriented(structures, s.spans, [...ids], s.autoOrient);
    set({ structures, network: computeNetwork(structures, s.spans) });
  },
  alignUndo: null,

  setElevs: (e) => {
    const s = get();
    let structures = s.structures;
    for (const [id, elev] of Object.entries(e)) {
      const st = structures[id];
      if (st && Math.abs(st.elev - elev) > 0.15) {
        if (structures === s.structures) structures = { ...structures };
        structures[id] = { ...st, elev };
      }
    }
    if (structures !== s.structures) set({ structures });
  },

  rotateSelected: (deg) => {
    const s = get();
    const id = s.movingId ?? (s.selected?.kind === 'structure' ? s.selected.id : null);
    if (id && s.structures[id]) {
      get().patchStructure(id, { rotation: (s.structures[id].rotation + deg + 360) % 360, manualRot: true });
    } else if (s.tool === 'build') {
      set({ ghostRot: (((s.ghostRot ?? 0) + deg) % 360 + 360) % 360 });
    }
  },

  clearAll: () => set({ structures: {}, spans: {}, network: computeNetwork({}, {}), selected: null, chainFrom: null, movingId: null }),

  exportSave: () => JSON.stringify({ version: 1, structures: get().structures, spans: get().spans }, null, 1),

  importSave: (json) => {
    try {
      const d = sanitize(JSON.parse(json));
      set({ ...d, network: computeNetwork(d.structures, d.spans), selected: null, chainFrom: null });
      return true;
    } catch {
      return false;
    }
  },

  /** A 230 kV double-circuit line across the Makiling foothills plus a 69 kV feeder. */
  loadDemo: () => {
    get().clearAll();
    const { placeStructure, connect } = get();
    const t0 = performance.now();
    let step = 0;
    const stamp = () => t0 + step++ * 140;
    const mk = (defId: string, voltage: VoltageId, p: LL, rotation: number, manualRot = false) =>
      placeStructure({ defId, voltage, lng: p.lng, lat: p.lat, rotation, manualRot, elev: 0 }, stamp());

    const way: LL[] = [
      { lng: 121.1685, lat: 14.0775 },
      { lng: 121.1535, lat: 14.1035 },
      { lng: 121.1345, lat: 14.1385 },
      { lng: 121.1285, lat: 14.1745 },
      { lng: 121.1255, lat: 14.2005 },
    ];
    const plant = mk('power-plant', 'v230', way[0], bearingDeg(way[0], way[1]) - 43, true);
    let prev = plant;
    for (let i = 0; i < way.length - 1; i++) {
      const a = way[i];
      const b = way[i + 1];
      const [e, n] = enuOffset(a, b);
      const len = Math.hypot(e, n);
      const first = i === 0 ? 190 : 0;
      const last = i === way.length - 2 ? len - 150 : len;
      const count = Math.max(1, Math.round((last - first) / 400));
      for (let k = i === 0 ? 0 : 1; k <= count; k++) {
        const d = first + ((last - first) * k) / count;
        const p = offsetLL(a, (e * d) / len, (n * d) / len);
        const ends = (i === 0 && k === 0) || (i === way.length - 2 && k === count);
        const defId = ends ? 'dc-deadend' : k === count ? 'dc-angle' : 'dc-suspension';
        const id = mk(defId, 'v230', p, 0);
        connect(prev, id, stamp());
        prev = id;
      }
    }
    const subPos = way[way.length - 1];
    const sub = mk('substation', 'v230', subPos, bearingDeg(subPos, way[way.length - 2]), true);
    connect(prev, sub, stamp());

    // 69 kV steel-pole feeder to a second substation
    const sub2Pos = offsetLL(subPos, 900, 2300);
    const [e2, n2] = enuOffset(subPos, sub2Pos);
    const len2 = Math.hypot(e2, n2);
    const sub2 = mk('substation', 'v69', sub2Pos, bearingDeg(sub2Pos, subPos), true);
    prev = sub;
    const poles = Math.round((len2 - 200) / 170);
    for (let k = 0; k <= poles; k++) {
      const d = 100 + ((len2 - 200) * k) / poles;
      const id = mk('pole-dc', 'v69', offsetLL(subPos, (e2 * d) / len2, (n2 * d) / len2), 0);
      connect(prev, id, stamp());
      prev = id;
    }
    connect(prev, sub2, stamp());
    set({ selected: null, chainFrom: null, tool: 'select', buildDefId: null });
    return way[2];
  },
}));

if (import.meta.env.DEV) (window as unknown as { __store: typeof useStore }).__store = useStore;

// autosave into the current project (debounced)
let saveTimer: number | undefined;

function saveNow() {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  const s = useStore.getState();
  writeJson(projectKey(s.projectId), { version: 1, structures: s.structures, spans: s.spans });
  const projects = s.projects.map((p) => (p.id === s.projectId ? { ...p, updated: Date.now() } : p));
  useStore.setState({ projects });
  writeJson(PROJECTS_KEY, { current: s.projectId, list: projects });
}

/** Write any pending autosave right away (before switching projects). */
function flushSave() {
  if (saveTimer !== undefined) saveNow();
}

function switchTo(id: string, projects: ProjectMeta[], data: NetData) {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  switching = true;
  useStore.setState({
    projects, projectId: id, ...data, network: computeNetwork(data.structures, data.spans),
    selected: null, chainFrom: null, movingId: null, moveOrigin: null, tool: 'select', buildDefId: null, ghostRot: null, alignUndo: null,
  });
  switching = false;
  writeJson(PROJECTS_KEY, { current: id, list: projects });
}
let switching = false;

useStore.subscribe((s, p) => {
  if (switching || (s.structures === p.structures && s.spans === p.spans)) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 600);
});
window.addEventListener('beforeunload', flushSave);

/** Cursor read-out; kept in its own store so mouse movement does not re-render the whole UI. */
export interface Hud {
  lng: number;
  lat: number;
  elev: number;
  zoom: number;
  bearing: number;
  pitch: number;
  /** Camera eye altitude above sea level (m). */
  alt: number;
  msg: string;
  ok: boolean;
  fps: number;
  /** True while the camera slowly orbits a double-clicked structure or span. */
  orbiting: boolean;
}
export const useHud = create<Hud>()(() => ({ lng: 0, lat: 0, elev: 0, zoom: 5, bearing: 0, pitch: 0, alt: 0, msg: '', ok: true, fps: 0, orbiting: false }));
