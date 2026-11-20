import { useEffect, useMemo, useRef, useState } from 'react';
import { VOLTAGES } from '../catalog/voltages';
import { useStore } from '../core/store';
import { runtime } from '../map/runtime';
import { chainage, computeProfile, lineRoute, Profile, ProfilePoint } from '../network/profile';

// Plan & profile panel: the ground profile along the whole line with every
// structure, the sagging lowest conductor (and earth wire) of each span, the
// clearance target, and below it a straightened plan strip with deflection angles
// and span lengths. Hover for chainage / elevations, click a structure to select it.

const PROFILE_H = 230;
const PLAN_H = 64;
const PAD = { l: 58, r: 18, t: 34, b: 8 };

export function ProfilePanel() {
  const sel = useStore((s) => s.profileOf);
  const structures = useStore((s) => s.structures);
  const spans = useStore((s) => s.spans);
  const ex = useStore((s) => s.env.exaggeration);
  const selected = useStore((s) => s.selected);
  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cache = useRef(new Map<string, (number | null)[]>());
  const [width, setWidth] = useState(900);
  const [terrainTick, setTerrainTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hover, setHover] = useState<{ px: number; pt: ProfilePoint; span: number } | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(400, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const route = useMemo(() => (sel ? lineRoute(sel, structures, spans) : null), [sel, structures, spans]);
  const routeKey = route?.join(',') ?? '';

  // Bring the whole line into view once so its terrain is loaded, then sample it.
  useEffect(() => {
    const map = runtime.map;
    if (!route || !map) return;
    const pts = route.map((id) => structures[id]).filter(Boolean);
    const lngs = pts.map((p) => p.lng);
    const lats = pts.map((p) => p.lat);
    const b = map.getBounds();
    const inView = pts.every((p) => b.contains([p.lng, p.lat])) && map.getZoom() >= 11;
    cache.current.clear();
    if (inView) return setTerrainTick((t) => t + 1);
    setLoading(true);
    runtime.nav?.interrupt();
    map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: { top: 90, bottom: 440, left: 90, right: 330 }, maxZoom: 16, duration: 900 });
    const done = () => { setLoading(false); cache.current.clear(); setTerrainTick((t) => t + 1); };
    map.once('moveend', () => (map.areTilesLoaded() ? done() : map.once('idle', done)));
  }, [routeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const profile: Profile | null = useMemo(() => {
    const map = runtime.map;
    if (!route || !map) return null;
    return computeProfile(route, structures, spans, (lng, lat) => map.queryTerrainElevation({ lng, lat }) ?? null, ex, cache.current);
  }, [route, structures, spans, ex, terrainTick]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!sel) return null;
  const close = () => useStore.getState().set({ profileOf: null });
  const refresh = () => { cache.current.clear(); setTerrainTick((t) => t + 1); };

  if (!route || !profile) {
    return (
      <div className="profile panel" ref={box}>
        <div className="info-head"><b>Plan &amp; profile</b><button className="x" onClick={close}>×</button></div>
        <p className="muted small">Select a tower, pole or span on a line to see its plan and profile.</p>
      </div>
    );
  }

  // ---------------------------------------------------------------- scales
  const W = width;
  const innerW = W - PAD.l - PAD.r;
  const sx = (x: number) => PAD.l + (x / (profile.length || 1)) * innerW;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of profile.stations) { lo = Math.min(lo, s.ground); hi = Math.max(hi, s.top); }
  for (const s of profile.spans) for (const p of s.pts) { lo = Math.min(lo, p.ground); hi = Math.max(hi, p.cond); }
  const span = Math.max(20, hi - lo);
  lo -= span * 0.08;
  hi += span * 0.06;
  const sy = (z: number) => PAD.t + (1 - (z - lo) / (hi - lo)) * (PROFILE_H - PAD.t - PAD.b);
  const planY = PROFILE_H + 26 + PLAN_H / 2;
  const H = PROFILE_H + 26 + PLAN_H + 22;

  const groundPts = profile.spans.flatMap((s) => s.pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.ground).toFixed(1)}`));
  const groundArea = `M${sx(0)},${PROFILE_H - PAD.b} L${groundPts.join(' L')} L${sx(profile.length)},${PROFILE_H - PAD.b} Z`;

  // elevation grid
  const step = niceStep((hi - lo) / 5);
  const ticks: number[] = [];
  for (let z = Math.ceil(lo / step) * step; z <= hi; z += step) ticks.push(z);
  const xStep = niceStep(profile.length / Math.max(2, Math.floor(innerW / 110)));
  const xTicks: number[] = [];
  for (let x = 0; x <= profile.length + 1e-6; x += xStep) xTicks.push(x);

  const crowded = innerW / profile.stations.length < 26;
  const first = profile.stations[0];
  const last = profile.stations[profile.stations.length - 1];
  const volts = [...new Set(profile.spans.map((s) => VOLTAGES[s.voltage].label))].join(' / ');
  const mc = profile.minClear;

  const onMove = (e: React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const x = ((px - PAD.l) / innerW) * profile.length;
    if (x < 0 || x > profile.length) return setHover(null);
    const si = profile.spans.findIndex((s) => x >= s.x0 && x <= s.x0 + s.length);
    const s = profile.spans[Math.max(0, si)];
    const pt = s.pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    setHover({ px: sx(pt.x), pt, span: Math.max(0, si) });
  };
  const pick = (id: string) => {
    const st = useStore.getState().structures[id];
    if (!st) return;
    useStore.getState().set({ selected: { kind: 'structure', id }, multi: [] });
    runtime.nav?.interrupt();
    runtime.map?.easeTo({ center: [st.lng, st.lat], zoom: Math.max(runtime.map.getZoom(), 15.5), duration: 800 });
  };
  const download = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.querySelectorAll('.pp-hover').forEach((n) => n.remove());
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = SVG_STYLE;
    clone.insertBefore(style, clone.firstChild);
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('width', String(W)); bg.setAttribute('height', String(H)); bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, style.nextSibling);
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Plan and profile ${first.tag}-${last.tag}.svg`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <div className="profile panel" ref={box}>
      <div className="info-head">
        <div className="pp-title">
          <b>Plan &amp; profile · {first.tag} → {last.tag}</b>
          <span className="muted">
            {volts} · {(profile.length / 1000).toFixed(2)} km · {profile.stations.length} structures · {profile.spans.length} spans
            {mc && (
              <> · min. clearance <span className={profile.below ? 'bad' : 'ok'}>{mc.pt.clear.toFixed(1)} m</span> at {chainage(mc.pt.x)}</>
            )}
            {profile.below > 0 && <span className="bad"> · {profile.below} span{profile.below > 1 ? 's' : ''} below target</span>}
            {loading && <span> · loading terrain…</span>}
          </span>
        </div>
        <div className="schedule-actions">
          <button onClick={refresh} title="Re-sample the terrain along the line">↻ Terrain</button>
          <button onClick={download} title="Download the drawing as an SVG image">Download SVG</button>
          <button className="x" onClick={close} title="Close">×</button>
        </div>
      </div>
      <svg ref={svgRef} className="pp-svg" viewBox={`0 0 ${W} ${H}`} width={W} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* ---- profile */}
        <text className="pp-label" x={PAD.l} y={14}>PROFILE</text>
        {ticks.map((z) => (
          <g key={z}>
            <line className="pp-grid" x1={PAD.l} x2={W - PAD.r} y1={sy(z)} y2={sy(z)} />
            <text className="pp-axis" x={PAD.l - 6} y={sy(z) + 3} textAnchor="end">{z.toFixed(0)}</text>
          </g>
        ))}
        <text className="pp-axis" x={8} y={PAD.t - 8}>Elev. (m)</text>
        <path className="pp-ground-fill" d={groundArea} />
        <polyline className="pp-ground" points={groundPts.join(' ')} />
        {profile.spans.map((s, i) => (
          <g key={i}>
            <polyline className="pp-target" points={s.pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.ground + s.target).toFixed(1)}`).join(' ')} />
            {s.gw.length > 0 && <polyline className="pp-gw" points={s.gw.map((p) => `${sx(p.x).toFixed(1)},${sy(p.z).toFixed(1)}`).join(' ')} />}
            <polyline
              className="pp-cond" stroke={s.minClear.clear < s.target ? '#ff4d4d' : VOLTAGES[s.voltage].color}
              points={s.pts.map((p) => `${sx(p.x).toFixed(1)},${sy(p.cond).toFixed(1)}`).join(' ')}
            />
            {s.minClear.clear < s.target && <circle className="pp-bad" cx={sx(s.minClear.x)} cy={sy(s.minClear.cond)} r={3.5} />}
          </g>
        ))}
        {profile.stations.map((st, i) => {
          const on = selected?.kind === 'structure' && selected.id === st.id;
          return (
            <g key={st.id} className={`pp-st ${on ? 'on' : ''}`} onClick={() => pick(st.id)}>
              <line className={st.strain ? 'pp-tower strain' : 'pp-tower'} x1={sx(st.x)} x2={sx(st.x)} y1={sy(st.ground)} y2={sy(st.top)} />
              <rect className="pp-hit" x={sx(st.x) - 6} y={sy(st.top) - 4} width={12} height={sy(st.ground) - sy(st.top) + 8} />
              {(!crowded || i % 2 === 0 || on || i === profile.stations.length - 1) && (
                <text className="pp-tag" x={sx(st.x)} y={sy(st.top) - 5} transform={crowded ? `rotate(-60 ${sx(st.x)} ${sy(st.top) - 5})` : undefined} textAnchor={crowded ? 'start' : 'middle'}>
                  {st.tag}
                </text>
              )}
            </g>
          );
        })}
        <line className="pp-axisline" x1={PAD.l} x2={W - PAD.r} y1={PROFILE_H - PAD.b} y2={PROFILE_H - PAD.b} />
        {xTicks.map((x) => (
          <text key={x} className="pp-axis" x={sx(x)} y={PROFILE_H + 8} textAnchor="middle">{chainage(x)}</text>
        ))}

        {/* ---- plan (straightened alignment) */}
        <text className="pp-label" x={PAD.l} y={PROFILE_H + 26}>PLAN</text>
        <line className="pp-row" x1={sx(0)} x2={sx(profile.length)} y1={planY} y2={planY} />
        {profile.spans.map((s, i) => {
          const w = sx(s.x0 + s.length) - sx(s.x0);
          return (
            <g key={i}>
              <line x1={sx(s.x0)} x2={sx(s.x0 + s.length)} y1={planY} y2={planY} stroke={VOLTAGES[s.voltage].color} strokeWidth={2.5} />
              {w > 34 && <text className="pp-axis" x={sx(s.x0 + s.length / 2)} y={planY - 6} textAnchor="middle">{s.length.toFixed(0)} m</text>}
            </g>
          );
        })}
        {profile.stations.map((st) => {
          const d = st.deflection;
          const turn = d != null && Math.abs(d) >= 0.5;
          return (
            <g key={st.id} className="pp-st" onClick={() => pick(st.id)}>
              {st.strain ? (
                <rect className="pp-plan-st strain" x={sx(st.x) - 4} y={planY - 4} width={8} height={8} />
              ) : (
                <circle className="pp-plan-st" cx={sx(st.x)} cy={planY} r={3} />
              )}
              {turn && (
                <text className={`pp-defl ${Math.abs(d!) > 30 ? 'bad' : ''}`} x={sx(st.x)} y={planY + 17} textAnchor="middle">
                  {Math.abs(d!).toFixed(1)}° {d! > 0 ? 'R' : 'L'}
                </text>
              )}
            </g>
          );
        })}

        {/* ---- hover read-out */}
        {hover && (
          <g className="pp-hover">
            <line className="pp-cursor" x1={hover.px} x2={hover.px} y1={PAD.t - 6} y2={planY + 4} />
            <circle cx={hover.px} cy={sy(hover.pt.cond)} r={3} fill="#fff" />
            <circle cx={hover.px} cy={sy(hover.pt.ground)} r={3} fill="#c9a26b" />
            <foreignObject x={Math.min(hover.px + 10, W - 190)} y={PAD.t} width={180} height={84}>
              <div className="pp-tip">
                <b>Ch {chainage(hover.pt.x, 1)}</b>
                <span>Ground {hover.pt.ground.toFixed(1)} m</span>
                <span>Conductor {hover.pt.cond.toFixed(1)} m</span>
                <span className={hover.pt.clear < profile.spans[hover.span].target ? 'bad' : 'ok'}>
                  Clearance {hover.pt.clear.toFixed(1)} m (target {profile.spans[hover.span].target} m)
                </span>
              </div>
            </foreignObject>
          </g>
        )}
      </svg>
      <div className="pp-legend muted">
        <span><i className="lg-ground" /> Ground</span>
        <span><i className="lg-cond" /> Lowest conductor</span>
        <span><i className="lg-gw" /> Earth wire / OPGW</span>
        <span><i className="lg-target" /> Clearance target</span>
        <span><i className="lg-sq" /> Strain / station · <i className="lg-dot" /> Suspension</span>
        <span>Vertical scale exaggerated · plan straightened, deflections shown L/R</span>
      </div>
    </div>
  );
}

function niceStep(raw: number) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

/** Inline styles for the downloaded SVG (light, print-friendly). */
const SVG_STYLE = `
text { font-family: Segoe UI, Arial, sans-serif; }
.pp-label { font-size: 11px; font-weight: 700; fill: #333; letter-spacing: 1px; }
.pp-axis { font-size: 9.5px; fill: #555; }
.pp-grid { stroke: #ddd; stroke-width: 1; }
.pp-axisline, .pp-row { stroke: #999; stroke-width: 1; }
.pp-ground-fill { fill: #efe3cf; }
.pp-ground { fill: none; stroke: #8b6b3d; stroke-width: 1.5; }
.pp-target { fill: none; stroke: #d9534f; stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.7; }
.pp-cond { fill: none; stroke-width: 1.8; }
.pp-gw { fill: none; stroke: #888; stroke-width: 1; }
.pp-tower { stroke: #333; stroke-width: 1.6; }
.pp-tower.strain { stroke-width: 3; }
.pp-hit { fill: transparent; }
.pp-tag { font-size: 9px; fill: #222; }
.pp-plan-st { fill: #fff; stroke: #333; stroke-width: 1.3; }
.pp-defl { font-size: 9px; fill: #333; }
.pp-defl.bad { fill: #d9534f; }
.pp-bad { fill: #d9534f; }
`;
