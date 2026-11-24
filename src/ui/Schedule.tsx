import { useMemo, useState } from 'react';
import writeXlsxFile from 'write-excel-file/browser';
import { DEF_BY_ID, defSupports, insulatorRange, modelOf, STRUCTURE_DEFS } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { distanceM } from '../core/geo';
import { buildNgcpWorkbookSheets } from '../core/excel';
import { buildKmz } from '../core/kmz';
import { fromPrs92, toPrs92 } from '../core/prs92';
import { autoTag, MAX_NAME, nameProblem, structureTag, useStore } from '../core/store';
import type { Span, Structure } from '../core/types';
import { angleRemark, lineAngle, neighbours } from '../network/connectivity';
import { runtime } from '../map/runtime';

// Tower schedule: every structure in the current project, numbered in the order it
// was plotted, with PRS92 coordinates. Updates live and exports to Excel (.xlsx).

export interface ScheduleRow {
  id: string;
  tag: string;
  type: string;
  voltage: string;
  zone: string;
  zoneNum: number;
  easting: number;
  northing: number;
  lat: number;
  lng: number;
  elev: number;
  height: number;
  /** Insulator string length (m); null for stations. */
  insulator: number | null;
  heading: number;
  angle: number | null;
  links: string;
  remark: string | null;
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
      const angle = lineAngle(st, structures, spans);
      return {
        id: st.id,
        tag: structureTag(st),
        type: def.name,
        voltage: def.voltages === 'any' ? '—' : VOLTAGES[st.voltage].label,
        zone: `PTM Zone ${c.zone.roman}`,
        zoneNum: c.zone.zone,
        easting: c.easting,
        northing: c.northing,
        lat: st.lat,
        lng: st.lng,
        elev: st.elev / (exaggeration || 1),
        height: modelOf(st).height,
        insulator: insulatorRange(st.defId, st.voltage) ? st.insLen ?? insulatorRange(st.defId, st.voltage)!.std : null,
        heading: st.rotation,
        angle,
        links,
        remark: angleRemark(st, angle),
      };
    });
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Project';

/** Download the current project's tower schedule in NGCP format with live Excel formulas (.xlsx). */
export async function exportScheduleXlsx() {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.id === s.projectId)?.name ?? 'Project';
  const sheets = buildNgcpWorkbookSheets(project, s.structures, s.spans, s.env.exaggeration);
  await writeXlsxFile(sheets as Parameters<typeof writeXlsxFile>[0], {
    fontFamily: 'Calibri',
    fontSize: 10,
  }).toFile(`${safeName(project)} - Tower Schedule.xlsx`);
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

