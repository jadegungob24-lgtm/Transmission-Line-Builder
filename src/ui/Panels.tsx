import { useEffect, useMemo, useRef, useState } from 'react';
import { DEF_BY_ID, getModel } from '../catalog/structures';
import { VOLTAGES, VoltageId } from '../catalog/voltages';
import { layoutSpan, wireHeightAt } from '../conductors/spanWires';
import { makeCatenary, wireLength } from '../conductors/catenary';
import { bearingDeg } from '../core/geo';
import { formatPrs92, fromPrs92, PTM_ZONES, toPrs92 } from '../core/prs92';
import { useHud, useStore } from '../core/store';
import { lineAngle, neighbours } from '../network/connectivity';
import { SUN } from '../map/environment';
import { flyTo, runtime, setView } from '../map/runtime';
import { ToolIcon } from './Icons';
import { Search } from './Search';

// ------------------------------------------------------------------ top bar

export function TopBar({ onSettings, onHelp }: { onSettings: () => void; onHelp: () => void }) {
  const net = useStore((s) => s.network);
  const env = useStore((s) => s.env);
  const setEnv = useStore((s) => s.setEnv);
  const nStruct = useStore((s) => Object.keys(s.structures).length);
  // Solar output under the fixed daytime sun (less under rain clouds)
  const solarNow = net.solarMW * Math.sin((SUN.elevation * Math.PI) / 180) * (env.rain ? 0.35 : 1);
  const gen = net.capacityMW - net.solarMW + solarNow;
  const ckm = Object.values(net.circuitKm).reduce((a, b) => a + b, 0);
  const served = net.loadMW > 0 ? Math.min(1, Math.min(gen, net.servedMW) / net.loadMW) : 0;

  return (
    <div className="topbar panel">
      <div className="brand">
        <span className="bolt">⚡</span>
        <div>
          <b>PH Grid Builder</b>
          <span className="muted">Philippine transmission sandbox</span>
        </div>
      </div>
      <div className="stats">
        <Stat label="Generation" value={`${gen.toFixed(0)} MW`} color="#ffd23d" />
        <Stat label="Load served" value={net.loadMW ? `${(served * 100).toFixed(0)}%` : '—'} color={served >= 0.999 ? '#39c98a' : served > 0 ? '#ffa63d' : '#9aa7b4'} />
        <Stat label="Circuit-km" value={ckm.toFixed(1)} />
        <Stat label="Structures" value={String(nStruct)} />
        <Stat label="Energised grids" value={`${net.energizedIslands}/${net.islands}`} />
      </div>
      <Search />
      <div className="weather">
        <button className={`chip ${env.rain ? 'on' : ''}`} onClick={() => setEnv({ rain: !env.rain })} title="Rain and storm wind">🌧</button>
        <button className={`chip ${env.clouds ? 'on' : ''}`} onClick={() => setEnv({ clouds: !env.clouds })} title="Clouds">☁</button>
      </div>
      <div className="top-actions">
        <button className="icon-btn" onClick={onHelp} title="Help"><ToolIcon name="help" /></button>
        <button className="icon-btn" onClick={onSettings} title="Settings"><ToolIcon name="settings" /></button>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="stat">
      <span className="muted">{label}</span>
      <b style={{ color }}>{value}</b>
    </div>
  );
}

// ------------------------------------------------------------------ left tool column

