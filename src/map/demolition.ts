import * as THREE from 'three';

// Demolition effects. When a structure or span is removed, the 3D layer hands its
// meshes over here instead of deleting them, and they play out a short animation:
//
//   Line structures (towers, poles)  shudder, topple sideways, kick up dust, fade
//   Stations (substations, plants)   shake, collapse straight down into dust, fade
//   Conductors                       go slack, drop toward the ground, fade
//
// Objects are re-anchored to the map every frame (the scene uses a floating
// origin), so `anchor` converts a lng/lat/elevation to scene coordinates and
// returns the metre → scene scale at that latitude.

export type Anchor = (lng: number, lat: number, elev: number, out: THREE.Vector3) => number;

const D2R = Math.PI / 180;
const TOPPLE_MS = 1500;
const COLLAPSE_MS = 1400;
const WIRE_MS = 950;
const DUST_MS = 1700;

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface FallingStructure {
  mesh: THREE.Mesh;
  glow?: THREE.Mesh;
  mats: THREE.Material[];
  lng: number;
  lat: number;
  elev: number;
  heading: number;
  height: number;
  radius: number;
  topple: boolean;
  dir: 1 | -1;
  start: number;
  impact: boolean;
}

interface FallingWire {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  lng: number;
  lat: number;
  elev: number;
  start: number;
}

interface DustCloud {
  group: THREE.Group;
  mat: THREE.MeshLambertMaterial;
  puffs: { mesh: THREE.Mesh; from: THREE.Vector3; vel: THREE.Vector3; r0: number; r1: number }[];
  lng: number;
  lat: number;
  elev: number;
  start: number;
  peak: number;
}

const PUFF_GEOMETRY = new THREE.IcosahedronGeometry(1, 1);

export class Demolitions {
  private structures: FallingStructure[] = [];
  private wires: FallingWire[] = [];
  private dust: DustCloud[] = [];
  private qHead = new THREE.Quaternion();
  private qTilt = new THREE.Quaternion();
  private pos = new THREE.Vector3();
  private static Z = new THREE.Vector3(0, 0, 1);
  private static Y = new THREE.Vector3(0, 1, 0);

  constructor(private scene: THREE.Scene) {}

  get active() {
    return this.structures.length + this.wires.length + this.dust.length > 0;
  }

  /** Take over a removed structure's meshes and play its demolition. */
  addStructure(
    mesh: THREE.Mesh,
    glow: THREE.Mesh | undefined,
    info: { lng: number; lat: number; elev: number; heading: number; height: number; radius: number; topple: boolean },
    now: number,
  ) {
    const mats: THREE.Material[] = [];
    const fade = (m: THREE.Mesh) => {
      const src = m.material as THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
      const mat = src.clone();
      mat.transparent = true;
      mat.opacity = 1;
      if ('emissive' in mat) (mat as THREE.MeshStandardMaterial).emissive.set(0x000000);
      m.material = mat;
      mats.push(mat);
    };
    fade(mesh);
    if (glow) fade(glow);
    mesh.castShadow = true;
    this.structures.push({ mesh, glow, mats, ...info, dir: Math.random() < 0.5 ? -1 : 1, start: now, impact: false });
    // a small puff where the footings let go
    this.addDust(info.lng, info.lat, info.elev, 0, 0, info.topple ? info.radius * 0.6 : info.radius * 0.5, info.topple ? 5 : 8, now, 0.35);
  }

  /** Take over a removed span's conductors: they slacken, drop and fade. */
  addWire(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>, anchorAt: { lng: number; lat: number; elev: number }, now: number) {
    const u = mesh.material.uniforms;
    u.uSel.value = 0;
    mesh.material.transparent = true;
    mesh.renderOrder = 3;
    this.wires.push({ mesh, ...anchorAt, start: now });
  }

  private addDust(lng: number, lat: number, elev: number, offE: number, offN: number, radius: number, count: number, now: number, peak = 0.42) {
    const mat = new THREE.MeshLambertMaterial({ color: 0xcdbfa3, transparent: true, opacity: 0, depthWrite: false });
    const group = new THREE.Group();
    group.renderOrder = 4;
    const puffs: DustCloud['puffs'] = [];
    // Many small, overlapping, slightly flattened puffs read as one soft cloud.
    const n = Math.round(count * 1.6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.9;
      const d = radius * Math.sqrt(Math.random()) * 0.8;
      const from = new THREE.Vector3(offE + Math.cos(a) * d, offN + Math.sin(a) * d, radius * (0.05 + Math.random() * 0.15));
      const vel = new THREE.Vector3(Math.cos(a) * radius * 0.4, Math.sin(a) * radius * 0.4, radius * (0.15 + Math.random() * 0.35));
      const mesh = new THREE.Mesh(PUFF_GEOMETRY, mat);
      mesh.frustumCulled = false;
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      group.add(mesh);
      puffs.push({ mesh, from, vel, r0: radius * 0.12, r1: radius * (0.28 + Math.random() * 0.24) });
    }
    this.scene.add(group);
    this.dust.push({ group, mat, puffs, lng, lat, elev, start: now, peak });
  }