/** Download the current project's structures and spans as an AutoCAD .dwg (PRS92 / PTM coordinates). */
export async function exportDwg() {
  const s = useStore.getState();
  const project = s.projects.find((p) => p.id === s.projectId)?.name ?? 'Project';
  const { buildDwg } = await import('../core/dwg');
  const blob = buildDwg(project, s.structures, s.spans, s.env.exaggeration);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(project)}.dwg`;
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
  const [dwgBusy, setDwgBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [coordEdit, setCoordEdit] = useState<{ id: string; zone: number; e: string; n: string; focus: 'e' | 'n' } | null>(null);
  const [coordBusy, setCoordBusy] = useState(false);
  const saveName = () => {
    if (!renaming) return;
    const problem = nameProblem(renaming.id, renaming.name);
    if (problem) return setNameErr(problem);
    useStore.getState().renameStructure(renaming.id, renaming.name);
    setNameErr(null);
    setRenaming(null);
  };
  const startCoordEdit = (r: ScheduleRow, focusField: 'e' | 'n', e: React.MouseEvent) => {
    e.stopPropagation();
    setNameErr(null);
    setRenaming(null);
    setCoordEdit({ id: r.id, zone: r.zoneNum, e: r.easting.toFixed(3), n: r.northing.toFixed(3), focus: focusField });
  };
  const saveCoord = async () => {
    if (!coordEdit || coordBusy) return;
    const eVal = parseFloat(coordEdit.e.replace(/[,\s]/g, ''));
    const nVal = parseFloat(coordEdit.n.replace(/[,\s]/g, ''));
    if (!isFinite(eVal) || !isFinite(nVal)) return setNameErr('Enter valid numbers for Easting and Northing');
    if (eVal < 100000 || eVal > 900000 || nVal < 400000 || nVal > 2400000) return setNameErr('Those coordinates are outside the PTM zone range');
    const p = fromPrs92(coordEdit.zone, nVal, eVal);
    setCoordBusy(true);
    setNameErr(null);
    const problem = runtime.ctrl ? await runtime.ctrl.relocate(coordEdit.id, p) : 'Map not ready';
    setCoordBusy(false);
    if (problem) return setNameErr(problem);
    useStore.getState().commitScheduleEdit(coordEdit.id);
    setCoordEdit(null);
  };

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
  const doExportDwg = async () => {
    setDwgBusy(true);
    setErr(null);
    try {
      await exportDwg();
    } catch {
      setErr('DWG export failed. Please try again.');
    }
    setDwgBusy(false);
  };
  const activeId = movingId ?? (selected?.kind === 'structure' ? selected.id : null);
  const warnCount = useMemo(() => rows.filter((r) => r.remark != null).length, [rows]);

  return (
    <div className="schedule panel">
      <div className="info-head">
        <b>Tower schedule · {project}</b>
        <div className="schedule-actions">
          <button className="primary" onClick={doExport} disabled={busy || rows.length === 0} title="Download as an Excel workbook (.xlsx)">
            {busy ? 'Exporting…' : 'Export to Excel'}
          </button>
          <button className="primary earth" onClick={exportKmz} disabled={rows.length === 0} title="Download structures, lines, and ROW corridors as a Google Earth .kmz">
            Export to Google Earth
          </button>
          <button className="primary cad" onClick={doExportDwg} disabled={dwgBusy || rows.length === 0} title="Download structures, lines, and ROW corridors with PRS92 / PTM coordinates as an AutoCAD .dwg">
            {dwgBusy ? 'Exporting…' : 'Export to DWG'}
          </button>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>
      </div>
      {err && <p className="bad small">{err}</p>}
      {nameErr && <p className="bad small">{nameErr}</p>}
      {rows.length === 0 ? (
        <p className="muted small">No structures yet. Every tower, pole and station you plot is listed here with its PRS92 coordinates.</p>
      ) : (
        <div className="schedule-scroll">
          <table>
            <thead>
              <tr>
                <th>No.</th><th>Type</th><th>Voltage</th><th>Zone</th><th className="r">Easting (m)</th><th className="r">Northing (m)</th>
                <th className="r">Elev. (m)</th><th className="r">Height (m)</th><th className="r">Insulator (m)</th><th className="r">Heading</th><th className="r">Angle</th><th>Connected to</th><th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = structures[r.id];
                const def = DEF_BY_ID[st.defId];
                const typeOpts = def.role === 'line' ? STRUCTURE_DEFS.filter((d) => d.role === 'line' && defSupports(d, st.voltage)) : [];
                const editingCoord = coordEdit?.id === r.id;
                return (
                <tr key={r.id} className={r.id === activeId ? 'on' : multi.includes(r.id) ? 'multi' : ''} onClick={(e) => focus(r, e)} title="Click to select and fly to it · Ctrl+click to select several">
                  <td className="name-cell" onClick={(e) => renaming?.id === r.id && e.stopPropagation()}>
                    {renaming?.id === r.id ? (
                      <span className="sched-rename">
                        <input
                          autoFocus maxLength={MAX_NAME} placeholder={autoTag(st)} value={renaming.name}
                          onChange={(e) => setRenaming({ id: r.id, name: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setRenaming(null); }}
                          onBlur={saveName}
                        />
                      </span>
                    ) : (
                      <>
                        <b>{r.tag}</b>
                        <button
                          className="rename-btn" title="Rename"
                          onClick={(e) => { e.stopPropagation(); setNameErr(null); setCoordEdit(null); setRenaming({ id: r.id, name: st.name ?? '' }); }}
                        >✎</button>
                      </>
                    )}
                  </td>
                  <td className="type-cell" onClick={(e) => typeOpts.length > 1 && e.stopPropagation()}>
                    {typeOpts.length > 1 ? (
                      <select
                        className="sched-type"
                        value={st.defId}
                        onChange={(e) => useStore.getState().changeStructureType(r.id, e.target.value, true)}
                        title="Change structure type"
                      >
                        {typeOpts.map((d) => (
                          <option key={d.id} value={d.id}>{d.short}</option>
                        ))}
                      </select>
                    ) : (
                      def.short
                    )}
                  </td>
                  <td>{r.voltage}</td>
                  <td>{r.zone.replace('PTM Zone ', '')}</td>
                  <td
                    className={`r coord-cell${editingCoord ? ' editing' : ''}`}
                    onClick={(e) => (editingCoord ? e.stopPropagation() : startCoordEdit(r, 'e', e))}
                    title="Click to edit Easting & Northing"
                  >
                    {editingCoord ? (
                      <input
                        className="sched-coord-input"
                        autoFocus={coordEdit.focus === 'e'}
                        inputMode="decimal"
                        disabled={coordBusy}
                        value={coordEdit.e}
                        onChange={(e) => setCoordEdit({ ...coordEdit, e: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') saveCoord(); if (e.key === 'Escape') { setCoordEdit(null); setNameErr(null); } }}
                      />
                    ) : (
                      <span className="coord-val">{f3(r.easting)}</span>
                    )}
                  </td>
                  <td
                    className={`r coord-cell${editingCoord ? ' editing' : ''}`}
                    onClick={(e) => (editingCoord ? e.stopPropagation() : startCoordEdit(r, 'n', e))}
                    title="Click to edit Easting & Northing"
                  >
                    {editingCoord ? (
                      <span className="sched-coord-wrap">
                        <input
                          className="sched-coord-input"
                          autoFocus={coordEdit.focus === 'n'}
                          inputMode="decimal"
                          disabled={coordBusy}
                          value={coordEdit.n}
                          onChange={(e) => setCoordEdit({ ...coordEdit, n: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter') saveCoord(); if (e.key === 'Escape') { setCoordEdit(null); setNameErr(null); } }}
                        />
                        <button className="coord-act ok" disabled={coordBusy} onClick={saveCoord} title="Apply coordinates (Enter)">✓</button>
                        <button className="coord-act" disabled={coordBusy} onClick={() => { setCoordEdit(null); setNameErr(null); }} title="Cancel (Esc)">×</button>
                      </span>
                    ) : (
                      <span className="coord-val">{f3(r.northing)}</span>
                    )}
                  </td>
                  <td className="r">{r.elev.toFixed(0)}</td>
                  <td className="r">{r.height.toFixed(1)}</td>
                  <td className="r">{r.insulator == null ? '—' : r.insulator.toFixed(2)}</td>
                  <td className="r">{r.heading.toFixed(0)}°</td>
                  <td className={`r${r.remark ? ' bad' : ''}`}>{r.angle == null ? '—' : `${r.angle.toFixed(1)}°`}</td>
                  <td className="links">{r.links}</td>
                  <td className="remark-cell">{r.remark ? <span className="bad">⚠ {r.remark}</span> : <span className="muted">—</span>}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small schedule-foot">
        {rows.length} structures
        {warnCount > 0 && <> · <span className="bad">{warnCount} {warnCount === 1 ? 'exceeds' : 'exceed'} design angle</span></>}
        {' · PRS92 / PTM coordinates · updates as you build'}
      </p>
    </div>
  );
}