export function SideTools() {
  const tool = useStore((s) => s.tool);
  const setTool = useStore((s) => s.setTool);
  const tools: { id: 'select' | 'move' | 'bulldoze'; label: string; key: string }[] = [
    { id: 'select', label: 'Select / inspect', key: 'V' },
    { id: 'move', label: 'Move structure', key: 'M' },
    { id: 'bulldoze', label: 'Bulldozer', key: 'X' },
  ];
  return (
    <div className="side">
      <div className="panel col">
        {tools.map((t) => (
          <button key={t.id} className={`icon-btn ${tool === t.id ? 'on' : ''} ${t.id === 'bulldoze' ? 'danger' : ''}`} onClick={() => setTool(t.id)} title={`${t.label} (${t.key})`}>
            <ToolIcon name={t.id} />
          </button>
        ))}
      </div>
      <div className="panel col">
        <button className="icon-btn" onClick={() => setView('top')} title="Top-down view (1)"><ToolIcon name="top" /></button>
        <button className="icon-btn" onClick={() => setView('iso')} title="Isometric view (2)"><ToolIcon name="iso" /></button>
        <button className="icon-btn" onClick={() => setView('ground')} title="Ground-level view (3)"><ToolIcon name="ground" /></button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ info panel

export function InfoPanel() {
  const selected = useStore((s) => s.selected);
  const structures = useStore((s) => s.structures);
  const spans = useStore((s) => s.spans);
  const net = useStore((s) => s.network);
  const movingId = useStore((s) => s.movingId);
  const set = useStore((s) => s.set);
  // While a structure is being moved its panel stays open, so the coordinates update live.
  const structId = movingId ?? (selected?.kind === 'structure' ? selected.id : null);
  if (!structId && !selected) return <NetworkPanel />;

  if (structId) {
    const st = structures[structId];
    if (!st) return null;
    const moving = movingId === st.id;
    const def = DEF_BY_ID[st.defId];
    const m = getModel(st.defId, st.voltage);
    const nb = neighbours(st.id, spans);
    const ang = lineAngle(st, structures, spans);
    const ex = useStore.getState().env.exaggeration || 1;
    const warn = net.angleWarnings[st.id];
    return (
      <div className="info panel">
        <div className="info-head">
          <b>{def.name}</b>
          <button className="x" onClick={() => (moving ? runtime.ctrl?.cancel() : set({ selected: null }))} title={moving ? 'Cancel move' : 'Close'}>×</button>
        </div>
        {moving && <p className="moving-note small">Moving · click the map to drop · right-click to cancel</p>}
        <Row k="Status" v={net.energizedStructures.has(st.id) ? <span className="ok">● Energised</span> : <span className="muted">○ De-energised</span>} />
        {def.voltages !== 'any' && <Row k="Voltage class" v={<span style={{ color: VOLTAGES[st.voltage].color }}>{VOLTAGES[st.voltage].label}</span>} />}
        <Row k="Circuits" v={def.role === 'line' ? `${def.circuits}` : `${m.circuits.length} line bays`} />
        <Row k="Height" v={`${m.height.toFixed(1)} m`} />
        <Row k="Ground elevation" v={`${(st.elev / ex).toFixed(0)} m`} />
        <Row k="Heading" v={`${st.rotation.toFixed(0)}°${st.manualRot ? ' (manual)' : ''}`} />
        <Row k="Connections" v={`${nb.length}`} />
        {ang != null && <Row k="Line angle" v={<span className={warn ? 'bad' : ''}>{ang.toFixed(1)}°</span>} />}
        {warn != null && <p className="bad small">Deflection exceeds the {def.maxAngle}° limit for this structure. Use an angle or dead-end tower here.</p>}
        {def.capacityMW && <Row k="Capacity" v={`${def.capacityMW} MW`} />}
        {def.loadMW && <Row k="Load" v={`${def.loadMW} MW`} />}
        <Coordinates key={st.id} id={st.id} lng={st.lng} lat={st.lat} editable={!moving} />
        <div className="info-actions">
          <button onClick={() => runtime.ctrl?.rotate(-15)}>⟲ 15°</button>
          <button onClick={() => runtime.ctrl?.rotate(15)}>⟳ 15°</button>
          {moving ? (
            <button onClick={() => runtime.ctrl?.cancel()}>Cancel move</button>
          ) : (
            <>
              {st.manualRot && <button onClick={() => useStore.getState().patchStructure(st.id, { manualRot: false }, true)}>Auto-orient</button>}
              <button onClick={() => { const s = useStore.getState(); s.setTool('move'); s.set({ movingId: st.id, moveOrigin: { lng: st.lng, lat: st.lat, rotation: st.rotation } }); }}>Move</button>
              <button onClick={() => { const s = useStore.getState(); s.setTool(def.role === 'line' ? 'build' : 'connect', def.role === 'line' ? def.id : null); s.set({ chainFrom: st.id }); }}>Extend</button>
              <button className="danger" onClick={() => useStore.getState().removeStructure(st.id)}>Demolish</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const sp = selected ? spans[selected.id] : null;
  if (!sp) return null;
  return <SpanInfo id={sp.id} />;
}

function SpanInfo({ id }: { id: string }) {
  const sp = useStore((s) => s.spans[id]);
  const A = useStore((s) => s.structures[sp?.a]);
  const B = useStore((s) => s.structures[sp?.b]);
  const net = useStore((s) => s.network);
  const set = useStore((s) => s.set);
  const data = useMemo(() => {
    if (!sp || !A || !B) return null;
    const lay = layoutSpan(sp, A, B);
    const w = lay.lowest;
    let clearance = Infinity;
    if (w && runtime.map) {
      for (let i = 1; i < 20; i++) {
        const t = i / 20;
        const p = { lng: A.lng + (B.lng - A.lng) * t, lat: A.lat + (B.lat - A.lat) * t };
        const g = runtime.map.queryTerrainElevation(p);
        if (g == null) continue;
        clearance = Math.min(clearance, A.elev + wireHeightAt(w, t) - g);
      }
    }
    const L = w ? Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) : lay.length;
    const wl = w ? wireLength(makeCatenary(L, w.a.z, w.b.z, w.C)) : lay.length;
    return { lay, clearance, wl };
  }, [sp, A, B]);
  if (!sp || !A || !B || !data) return null;
  const V = VOLTAGES[sp.voltage];
  const nPhase = data.lay.wires.filter((w) => w.kind === 0).length;
  const nGW = data.lay.wires.length - nPhase;
  const minClear = V.kv >= 500 ? 12 : V.kv >= 230 ? 9 : V.kv >= 69 ? 7 : 6;
  return (
    <div className="info panel">
      <div className="info-head">
        <b>{V.label} Span</b>
        <button className="x" onClick={() => set({ selected: null })}>×</button>
      </div>
      <Row k="Status" v={net.energizedSpans.has(sp.id) ? <span className="ok">● Energised</span> : <span className="muted">○ De-energised</span>} />
      <Row k="From → to" v={`${DEF_BY_ID[A.defId].short} → ${DEF_BY_ID[B.defId].short}`} />
      <Row k="Span length" v={`${data.lay.length.toFixed(0)} m`} />
      <Row k="Bearing" v={`${bearingDeg(A, B).toFixed(0)}°`} />
      <Row k="Elevation difference" v={`${(B.elev - A.elev).toFixed(1)} m`} />
      <Row k="Mid-span sag" v={`${data.lay.sag.toFixed(1)} m`} />
      <Row k="Conductor length" v={`${data.wl.toFixed(1)} m`} />
      <Row k="Circuits" v={`${data.lay.circuits} × 3-phase`} />
      <Row k="Conductor" v={V.conductor} />
      <Row k="Wires in span" v={`${nPhase} phase + ${nGW} OPGW/GW`} />
      {isFinite(data.clearance) && (
        <Row k="Min. ground clearance" v={<span className={data.clearance < minClear ? 'bad' : 'ok'}>{data.clearance.toFixed(1)} m</span>} />
      )}
      {isFinite(data.clearance) && data.clearance < minClear && <p className="bad small">Below the {minClear} m clearance target. Use taller structures or shorten the span.</p>}
      <div className="info-actions">
        <button className="danger" onClick={() => useStore.getState().removeSpan(sp.id)}>Remove conductors</button>
      </div>
    </div>
  );
}

function NetworkPanel() {
  const net = useStore((s) => s.network);
  const [open, setOpen] = useState(true);
  const rows = (Object.keys(VOLTAGES) as VoltageId[]).filter((v) => net.circuitKm[v]);
  const warnings = Object.keys(net.angleWarnings).length;
  return (
    <div className="info panel">
      <div className="info-head">
        <b>Network</b>
        <button className="x" onClick={() => setOpen(!open)}>{open ? '–' : '+'}</button>
      </div>
      {open && (
        <>
          <Row k="Route length" v={`${net.routeKm.toFixed(2)} km`} />
          {rows.length === 0 && <p className="muted small">No lines yet. Open Transmission Towers below, pick a tower and click on land to start a line.</p>}
          {rows.map((v) => (
            <Row key={v} k={<span style={{ color: VOLTAGES[v].color }}>■ {VOLTAGES[v].label}</span>} v={`${net.circuitKm[v].toFixed(2)} ckm`} />
          ))}
          <Row k="Installed capacity" v={`${net.capacityMW} MW`} />
          <Row k="Connected load" v={`${net.loadMW} MW`} />
          {warnings > 0 && (
            <p className="bad small">
              {warnings === 1 ? '1 structure exceeds its' : `${warnings} structures exceed their`} design line angle. Select it to see where.
            </p>
          )}
          <div className="legend">
            <span><i className="lg on" /> Energised</span>
            <span><i className="lg off" /> Not connected to a source</span>
            <span><i className="lg build" /> Stringing</span>
          </div>
        </>
      )}
    </div>
  );
}

/** PRS92 coordinates of a structure. Click to type new ones and move the structure there. */
function Coordinates({ id, lng, lat, editable }: { id: string; lng: number; lat: number; editable: boolean }) {
  const [copied, setCopied] = useState(false);
  const [edit, setEdit] = useState<{ zone: number; n: string; e: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const raw = toPrs92(lng, lat);
  const c = formatPrs92(raw);

  const copy = () => {
    navigator.clipboard?.writeText(`${c.zone}\n${c.northing}\n${c.easting}`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }, () => {});
  };
  const open = () => {
    if (!editable) return;
    setErr(null);
    setEdit({ zone: raw.zone.zone, n: raw.northing.toFixed(3), e: raw.easting.toFixed(3) });
  };
  const apply = async () => {
    if (!edit || busy) return;
    const n = parseFloat(edit.n.replace(/[,\s]/g, ''));
    const e = parseFloat(edit.e.replace(/[,\s]/g, ''));
    if (!isFinite(n) || !isFinite(e)) return setErr('Enter numbers for northing and easting');
    if (e < 100000 || e > 900000 || n < 400000 || n > 2400000) return setErr('Those values are outside the PTM zone range');
    const p = fromPrs92(edit.zone, n, e);
    setBusy(true);
    setErr(null);
    const problem = runtime.ctrl ? await runtime.ctrl.relocate(id, p) : 'Map not ready';
    setBusy(false);
    if (problem) setErr(problem);
    else setEdit(null);
  };

  if (edit) {
    const onKey = (ev: React.KeyboardEvent) => {
      if (ev.key === 'Enter') apply();
      if (ev.key === 'Escape') setEdit(null);
    };
    return (
      <div className="coord-edit">
        <div className="row">
          <span className="muted">Coordinates</span>
          <select value={edit.zone} onChange={(ev) => setEdit({ ...edit, zone: +ev.target.value })} onKeyDown={onKey}>
            {PTM_ZONES.map((z) => <option key={z.zone} value={z.zone}>PRS92 · PTM Zone {z.roman}</option>)}
          </select>
        </div>
        <label>N <input autoFocus inputMode="decimal" value={edit.n} onChange={(ev) => setEdit({ ...edit, n: ev.target.value })} onKeyDown={onKey} /> m</label>
        <label>E <input inputMode="decimal" value={edit.e} onChange={(ev) => setEdit({ ...edit, e: ev.target.value })} onKeyDown={onKey} /> m</label>
        {err && <p className="bad small">{err}</p>}
        <div className="info-actions">
          <button className="primary" onClick={apply} disabled={busy}>{busy ? 'Moving…' : 'Move here'}</button>
          <button onClick={() => setEdit(null)} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="row coords-row">
      <span className="muted">
        Coordinates
        <button className="coord-copy" onClick={copy} title="Copy coordinates">{copied ? '✓' : '⧉'}</button>
      </span>
      <button className={`coord${editable ? ' editable' : ''}`} onClick={open} title={editable ? 'Click to type new coordinates' : 'Updating live while moving'}>
        <span className="coord-zone">{c.zone}</span>
        <span>{c.northing}</span>
        <span>{c.easting}</span>
      </button>
    </div>
  );
}

function Row({ k, v }: { k: React.ReactNode; v: React.ReactNode }) {
  return (
    <div className="row">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

// ------------------------------------------------------------------ hud

export function Hud() {
  const h = useHud();
  const tool = useStore((s) => s.tool);
  const ex = useStore((s) => s.env.exaggeration);
  return (
    <>
      {h.msg && <div className={`hint ${h.ok ? '' : 'bad'}`}>{h.msg}</div>}
      <div className="coords">
        {h.lat.toFixed(4)}°N {h.lng.toFixed(4)}°E · elev {h.elev.toFixed(0)} m{ex !== 1 ? ` (×${ex} relief)` : ''} · eye alt {formatAlt(h.alt)} · heading {Math.round(((h.bearing % 360) + 360) % 360)}° · tilt {Math.round(h.pitch)}°
        {tool !== 'select' && <span className="muted"> · right-click to cancel</span>}
      </div>
    </>
  );
}

function formatAlt(m: number) {
  return m >= 10000 ? `${(m / 1000).toFixed(0)} km` : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

// ------------------------------------------------------------------ settings

export function Settings({ onClose }: { onClose: () => void }) {
  const env = useStore((s) => s.env);
  const setEnv = useStore((s) => s.setEnv);
  const autoConnect = useStore((s) => s.autoConnect);
  const autoOrient = useStore((s) => s.autoOrient);
  const set = useStore((s) => s.set);
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');

  const exportSave = () => {
    const blob = new Blob([useStore.getState().exportSave()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ph-grid-network.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()}>
        <div className="info-head"><b>Settings</b><button className="x" onClick={onClose}>×</button></div>
        <h4>Map</h4>
        <div className="seg">
          {(['satellite', 'streets', 'topo'] as const).map((b) => (
            <button key={b} className={env.basemap === b ? 'on' : ''} onClick={() => setEnv({ basemap: b })}>{b === 'satellite' ? 'Satellite' : b === 'streets' ? 'Streets' : 'Topographic'}</button>
          ))}
        </div>
        <Toggle label="Place labels" v={env.labels} on={(v) => setEnv({ labels: v })} />
        <label className="slider">Terrain exaggeration <b>×{env.exaggeration.toFixed(1)}</b>
          <input type="range" min={1} max={3} step={0.5} value={env.exaggeration} onChange={(e) => setEnv({ exaggeration: parseFloat(e.target.value) })} />
        </label>
        <h4>Visual effects</h4>
        <Toggle label="Dynamic shadows" v={env.shadows} on={(v) => setEnv({ shadows: v })} />
        <Toggle label="Energised conductor glow" v={env.glow} on={(v) => setEnv({ glow: v })} />
        <Toggle label="Animated power flow" v={env.flow} on={(v) => setEnv({ flow: v })} />
        <Toggle label="Orbit around a structure after double-clicking it" v={env.orbit} on={(v) => setEnv({ orbit: v })} />
        <Toggle label="Clouds" v={env.clouds} on={(v) => setEnv({ clouds: v })} />
        <Toggle label="Rain" v={env.rain} on={(v) => setEnv({ rain: v })} />
        <label className="slider">Wind <b>{Math.round(env.wind * 100)}%</b>
          <input type="range" min={0} max={1} step={0.05} value={env.wind} onChange={(e) => setEnv({ wind: parseFloat(e.target.value) })} />
        </label>
        <h4>Construction</h4>
        <Toggle label="Auto-connect conductors while placing" v={autoConnect} on={(v) => set({ autoConnect: v })} />
        <Toggle label="Auto-orient crossarms to the line" v={autoOrient} on={(v) => set({ autoOrient: v })} />
        <h4>Network file</h4>
        <div className="info-actions">
          <button onClick={exportSave}>Export JSON</button>
          <button onClick={() => file.current?.click()}>Import JSON</button>
          <button onClick={() => { const c = useStore.getState().loadDemo(); flyTo(c.lng, c.lat, 13.2); onClose(); }}>Load demo network</button>
          <button className="danger" onClick={() => { if (confirm('Remove every structure and line?')) useStore.getState().clearAll(); }}>Clear map</button>
        </div>
        <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setNote(useStore.getState().importSave(await f.text()) ? `Loaded ${f.name}` : 'That file is not a valid network');
          e.target.value = '';
        }} />
        {note && <p className="small muted">{note}</p>}
        <p className="small muted">Your network autosaves in this browser.</p>
      </div>
    </div>
  );
}

function Toggle({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
      <i />
    </label>
  );
}

// ------------------------------------------------------------------ welcome / help

export function Welcome({ onClose }: { onClose: () => void }) {
  const hasNetwork = useStore((s) => Object.keys(s.structures).length > 0);
  return (
    <div className="modal-bg">
      <div className="modal panel welcome">
        <h2>⚡ PH Grid Builder</h2>
        <p>Build electrical transmission lines across a 3D Philippines. Place towers on real terrain, string sagging three-phase conductors between them, and connect power plants to substations to energise the grid.</p>
        <div className="keys">
          <div className="keys-head">Camera</div>
          <div className="keys-head">Building</div>
          <div><kbd>Left-drag</kbd> pan · <kbd>Right-drag</kbd> zoom</div>
          <div><kbd>Left-click</kbd> place / select</div>
          <div><kbd>Middle-drag</kbd> / <kbd>Ctrl</kbd>/<kbd>Shift</kbd>+drag rotate &amp; tilt</div>
          <div><kbd>Right-click</kbd> / <kbd>Esc</kbd> cancel / end line</div>
          <div><kbd>Wheel</kbd> zoom to cursor · <kbd>Esc</kbd> leave fly-in view</div>
          <div><kbd>T</kbd> / <kbd>Shift+T</kbd> rotate structure</div>
          <div><kbd>W A S D</kbd> / arrows pan · <kbd>Q E</kbd> orbit</div>
          <div><kbd>V M X</kbd> select · move · bulldoze</div>
          <div><kbd>Shift</kbd>+arrows rotate &amp; tilt · <kbd>+ −</kbd> zoom</div>
          <div><kbd>C</kbd> string conductors · <kbd>[ ]</kbd> voltage</div>
          <div><kbd>R</kbd> reset view · <kbd>N</kbd> north · <kbd>U</kbd> untilt</div>
          <div><kbd>F1–F5</kbd> construction menus</div>
          <div><kbd>1 2 3</kbd> top / isometric / ground view</div>
          <div><kbd>Delete</kbd> demolish selection</div>
          <div><kbd>/</kbd> or <kbd>Ctrl+F</kbd> search places</div>
          <div><kbd>Double-click</kbd> a tower / span: fly in &amp; orbit</div>
        </div>
        <p className="small muted">Tip: start with a Power Plant, then pick a tower and click across the land. Each click adds a tower and strings conductors from the previous one. Finish by clicking a Substation.</p>
        <div className="info-actions">
          <button className="primary" onClick={() => { const c = useStore.getState().loadDemo(); flyTo(c.lng, c.lat, 13.2); onClose(); }}>Load demo line (Batangas–Laguna, 230 kV)</button>
          <button onClick={onClose}>{hasNetwork ? 'Continue my network' : 'Start with an empty map'}</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ rain overlay

export function Rain() {
  const rain = useStore((s) => s.env.rain);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!rain) return;
    const c = ref.current!;
    const ctx = c.getContext('2d')!;
    let raf = 0;
    const drops = Array.from({ length: 420 }, () => ({ x: Math.random(), y: Math.random(), s: 0.6 + Math.random() * 0.8 }));
    let flash = 0;
    const tick = () => {
      c.width = c.clientWidth;
      c.height = c.clientHeight;
      ctx.clearRect(0, 0, c.width, c.height);
      if (Math.random() < 0.002) flash = 1;
      if (flash > 0) {
        ctx.fillStyle = `rgba(220,230,255,${flash * 0.25})`;
        ctx.fillRect(0, 0, c.width, c.height);
        flash -= 0.06;
      }
      ctx.strokeStyle = 'rgba(200,215,235,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const d of drops) {
        d.y += 0.018 * d.s;
        d.x += 0.004 * d.s;
        if (d.y > 1) { d.y -= 1; d.x = Math.random(); }
        if (d.x > 1) d.x -= 1;
        const x = d.x * c.width;
        const y = d.y * c.height;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 4 * d.s, y - 16 * d.s);
      }
      ctx.stroke();
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [rain]);
  if (!rain) return null;
  return <canvas ref={ref} className="rain" />;
}

