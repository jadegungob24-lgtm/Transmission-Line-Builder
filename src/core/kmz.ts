import { DEF_BY_ID, insulatorRange, modelOf } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { distanceM } from './geo';
import { toPrs92 } from './prs92';
import { structureTag } from './store';
import type { Span, Structure } from './types';

// Google Earth export: every structure as a pin (named T-001, SS-002 …, with its
// details in the balloon) and every span as a line, packed into a .kmz.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "#ff5a5f" → KML "aabbggrr". */
function kmlColor(hex: string, alpha = 'ff') {
  const h = hex.replace('#', '');
  return `${alpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`;
}

const ICON = 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
const STATION_ICON = 'http://maps.google.com/mapfiles/kml/shapes/square.png';

export function buildKml(project: string, structures: Record<string, Structure>, spans: Record<string, Span>, exaggeration: number): string {
  const list = Object.values(structures).sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const styles: string[] = [];
  for (const v of Object.values(VOLTAGES)) {
    styles.push(
      `<Style id="t-${v.id}"><IconStyle><color>${kmlColor(v.color)}</color><scale>1.1</scale><Icon><href>${ICON}</href></Icon></IconStyle>` +
        `<LabelStyle><scale>0.8</scale></LabelStyle></Style>`,
      `<Style id="l-${v.id}"><LineStyle><color>${kmlColor(v.color)}</color><width>3</width></LineStyle></Style>`,
    );
  }
  styles.push(
    `<Style id="ss"><IconStyle><color>ffffffff</color><scale>1.3</scale><Icon><href>${STATION_ICON}</href></Icon></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>`,
    `<Style id="pp"><IconStyle><color>ff3dd2ff</color><scale>1.3</scale><Icon><href>${STATION_ICON}</href></Icon></IconStyle><LabelStyle><scale>0.9</scale></LabelStyle></Style>`,
  );

  const pins = list.map((st) => {
    const def = DEF_BY_ID[st.defId];
    const c = toPrs92(st.lng, st.lat);
    const ins = insulatorRange(st.defId, st.voltage) ? (st.insLen ?? insulatorRange(st.defId, st.voltage)!.std) : null;
    const rows: [string, string][] = [
      ['Structure', def.name],
      ...(def.voltages === 'any' ? [] : [['Voltage', VOLTAGES[st.voltage].label] as [string, string]]),
      ['PRS92 zone', `PTM Zone ${c.zone.roman}`],
      ['Northing', `${c.northing.toFixed(3)} m`],
      ['Easting', `${c.easting.toFixed(3)} m`],
      ['Latitude', st.lat.toFixed(7)],
      ['Longitude', st.lng.toFixed(7)],
      ['Ground elevation', `${(st.elev / (exaggeration || 1)).toFixed(1)} m`],
      ['Height', `${modelOf(st).height.toFixed(1)} m`],
      ...(ins != null ? [['Insulator length', `${ins.toFixed(2)} m`] as [string, string]] : []),
      ['Heading', `${st.rotation.toFixed(1)}°`],
    ];
    const table = `<table>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const style = def.role === 'substation' ? 'ss' : def.role === 'source' ? 'pp' : `t-${st.voltage}`;
    return (
      `<Placemark><name>${esc(structureTag(st))}</name><styleUrl>#${style}</styleUrl>` +
      `<description><![CDATA[${table}]]></description>` +
      `<ExtendedData>${rows.map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(v)}</value></Data>`).join('')}</ExtendedData>` +
      `<Point><altitudeMode>clampToGround</altitudeMode><coordinates>${st.lng.toFixed(8)},${st.lat.toFixed(8)},0</coordinates></Point></Placemark>`
    );
  });

  const lines = Object.values(spans)
    .map((sp) => ({ sp, A: structures[sp.a], B: structures[sp.b] }))
    .filter((r) => r.A && r.B)
    .map(({ sp, A, B }) => {
      const [P, Q] = (A.no ?? 0) <= (B.no ?? 0) ? [A, B] : [B, A];
      return (
        `<Placemark><name>${esc(`${structureTag(P)} – ${structureTag(Q)}`)}</name><styleUrl>#l-${sp.voltage}</styleUrl>` +
        `<description>${esc(`${VOLTAGES[sp.voltage].label} · ${distanceM(P, Q).toFixed(0)} m`)}</description>` +
        `<LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode>` +
        `<coordinates>${P.lng.toFixed(8)},${P.lat.toFixed(8)},0 ${Q.lng.toFixed(8)},${Q.lat.toFixed(8)},0</coordinates></LineString></Placemark>`
      );
    });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(project)}</name>` +
    `<description>${esc(`Exported from PH Grid Builder · ${list.length} structures · PRS92 / PTM coordinates in each pin`)}</description>` +
    styles.join('') +
    `<Folder><name>Structures</name><open>1</open>${pins.join('')}</Folder>` +
    (lines.length ? `<Folder><name>Lines</name>${lines.join('')}</Folder>` : '') +
    `</Document></kml>`
  );
}

// ---------------------------------------------------------------- minimal zip (stored, no compression)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with the given files stored uncompressed (all a .kmz needs). */
export function zipStore(files: { name: string; data: Uint8Array }[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true);
    local.setUint32(22, f.data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)] as BlobPart[], { type: 'application/vnd.google-earth.kmz' });
}

export function buildKmz(project: string, structures: Record<string, Structure>, spans: Record<string, Span>, exaggeration: number): Blob {
  const kml = new TextEncoder().encode(buildKml(project, structures, spans, exaggeration));
  return zipStore([{ name: 'doc.kml', data: kml }]);
}
