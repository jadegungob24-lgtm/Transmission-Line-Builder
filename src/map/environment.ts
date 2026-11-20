import * as THREE from 'three';

// Sun position and derived lighting for a time of day (0..24 h).

export interface SunState {
  /** Unit vector pointing at the sun in East/North/Up. */
  dir: THREE.Vector3;
  /** Elevation above the horizon in degrees. */
  elevation: number;
  /** Azimuth in degrees clockwise from north. */
  azimuth: number;
  /** 0 by day, 1 at night. */
  night: number;
  /** Warm tint strength near sunrise / sunset. */
  golden: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function sunAt(hour: number): SunState {
  const h = ((hour % 24) + 24) % 24;
  const elevation = 72 * Math.sin((Math.PI * (h - 6)) / 12);
  const azimuth = (90 + ((h - 6) / 12) * 180 + 360) % 360;
  const el = (Math.max(elevation, 4) * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  const dir = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el));
  const night = 1 - smooth(-8, 8, elevation);
  const golden = smooth(-6, 4, elevation) * (1 - smooth(8, 30, elevation));
  return { dir, elevation, azimuth, night, golden };
}

const lerpHex = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);

export function skyColors(sun: SunState, rain: boolean) {
  let sky = lerpHex(0x4f9fe8, 0x050b1c, sun.night);
  let horizon = lerpHex(0xcfe6fa, 0x0d1730, sun.night);
  let fog = lerpHex(0xdbe9f5, 0x0a1224, sun.night);
  if (sun.golden > 0) {
    horizon = horizon.lerp(new THREE.Color(0xffa35c), sun.golden * 0.75);
    fog = fog.lerp(new THREE.Color(0xf2b184), sun.golden * 0.5);
    sky = sky.lerp(new THREE.Color(0x6f7fc4), sun.golden * 0.35);
  }
  if (rain) {
    const grey = lerpHex(0x8b97a3, 0x0b0f16, sun.night);
    sky = sky.lerp(grey, 0.8);
    horizon = horizon.lerp(grey, 0.7);
    fog = fog.lerp(grey, 0.7);
  }
  return { sky: `#${sky.getHexString()}`, horizon: `#${horizon.getHexString()}`, fog: `#${fog.getHexString()}` };
}

export function formatHour(h: number) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