  /** Advance every animation. Returns true while anything is still playing. */
  update(now: number, anchor: Anchor, visible: boolean): boolean {
    // ---- structures
    this.structures = this.structures.filter((f) => {
      const dur = f.topple ? TOPPLE_MS : COLLAPSE_MS;
      const t = (now - f.start) / dur;
      if (t >= 1) {
        this.scene.remove(f.mesh);
        if (f.glow) this.scene.remove(f.glow);
        f.mats.forEach((m) => m.dispose());
        return false;
      }
      const k = anchor(f.lng, f.lat, f.elev, this.pos);
      this.qHead.setFromAxisAngle(Demolitions.Z, -f.heading * D2R);
      let sink = 0;
      let opacity = 1;
      let sz = 1;
      if (f.topple) {
        // shudder → accelerating fall → small bounce → fade into the ground
        let angle: number;
        if (t < 0.14) angle = Math.sin(now * 0.09) * 0.8 * (1 - t / 0.14);
        else if (t < 0.6) angle = Math.pow((t - 0.14) / 0.46, 2) * 86;
        else if (t < 0.7) angle = 86 - 4 * Math.sin((Math.PI * (t - 0.6)) / 0.1);
        else angle = 86;
        this.qTilt.setFromAxisAngle(Demolitions.Y, f.dir * angle * D2R);
        f.mesh.quaternion.copy(this.qHead).multiply(this.qTilt);
        if (!f.impact && t >= 0.6) {
          f.impact = true;
          // dust where the tower body hits the ground, along its fallen length
          const h = f.heading * D2R;
          const reach = f.height * 0.5 * f.dir;
          this.addDust(f.lng, f.lat, f.elev, Math.cos(h) * reach, -Math.sin(h) * reach, Math.max(6, f.height * 0.35), 12, now);
        }
        if (t > 0.72) {
          const s = (t - 0.72) / 0.28;
          opacity = 1 - smooth(s);
          sink = s * 2;
        }
      } else {
        // shake → collapse downward → fade
        const shake = t < 0.5 ? Math.sin(now * 0.11) * 0.5 * (1 - t / 0.5) : 0;
        this.qTilt.setFromAxisAngle(Demolitions.Y, shake * D2R);
        f.mesh.quaternion.copy(this.qHead).multiply(this.qTilt);
        const c = clamp01((t - 0.15) / 0.55);
        sz = 1 - 0.97 * c * c;
        if (!f.impact && t >= 0.3) {
          f.impact = true;
          this.addDust(f.lng, f.lat, f.elev, 0, 0, Math.max(10, f.radius * 0.55), 16, now);
        }
        if (t > 0.65) opacity = 1 - smooth((t - 0.65) / 0.35);
      }
      f.mesh.position.copy(this.pos);
      f.mesh.position.z -= sink * k;
      f.mesh.scale.set(k, k, k * sz);
      f.mesh.visible = visible;
      if (f.glow) {
        f.glow.position.copy(f.mesh.position);
        f.glow.quaternion.copy(f.mesh.quaternion);
        f.glow.scale.copy(f.mesh.scale);
        f.glow.visible = visible;
      }
      f.mats.forEach((m) => (m.opacity = opacity));
      return true;
    });

    // ---- conductors
    this.wires = this.wires.filter((w) => {
      const t = (now - w.start) / WIRE_MS;
      if (t >= 1) {
        this.scene.remove(w.mesh);
        w.mesh.geometry.dispose();
        w.mesh.material.dispose();
        return false;
      }
      const k = anchor(w.lng, w.lat, w.elev, w.mesh.position);
      w.mesh.scale.setScalar(k);
      const u = w.mesh.material.uniforms;
      u.uDrop.value = Math.pow(clamp01(t / 0.7), 2);
      u.uFade.value = 1 - smooth(clamp01((t - 0.45) / 0.55));
      w.mesh.visible = visible;
      return true;
    });

    // ---- dust
    this.dust = this.dust.filter((d) => {
      const t = (now - d.start) / DUST_MS;
      if (t >= 1) {
        this.scene.remove(d.group);
        d.mat.dispose();
        return false;
      }
      const k = anchor(d.lng, d.lat, d.elev, d.group.position);
      d.group.scale.setScalar(k);
      const grow = 1 - Math.pow(1 - t, 3);
      for (const p of d.puffs) {
        p.mesh.position.copy(p.from).addScaledVector(p.vel, grow);
        const r = p.r0 + (p.r1 - p.r0) * grow;
        p.mesh.scale.set(r, r, r * 0.7);
      }
      d.mat.opacity = d.peak * (t < 0.12 ? t / 0.12 : Math.pow(1 - (t - 0.12) / 0.88, 1.6));
      d.group.visible = visible;
      return true;
    });

    return this.active;
  }
}
