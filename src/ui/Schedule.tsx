import { useMemo, useState } from 'react';
import writeXlsxFile from 'write-excel-file/browser';
import { DEF_BY_ID, insulatorRange, modelOf } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { bearingDeg, distanceM } from '../core/geo';
import { buildKmz } from '../core/kmz';
import { toPrs92 } from '../core/prs92';
import { structureTag, useStore } from '../core/store';
import type { Span, Structure } from '../core/types';
import { lineAngle, neighbours } from '../network/connectivity';
import { runtime } from '../map/runtime';

// Tower schedule: every structure in the current project, numbered in the order it
// was plotted, with PRS92 coordinates. Updates live and exports to Excel (.xlsx).

export interface ScheduleRow {
  id: string;
  tag: string;
  type: string;
  voltage: string;
  zone: string;
  northing: number;
  easting: number;
  lat: number;
  lng: number;
  elev: number;
  height: number;
  /** Insulator string length (m); null for stations. */
  insulator: number | null;
  heading: number;
  angle: number | null;
  links: string;
}

export function scheduleRows(structures: Record<string, Structure>, spans: Record<string, Span>, exaggeration: number): ScheduleRow[] {
  return Object.values(structures)
    .sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
    .map((st) => {
      const def = DEF_BY_ID[st.defId];
      const c = toPrs92(st.lng, st.lat);
      const links = neighbours(st.id, spans)
        .map((n) => structures[n.other])
        .filter(Boolean)
        .sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
        .map((o) => `${structureTag(o)} (${distanceM(st, o).toFixed(0)} m)`)
        .join(', ');
      return {
        id: st.id,
        tag: structureTag(st),
        type: def.name,
        voltage: def.voltages === 'any' ? '—' : VOLTAGES[st.voltage].label,
        zone: `PTM Zone ${c.zone.roman}`,
        northing: c.northing,
        easting: c.easting,
        lat: st.lat,
        lng: st.lng,
        elev: st.elev / (exaggeration || 1),
        height: modelOf(st).height,
        insulator: insulatorRange(st.defId, st.voltage) ? st.insLen ?? insulatorRange(st.defId, st.voltage)!.std : null,
        heading: st.rotation,
        angle: lineAngle(st, structures, spans),
        links,
      };
    });
}

function spanRows(structures: Record<string, Structure>, spans: Record<string, Span>) {
  return Object.values(spans)
    .map((sp) => ({ sp, A: structures[sp.a], B: structures[sp.b] }))
    .filter((r) => r.A && r.B)
    .sort((x, y) => Math.min(x.A.no ?? 0, x.B.no ?? 0) - Math.min(y.A.no ?? 0, y.B.no ?? 0) || Math.max(x.A.no ?? 0, x.B.no ?? 0) - Math.max(y.A.no ?? 0, y.B.no ?? 0))
    .map(({ sp, A, B }) => {
      const [P, Q] = (A.no ?? 0) <= (B.no ?? 0) ? [A, B] : [B, A];
      return { from: structureTag(P), to: structureTag(Q), voltage: VOLTAGES[sp.voltage].label, length: distanceM(P, Q), bearing: bearingDeg(P, Q) };
    });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';

/** Download the current project's tower schedule (and spans) as an .xlsx workbook. */
export async function exportScheduleXlsx() {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.id === s.projectId)?.name ?? 'Project';
  const rows = scheduleRows(s.structures, s.spans, s.env.exaggeration);
  const head = (v: string) => ({ value: v, fontWeight: 'bold' as const, backgroundColor: '#DCE6F1', wrap: true });
  const num = (v: number, format: string) => ({ value: v, type: Number, format });

  const towers = [
    ['No.', 'Structure type', 'Voltage', 'PRS92 zone', 'Northing (m)', 'Easting (m)', 'Latitude (°)', 'Longitude (°)', 'Ground elev. (m)', 'Height (m)', 'Insulator (m)', 'Heading (°)', 'Line angle (°)', 'Connected to'].map(head),
    ...rows.map((r) => [
      r.tag, r.type, r.voltage, r.zone,
      num(r.northing, '#,##0.000'), num(r.easting, '#,##0.000'),
      num(r.lat, '0.000000'), num(r.lng, '0.000000'),
      num(r.elev, '0.0'), num(r.height, '0.0'),
      r.insulator == null ? null : num(r.insulator, '0.00'),
      num(r.heading, '0.0'),
      r.angle == null ? null : num(r.angle, '0.0'),
      r.links,
    ]),
  ];
  const spans = [
    ['From', 'To', 'Voltage', 'Span length (m)', 'Bearing (°)'].map(head),
    ...spanRows(s.structures, s.spans).map((r) => [r.from, r.to, r.voltage, num(r.length, '#,##0.0'), num(r.bearing, '0.0')]),
  ];

  await writeXlsxFile(
    [
      {
        data: towers, sheet: 'Tower Schedule', stickyRowsCount: 1,
        columns: [{ width: 9 }, { width: 38 }, { width: 9 }, { width: 13 }, { width: 15 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 10 }, { width: 9 }, { width: 10 }, { width: 9 }, { width: 10 }, { width: 40 }],
      },
      { data: spans, sheet: 'Spans', stickyRowsCount: 1, columns: [{ width: 9 }, { width: 9 }, { width: 9 }, { width: 14 }, { width: 11 }] },
    ],
  ).toFile(`${safeName(project)} - Tower Schedule.xlsx`);
}

