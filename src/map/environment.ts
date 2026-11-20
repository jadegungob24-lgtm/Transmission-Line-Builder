import * as THREE from 'three';

// Fixed daytime lighting. The simulator always runs in late-morning sun:
// high enough for bright, readable colours, low enough for tower shadows.

export interface SunState {
  /** Unit vector pointing at the sun in East/North/Up. */
  dir: THREE.Vector3;
  /** Elevation above the horizon in degrees. */
  elevation: number;
  /** Azimuth in degrees clockwise from north. */
  azimuth: number;
}

const SUN_ELEVATION = 55;
const SUN_AZIMUTH = 140;

function makeSun(): SunState {
  const el = (SUN_ELEVATION * Math.PI) / 180;
  const az = (SUN_AZIMUTH * Math.PI) / 180;
  return {
    dir: new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.cos(el) * Math.cos(az), Math.sin(el)),
    elevation: SUN_ELEVATION,
    azimuth: SUN_AZIMUTH,
  };
}

export const SUN: SunState = makeSun();

export function skyColors(rain: boolean) {
  if (rain) return { sky: '#8a96a3', horizon: '#aab4be', fog: '#b4bdc6' };
  return { sky: '#4f9fe8', horizon: '#cfe6fa', fog: '#dbe9f5' };
}
