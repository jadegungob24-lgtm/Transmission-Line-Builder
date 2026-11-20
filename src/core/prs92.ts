import proj4 from 'proj4';

// PRS92 / Philippine Transverse Mercator (PTM), zones I–V (EPSG:3121–3125).
// Transverse Mercator on the Clarke 1866 ellipsoid, scale 0.99995, false easting
// 500 000 m, with the 7-parameter PRS92 ↔ WGS 84 shift (EPSG:15708). The map and
// terrain work in WGS 84, so positions are converted through that shift.

const TOWGS84 = '-127.62,-67.24,-47.04,3.068,-4.903,-1.578,-1.06';

export interface PtmZone {
  zone: number;
  roman: string;
  epsg: number;
  centralMeridian: number;
}

export const PTM_ZONES: PtmZone[] = [1, 2, 3, 4, 5].map((zone) => ({
  zone,
  roman: ['I', 'II', 'III', 'IV', 'V'][zone - 1],
  epsg: 3120 + zone,
  centralMeridian: 115 + zone * 2,
}));

const converters = PTM_ZONES.map((z) =>
  proj4(
    'EPSG:4326',
    `+proj=tmerc +lat_0=0 +lon_0=${z.centralMeridian} +k=0.99995 +x_0=500000 +y_0=0 +ellps=clrk66 +towgs84=${TOWGS84} +units=m +no_defs`,
  ),
);

/** PTM zone by longitude: each zone spans 1° either side of its central meridian (I: <118°E … V: ≥124°E). */
export function ptmZone(lng: number): PtmZone {
  const i = Math.max(0, Math.min(4, Math.floor((lng - 116) / 2)));
  return PTM_ZONES[i];
}

export interface Prs92Coord {
  zone: PtmZone;
  northing: number;
  easting: number;
}

export function toPrs92(lng: number, lat: number): Prs92Coord {
  const zone = ptmZone(lng);
  const [easting, northing] = converters[zone.zone - 1].forward([lng, lat]);
  return { zone, northing, easting };
}

/** PRS92 PTM northing/easting in the given zone (1–5) → WGS 84 lng/lat. */
export function fromPrs92(zone: number, northing: number, easting: number): { lng: number; lat: number } {
  const [lng, lat] = converters[Math.max(1, Math.min(5, zone)) - 1].inverse([easting, northing]);
  return { lng, lat };
}

const fmt = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export function formatPrs92(c: Prs92Coord) {
  return {
    zone: `PRS92 · PTM Zone ${c.zone.roman}`,
    northing: `N ${fmt(c.northing)} m`,
    easting: `E ${fmt(c.easting)} m`,
  };
}