/** Download the current project's structures as Google Earth pins (.kmz). */
export function exportKmz() {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.id === s.projectId)?.name ?? 'Project';
  const blob = buildKmz(project, s.structures, s.spans, s.env.exaggeration);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(project)}.kmz`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const f3 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function SchedulePanel({ onClose }: { onClose: () => void }) {
  const structures = useStore((s) => s.structures);
  const spans = useStore((s) => s.spans);
  const ex = useStore((s) => s.env.exaggeration);
  const selected = useStore((s) => s.selected);
  const movingId = useStore((s) => s.movingId);
  const multi = useStore((s) => s.multi);
  const project = useStore((s) => s.projects.find((p) => p.id === s.projectId)?.name ?? '');
  const rows = useMemo(() => scheduleRows(structures, spans, ex), [structures, spans, ex]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const focus = (r: ScheduleRow, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) return useStore.getState().toggleMulti(r.id);
    useStore.getState().set({ selected: { kind: 'structure', id: r.id }, multi: [] });
    const map = runtime.map;
    runtime.nav?.interrupt();
    map?.easeTo({ center: [r.lng, r.lat], zoom: Math.max(map.getZoom(), 16), duration: 800 });
  };
  const doExport = async () => {
    setBusy(true);
    setErr(null);
    try {
      await exportScheduleXlsx();
    } catch {
      setErr('Export failed. Please try again.');
    }
    setBusy(false);
  };
  const activeId = movingId ?? (selected?.kind === 'structure' ? selected.id : null);

  return (
    <div className="schedule panel">
      <div className="info-head">
        <b>Tower schedule · {project}</b>
        <div className="schedule-actions">
          <button className="primary" onClick={doExport} disabled={busy || rows.length === 0} title="Download as an Excel workbook (.xlsx)">
            {busy ? 'Exporting…' : 'Export to Excel'}
          </button>
          <button className="primary earth" onClick={exportKmz} disabled={rows.length === 0} title="Download pins for every structure (and the lines) as a Google Earth .kmz">
            Export to Google Earth
          </button>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>
      </div>
      {err && <p className="bad small">{err}</p>}
      {rows.length === 0 ? (
        <p className="muted small">No structures yet. Every tower, pole and station you plot is listed here with its PRS92 coordinates.</p>
      ) : (
        <div className="schedule-scroll">
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Type</th><th>Voltage</th><th>Zone</th><th className="r">Northing (m)</th><th className="r">Easting (m)</th>
                <th className="r">Elev. (m)</th><th className="r">Height (m)</th><th className="r">Insulator (m)</th><th className="r">Heading</th><th className="r">Angle</th><th>Connected to</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === activeId ? 'on' : multi.includes(r.id) ? 'multi' : ''} onClick={(e) => focus(r, e)} title="Click to select and fly to it · Ctrl+click to select several">
                  <td><b>{r.tag}</b></td>
                  <td>{DEF_BY_ID[structures[r.id].defId].short}</td>
                  <td>{r.voltage}</td>
                  <td>{r.zone.replace('PTM Zone ', '')}</td>
                  <td className="r">{f3(r.northing)}</td>
                  <td className="r">{f3(r.easting)}</td>
                  <td className="r">{r.elev.toFixed(0)}</td>
                  <td className="r">{r.height.toFixed(1)}</td>
                  <td className="r">{r.insulator == null ? '—' : r.insulator.toFixed(2)}</td>
                  <td className="r">{r.heading.toFixed(0)}°</td>
                  <td className="r">{r.angle == null ? '—' : `${r.angle.toFixed(1)}°`}</td>
                  <td className="links">{r.links}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small schedule-foot">{rows.length} structures · PRS92 / PTM coordinates · updates as you build</p>
    </div>
  );
}
