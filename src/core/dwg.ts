import {
  ACadVersion,
  CadDocument,
  Circle,
  Color,
  DwgWriter,
  Layer,
  Line,
  LwPolyline,
  LwPolylineVertex,
  MeasurementUnits,
  Point,
  TextEntity,
  UnitsType,
  XY,
  XYZ,
} from '@node-projects/acad-ts';
import { DEF_BY_ID } from '../catalog/structures';
import { VOLTAGES, type VoltageId } from '../catalog/voltages';
import { distanceM } from './geo';
import { toPrs92 } from './prs92';
import { buildRowCorridorsPlan } from './row';
import { structureTag } from './store';
import type { Span, Structure } from './types';

// AutoCAD DWG export: every structure plotted at its exact PRS92 / PTM
// coordinates (X = Easting, Y = Northing, Z = Ground Elevation in metres),
// with 3D survey points, structure symbols, coordinate labels, and span lines
// organized on dedicated CAD layers.

function hexToColor(hex: string): Color {
  const h = hex.replace('#', '');
  const ch = (start: number) => {
    const n = parseInt(h.slice(start, start + 2), 16);
    return Number.isNaN(n) ? 255 : n;
  };
  return new Color(ch(0), ch(2), ch(4));
}

function addLayer(doc: CadDocument, name: string, color: Color): Layer {
  const existing = doc.layers?.tryGetValue(name);
  if (existing) return existing;
  const layer = new Layer(name);
  layer.color = color;
  doc.layers?.add(layer);
  return layer;
}

