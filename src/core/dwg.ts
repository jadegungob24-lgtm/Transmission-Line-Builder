import {
  ACadVersion,
  CadDocument,
  Circle,
  Color,
  DwgWriter,
  Layer,
  Line,
  MeasurementUnits,
  Point,
  TextEntity,
  UnitsType,
  XYZ,
} from '@node-projects/acad-ts';
import { DEF_BY_ID } from '../catalog/structures';
import { VOLTAGES, type VoltageId } from '../catalog/voltages';
import { distanceM } from './geo';
import { toPrs92 } from './prs92';
import { structureTag } from './store';
import type { Span, Structure } from './types';

// AutoCAD DWG export: every structure plotted at its exact PRS92 / PTM
// coordinates (X = Easting, Y = Northing, Z = Ground Elevation in metres),
// with 3D survey points, structure symbols, coordinate labels, and span lines
// organized on dedicated CAD layers.

function hexToColor(hex: string): Color {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 255;
  const g = parseInt(h.slice(2, 4), 16) || 255;
  const b = parseInt(h.slice(4, 6), 16) || 255;
  return new Color(r, g, b);
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
  const noteLayer = addLayer(doc, 'TL_NOTES', Color.green);

  const lineLayers = new Map<VoltageId, Layer>();
  const getLineLayer = (vId: VoltageId): Layer => {
    let layer = lineLayers.get(vId);
    if (!layer) {
      const spec = VOLTAGES[vId];
      const safeLabel = spec.label.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
      layer = addLayer(doc, `TL_LINE_${safeLabel}`, hexToColor(spec.color));
      lineLayers.set(vId, layer);
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

    // Plan symbol: square for substations / power plants, circle for towers / poles
    if (def.role === 'substation' || def.role === 'source') {
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
    const voltageStr = def.voltages === 'any' ? '' : `, ${VOLTAGES[st.voltage].label}`;
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

  // 3. Header note & drawing extents
  if (rawPts.length > 0) {
    const zoneList = Array.from(zones).sort().join(', ');
    const note = new TextEntity(
      `${project} | PRS92 PTM Zone ${zoneList} | Units: Meters | ${rawPts.length} Structures, ${spanList.length} Spans`,
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
