// Geographic helpers. Everything the 3D scene needs is expressed in Web-Mercator
// units (0..1 across the world), then converted to metres local to a structure.

export const EARTH_CIRC = 40075016.686;
const D2R = Math.PI / 180;

/** Camera is locked to this box (Philippines plus a little sea room). */
export const PH_MAX_BOUNDS: [[number, number], [number, number]] = [
  [112.5, 2.0],
  [131.0, 23.5],
];
export const PH_VIEW_BOUNDS: [[number, number], [number, number]] = [
  [116.6, 4.4],
  [127.0, 21.3],
];

/**
 * Coarse buildable-territory polygon [lng, lat]. It hugs the archipelago and
 * deliberately excludes Sabah (Borneo) and Taiwan, which fall inside the
 * bounding box. Combined with the "elevation above sea level" test this limits
 * construction to Philippine land.
 */
export const PH_POLY: [number, number][] = [
  [116.8, 7.62], [116.8, 9.0], [118.5, 11.8], [119.3, 13.0], [119.5, 16.5],
  [120.0, 19.0], [121.0, 21.3], [122.5, 21.3], [122.6, 18.8], [122.7, 17.0],
  [124.7, 14.2], [125.6, 12.8], [126.3, 10.5], [126.9, 8.0], [126.8, 6.0],
  [125.9, 5.0], [125.2, 4.9], [122.5, 5.4], [120.5, 4.4], [119.33, 4.4],
  [119.33, 5.05], [119.4, 5.3], [119.0, 5.85], [118.35, 5.95], [118.0, 6.3],
  [117.5, 7.5],
];

export function inPhilippines(lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = PH_POLY.length - 1; i < PH_POLY.length; j = i++) {
    const [xi, yi] = PH_POLY[i];
    const [xj, yj] = PH_POLY[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const mercX = (lng: number) => (180 + lng) / 360;
export const mercY = (lat: number) =>
  (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;
/** Mercator units per metre at a latitude. */
export const mercScale = (lat: number) => 1 / (EARTH_CIRC * Math.cos(lat * D2R));

export interface LL {
  lng: number;
  lat: number;
}

/** East/North offset in metres from a to b (accurate for span-scale distances). */
export function enuOffset(a: LL, b: LL): [number, number] {
  const s = mercScale((a.lat + b.lat) / 2);
  return [(mercX(b.lng) - mercX(a.lng)) / s, -(mercY(b.lat) - mercY(a.lat)) / s];
}

export function distanceM(a: LL, b: LL): number {
  const [e, n] = enuOffset(a, b);
  return Math.hypot(e, n);
}

/** Bearing from a to b in degrees clockwise from north. */
export function bearingDeg(a: LL, b: LL): number {
  const [e, n] = enuOffset(a, b);
  return ((Math.atan2(e, n) / D2R) + 360) % 360;
}

export function offsetLL(a: LL, east: number, north: number): LL {
  const s = mercScale(a.lat);
  const mx = mercX(a.lng) + east * s;
  const my = mercY(a.lat) - north * s;
  const lng = mx * 360 - 180;
  const lat = (360 / Math.PI) * Math.atan(Math.exp(((180 - my * 360) * Math.PI) / 180)) - 90;
  return { lng, lat };
}

export const PLACES: { name: string; lng: number; lat: number; zoom: number }[] = [
  { name: 'Metro Manila', lng: 121.03, lat: 14.58, zoom: 12.5 },
  { name: 'Laguna de Bay', lng: 121.2, lat: 14.33, zoom: 11.5 },
  { name: 'Batangas', lng: 121.05, lat: 13.83, zoom: 12 },
  { name: 'Baguio / Cordillera', lng: 120.6, lat: 16.41, zoom: 12.5 },
  { name: 'Bicol (Mayon)', lng: 123.68, lat: 13.25, zoom: 12 },
  { name: 'Cebu', lng: 123.89, lat: 10.32, zoom: 12.5 },
  { name: 'Leyte (Tongonan)', lng: 124.64, lat: 11.14, zoom: 12.5 },
  { name: 'Iloilo', lng: 122.56, lat: 10.72, zoom: 12.5 },
  { name: 'Cagayan de Oro', lng: 124.65, lat: 8.45, zoom: 12.5 },
  { name: 'Davao', lng: 125.55, lat: 7.1, zoom: 12.5 },
  { name: 'Palawan', lng: 118.74, lat: 9.76, zoom: 12 },
];