const fmtCoord = (v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function buildDwgBytes(
  project: string,
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
  exaggeration: number,
): Uint8Array {
  const doc = new CadDocument(ACadVersion.AC1027);
  if (doc.header) {
    doc.header.insUnits = UnitsType.Meters;
    doc.header.measurementUnits = MeasurementUnits.Metric;
    doc.header.pointDisplayMode = 34; // circle + cross survey marker
    doc.header.pointDisplaySize = 4;
  }

  const ms = doc.modelSpace;
  if (!ms) throw new Error('CAD model space unavailable');

  const ptsLayer = addLayer(doc, 'TL_STRUCTURES_PTS', Color.yellow);
  const symLayer = addLayer(doc, 'TL_STRUCTURES_SYM', Color.cyan);
  const lblLayer = addLayer(doc, 'TL_LABELS', new Color(7));
  const spanLblLayer = addLayer(doc, 'TL_SPAN_LABELS', Color.lightGray);
  const rowLayer = addLayer(doc, 'TL_ROW_CORRIDOR', Color.cyan);
  const rowLblLayer = addLayer(doc, 'TL_ROW_LABELS', Color.cyan);
  const noteLayer = addLayer(doc, 'TL_NOTES', Color.green);

  const lineLayers = new Map<VoltageId, Layer>();
  const getLineLayer = (vId: VoltageId): Layer => {
    let layer = lineLayers.get(vId);
    if (!layer) {
      const spec = VOLTAGES[vId];
      const safeLabel = spec.label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      layer = addLayer(doc, `TL_LINE_${safeLabel}`, hexToColor(spec.centerlineColor));
      lineLayers.set(vId, layer);
    }
    return layer;
  };

  const clLayers = new Map<VoltageId, Layer>();
  const getCenterlineLayer = (vId: VoltageId): Layer => {
    let layer = clLayers.get(vId);
    if (!layer) {
      const spec = VOLTAGES[vId];
      const safeLabel = spec.label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      layer = addLayer(doc, `TL_CENTERLINE_${safeLabel}`, hexToColor(spec.centerlineColor));
      clLayers.set(vId, layer);
    }
    return layer;
  };

  const list = Object.values(structures).sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const coords = new Map<string, { x: number; y: number; z: number; zoneRoman: string }>();
  const zones = new Set<string>();

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  const track = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  };

  // Scale text and symbols gracefully based on project extent (defaults fit typical 300–500 m spans)
  const rawPts = list.map((st) => {
    const c = toPrs92(st.lng, st.lat);
    const z = st.elev / (exaggeration || 1);
    coords.set(st.id, { x: c.easting, y: c.northing, z, zoneRoman: c.zone.roman });
    zones.add(c.zone.roman);
    track(c.easting, c.northing, z);
    return { st, x: c.easting, y: c.northing, z };
  });

  const symRadius = 6;
  const tagTextH = 8;
  const coordTextH = 4.5;

  // 1. Structures: 3D POINT + plan symbol + tag & PRS92 coordinate labels
  for (const { st, x, y, z } of rawPts) {
    const def = DEF_BY_ID[st.defId];
    const tag = structureTag(st);
    const pos = new XYZ(x, y, z);

    // Exact 3D survey point at (Easting, Northing, Ground Elevation)
    const pt = new Point(pos);
    pt.layer = ptsLayer;
    ms.entities.add(pt);

    // Plan symbol: exact rotated lot boundary for sized substations, square for other stations, circle for towers / poles
    if (def.footprint) {
      const [fw, fd] = def.footprint;
      const hx = fw / 2;
      const hy = fd / 2;
      const rad = (st.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const localCorners: [number, number][] = [
        [-hx, -hy],
        [hx, -hy],
        [hx, hy],
        [-hx, hy],
      ];
      const verts = localCorners.map(([lx, ly]) => {
        const rx = x + lx * cos + ly * sin;
        const ry = y - lx * sin + ly * cos;
        track(rx, ry, z);
        return new LwPolylineVertex(new XY(rx, ry));
      });
      const lot = new LwPolyline(verts);
      lot.isClosed = true;
      lot.layer = symLayer;
      ms.entities.add(lot);
    } else if (def.role === 'substation' || def.role === 'source') {
      const r = symRadius * 1.5;
      const corners = [
        new XYZ(x - r, y - r, z),
        new XYZ(x + r, y - r, z),
        new XYZ(x + r, y + r, z),
        new XYZ(x - r, y + r, z),
      ];
      for (let i = 0; i < 4; i++) {
        const edge = new Line(corners[i], corners[(i + 1) % 4]);
        edge.layer = symLayer;
        ms.entities.add(edge);
      }
    } else {
      const circle = new Circle(pos, symRadius);
      circle.layer = symLayer;
      ms.entities.add(circle);
    }

    // Structure tag & type label
    const voltageStr = def.voltages === 'any' ? (def.areaHa != null ? `, ${def.areaHa.toFixed(1)} ha` : '') : `, ${VOLTAGES[st.voltage].label}`;
    const label1 = new TextEntity(`${tag} (${def.short}${voltageStr})`);
    label1.insertPoint = new XYZ(x + symRadius + 4, y + 2, z);
    label1.height = tagTextH;
    label1.layer = lblLayer;
    ms.entities.add(label1);

    // PRS92 Easting / Northing / Elevation label
    const label2 = new TextEntity(
      `E ${fmtCoord(x)}  N ${fmtCoord(y)}  EL ${z.toFixed(1)}m`,
    );
    label2.insertPoint = new XYZ(x + symRadius + 4, y - coordTextH - 2, z);
    label2.height = coordTextH;
    label2.layer = lblLayer;
    ms.entities.add(label2);
  }

  // 2. Spans: 3D LINEs per voltage layer + midpoint span length labels
  const spanList = Object.values(spans)
    .map((sp) => ({ sp, A: structures[sp.a], B: structures[sp.b] }))
    .filter((r) => r.A && r.B);

  for (const { sp, A, B } of spanList) {
    const pA = coords.get(A.id);
    const pB = coords.get(B.id);
    if (!pA || !pB) continue;

    const line = new Line(new XYZ(pA.x, pA.y, pA.z), new XYZ(pB.x, pB.y, pB.z));
    line.layer = getLineLayer(sp.voltage);
    ms.entities.add(line);

    const mx = (pA.x + pB.x) / 2;
    const my = (pA.y + pB.y) / 2;
    const mz = (pA.z + pB.z) / 2;
    let angle = Math.atan2(pB.y - pA.y, pB.x - pA.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;

    const spanText = new TextEntity(
      `${distanceM(A, B).toFixed(1)} m (${VOLTAGES[sp.voltage].label})`,
    );
    spanText.insertPoint = new XYZ(mx, my + 4, mz);
    spanText.height = 4.5;
    spanText.rotation = angle;
    spanText.layer = spanLblLayer;
    ms.entities.add(spanText);
  }

  // 3. Alignment centerlines (voltage-colored) & ROW corridors (closed LwPolyline per alignment)
  const corridors = buildRowCorridorsPlan(structures, spans, coords);
  let totalRowAreaM2 = 0;
  for (const c of corridors) {
    totalRowAreaM2 += c.areaM2;

    // Continuous alignment centerline colored by NGCP voltage code
    const clPoly = new LwPolyline(c.centerline.map((p) => new LwPolylineVertex(new XY(p.x, p.y))));
    clPoly.isClosed = false;
    clPoly.layer = getCenterlineLayer(c.voltage);
    ms.entities.add(clPoly);

    // Closed ROW corridor boundary polyline
    const poly = new LwPolyline(c.ring.map((p) => new LwPolylineVertex(new XY(p.x, p.y))));
    poly.isClosed = true;
    poly.layer = rowLayer;
    ms.entities.add(poly);

    for (const p of c.ring) track(p.x, p.y, 0);

    // Label along the middle segment of the left ROW boundary edge
    const midIdx = Math.floor((c.left.length - 1) / 2);
    const p1 = c.left[midIdx];
    const p2 = c.left[midIdx + 1];
    if (p1 && p2) {
      let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      const areaHa = c.areaM2 / 10000;
      const rowText = new TextEntity(
        `ROW ±${c.halfWidthM.toFixed(1)}m FROM CL (${(c.halfWidthM * 2).toFixed(1)}m TOTAL · ${VOLTAGES[c.voltage].label} · ${areaHa.toFixed(2)} ha)`,
      );
      rowText.insertPoint = new XYZ((p1.x + p2.x) / 2, (p1.y + p2.y) / 2 + 6, 0);
      rowText.height = 5.5;
      rowText.rotation = angle;
      rowText.layer = rowLblLayer;
      ms.entities.add(rowText);
    }
  }

  // 4. Header note & drawing extents
  if (rawPts.length > 0) {
    const zoneList = Array.from(zones).sort().join(', ');
    const rowNote = corridors.length > 0 ? ` | ROW Area: ${(totalRowAreaM2 / 10000).toFixed(2)} ha` : '';
    const note = new TextEntity(
      `${project} | PRS92 PTM Zone ${zoneList} | Units: Meters | ${rawPts.length} Structures, ${spanList.length} Spans${rowNote}`,
    );
    const pad = Math.max(40, (maxY - minY) * 0.05);
    note.insertPoint = new XYZ(minX, maxY + pad, 0);
    note.height = 12;
    note.layer = noteLayer;
    ms.entities.add(note);

    if (doc.header) {
      doc.header.modelSpaceExtMin = new XYZ(minX - 50, minY - 50, Math.min(0, minZ));
      doc.header.modelSpaceExtMax = new XYZ(maxX + 150, maxY + pad + 40, Math.max(0, maxZ));
    }
  }

  return DwgWriter.writeToBuffer(doc);
}

export function buildDwg(
  project: string,
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
  exaggeration: number,
): Blob {
  const bytes = buildDwgBytes(project, structures, spans, exaggeration);
  return new Blob([bytes as BlobPart], { type: 'application/acad' });
}
