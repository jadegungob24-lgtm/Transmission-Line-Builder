import * as THREE from 'three';

// Shared uniforms are single objects referenced by every span material, so one
// assignment per frame animates every conductor on the map.
export const wireShared = {
  uTime: { value: 0 },
  uWind: { value: 0.3 },
  uMinRad: { value: 0.05 },
  uSunDir: { value: new THREE.Vector3(0.3, 0.3, 0.9) },
  uSunI: { value: 1 },
  uAmb: { value: 0.5 },
  uNight: { value: 0 },
  uGlow: { value: 1 },
  uFlow: { value: 1 },
};

const VERT = /* glsl */ `
attribute vec3 aSway;
attribute vec3 aMisc;
uniform float uTime, uWind, uMinRad, uDrop;
varying float vT;
varying float vKind;
varying vec3 vN;
void main() {
  vT = aMisc.x;
  vKind = aMisc.z;
  float ph = aMisc.y * 6.2831;
  // swing angle: steady blow-out + gusts + a faint aeolian shimmer
  float phi = uWind * (0.20 + 0.10 * sin(uTime * 0.8 + ph) + 0.04 * sin(uTime * 2.1 + ph * 1.7))
            + 0.012 * sin(uTime * 1.7 + ph * 3.0);
  vec3 p = position + vec3(aSway.xy * sin(phi), aSway.z * (1.0 - cos(phi)));
  // demolition: the wire goes slack and drops; ends stay at the attachments
  p.z -= aSway.z * uDrop * 3.0 + uDrop * 4.0 * aMisc.x * (1.0 - aMisc.x) * 4.0;
  float r = max(mix(0.045, 0.03, vKind), uMinRad);
  p += normal * r;
  vN = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor, uSunDir;
uniform float uState, uProgress, uTime, uLen, uNight, uGlow, uFlow, uSel, uSunI, uAmb, uFade;
varying float vT;
varying float vKind;
varying vec3 vN;
void main() {
  if (uState > 1.5 && vT > uProgress) discard;
  float l = uAmb + 0.3 + uSunI * 0.45 * max(dot(normalize(vN), uSunDir), 0.0);
  vec3 col = mix(vec3(0.82, 0.84, 0.87), vec3(0.56, 0.58, 0.61), vKind) * l;
  if (uState > 1.5) {
    // under construction: striped pilot line being pulled out
    float s = step(0.5, fract(vT * uLen / 14.0));
    col = mix(vec3(1.0, 0.62, 0.1), vec3(0.12), s * 0.65);
  } else if (uState > 0.5) {
    if (vKind < 0.5) {
      float x = vT * uLen / 90.0 - uTime * 1.3;
      float pulse = pow(0.5 + 0.5 * sin(x * 6.2831), 10.0) * uFlow;
      vec3 g = mix(uColor, vec3(1.0, 0.95, 0.7), 0.3);
      col = mix(col, g, uGlow * (0.28 + 0.45 * uNight)) + g * pulse * (0.9 + uNight);
    }
  } else {
    col *= 0.8;
  }
  vec3 hi = uSel > 1.5 ? vec3(1.0, 0.25, 0.2) : vec3(1.0, 0.95, 0.35);
  col = mix(col, hi, min(uSel, 1.0) * 0.7);
  gl_FragColor = vec4(col, uFade);
}`;

export function makeWireMaterial(color: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    uniforms: {
      ...wireShared,
      uColor: { value: new THREE.Color(color) },
      uState: { value: 2 },
      uProgress: { value: 0 },
      uLen: { value: 300 },
      uSel: { value: 0 },
      uFade: { value: 1 },
      uDrop: { value: 0 },
    },
  });
}
