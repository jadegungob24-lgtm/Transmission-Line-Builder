import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MLMap } from 'maplibre-gl';
import { DEF_BY_ID, getModel } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { buildSpanGeometry, layoutSpan, SpanLayout, wireHeightAt } from '../conductors/spanWires';
import { makeWireMaterial, wireShared } from '../conductors/wireMaterial';
import { distanceM, LL, mercScale, mercX, mercY } from '../core/geo';
import { useStore } from '../core/store';
import type { Span, Structure } from '../core/types';
import { Demolitions } from './demolition';
import { SUN } from './environment';

// Three.js scene rendered inside MapLibre's GL context as a custom layer.
//
// Precision: the scene uses a local metric frame (x = east, y = north, z = up,
// metres) around a floating origin near the camera. Each frame the MapLibre
// mercator matrix is multiplied (in float64) by translate(origin) * scale(metre)
// and used as the projection matrix, so geometry stays jitter-free at street zoom.

const D2R = Math.PI / 180;
const BUILD_MS = 650;
const STRING_MS = 1100;
const SHOW_3D_ZOOM = 10.3;
/** More removals than this at once (Clear map, loading a file) skip the demolition animation. */
const MAX_ANIMATED_REMOVALS = 40;

export type Highlight = { kind: 'structure' | 'span'; id: string; mode: 'hover' | 'select' | 'delete' } | null;

interface SMesh {
  mesh: THREE.Mesh;
  glow?: THREE.Mesh;
  key: string;
  st: Structure;
  height: number;
}
interface WMesh {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  key: string;
  layout: SpanLayout;
  span: Span;
  A: Structure;
}

export interface GhostState {
  structures: Structure[];
  valid: boolean[];
  spans: { A: Structure; B: Structure; span: Span; valid: boolean }[];
}

export class SceneLayer implements CustomLayerInterface {
  id = 'grid-3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;

  map!: MLMap;
  renderer!: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.Camera();
  /** Last frame's full world → clip matrix, used for screen-space picking. */
  viewProj = new THREE.Matrix4();

  origin: LL = { lng: 121, lat: 14.5 };
  private s0 = mercScale(14.5);
  private structs = new Map<string, SMesh>();
  private wires = new Map<string, WMesh>();
  private dirty = true;
  private highlight: Highlight = null;

  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private hemi = new THREE.HemisphereLight(0xdfeeff, 0x6b6250, 1.1);
  private matStruct = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.62 });
  private matHover = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, emissive: 0x6a5a00 });
  private matDelete = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, emissive: 0x8a1408 });
  private matGhostOk = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.62, emissive: 0x1d7a3a, depthWrite: false });
  private matGhostBad = new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.62, emissive: 0x9a1a10, depthWrite: false });
  private matGlowOn = new THREE.MeshBasicMaterial({ color: 0xdce6ee });
  private matGlowOff = new THREE.MeshStandardMaterial({ color: 0xc9d0d6, metalness: 0.6, roughness: 0.4 });

  private ghostGroup = new THREE.Group();
  private ghostMeshes: THREE.Mesh[] = [];
  private ghostWires: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];

  private catcher: THREE.Mesh;
  private catcherAt: { lng: number; lat: number; R: number; t: number } | null = null;
  private clouds: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private unsub: (() => void) | null = null;
  private tmpV = new THREE.Vector3();
  private demolitions = new Demolitions(this.scene);
  private last = performance.now();
  private frames = 0;
  private fpsT = performance.now();
  onFps?: (fps: number) => void;
  zoom = 6;

  constructor() {
    this.scene.add(this.sun, this.sun.target, this.hemi, this.ghostGroup);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;

    this.catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.32, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    );
    this.catcher.receiveShadow = true;
    this.catcher.visible = false;
    this.catcher.frustumCulled = false;
    this.scene.add(this.catcher);

    this.clouds = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
          uTime: wireShared.uTime,
          uOff: { value: new THREE.Vector2() },
          uOpacity: { value: 0.6 },
          uCol: { value: new THREE.Color(1, 1, 1) },
          uCover: { value: 0.52 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vW;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xy;
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uOpacity, uCover;
          uniform vec2 uOff;
          uniform vec3 uCol;
          varying vec2 vW;
          float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          float n(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
          }
          float fbm(vec2 p) {
            float s = 0.0, a = 0.5;
            for (int i = 0; i < 5; i++) { s += a * n(p); p = p * 2.03 + 17.1; a *= 0.5; }
            return s;
          }
          void main() {
            vec2 p = (vW + uOff) / 9000.0 + vec2(uTime * 0.012, uTime * 0.004);
            float d = fbm(p);
            float a = smoothstep(uCover, uCover + 0.22, d);
            gl_FragColor = vec4(uCol * (0.85 + 0.25 * d), a * uOpacity);
          }`,
      }),
    );
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 10;
    this.scene.add(this.clouds);
  }

  // ------------------------------------------------------------------ lifecycle

  onAdd(map: MLMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl as WebGL2RenderingContext, antialias: true });
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const c = map.getCenter();
    this.setOrigin({ lng: c.lng, lat: c.lat });
    this.unsub = useStore.subscribe((s, p) => {
      if (s.structures !== p.structures || s.spans !== p.spans || s.network !== p.network || s.selected !== p.selected) this.dirty = true;
    });
  }

  onRemove() {
    this.unsub?.();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ frames & coords

  private setOrigin(o: LL) {
    this.origin = o;
    this.s0 = mercScale(o.lat);
    for (const s of this.structs.values()) this.placeMesh(s.mesh, s.st, s.glow);
    for (const w of this.wires.values()) this.placeWire(w.mesh, w.A);
    this.catcherAt = null;
  }

  worldOf(p: { lng: number; lat: number }, z = 0, out = new THREE.Vector3()) {
    return out.set((mercX(p.lng) - mercX(this.origin.lng)) / this.s0, -(mercY(p.lat) - mercY(this.origin.lat)) / this.s0, z);
  }

  private placeMesh(mesh: THREE.Object3D, st: Structure, glow?: THREE.Object3D) {
    this.worldOf(st, st.elev, mesh.position);
    mesh.rotation.set(0, 0, -st.rotation * D2R);
    const k = mercScale(st.lat) / this.s0;
    mesh.scale.set(k, k, k * mesh.userData.grow);
    if (glow) {
      glow.position.copy(mesh.position);
      glow.rotation.copy(mesh.rotation);
      glow.scale.copy(mesh.scale);
    }
  }

  private placeWire(mesh: THREE.Object3D, A: Structure) {
    this.worldOf(A, A.elev, mesh.position);
    mesh.scale.setScalar(mercScale(A.lat) / this.s0);
  }

  /** Screen (CSS px) position of a world point; null if behind the camera. */
  project(v: THREE.Vector3): { x: number; y: number } | null {
    const e = this.viewProj.elements;
    const w = e[3] * v.x + e[7] * v.y + e[11] * v.z + e[15];
    if (w <= 1e-6) return null;
    const x = (e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12]) / w;
    const y = (e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13]) / w;
    const c = this.map.getCanvas();
    return { x: ((x + 1) / 2) * c.clientWidth, y: ((1 - y) / 2) * c.clientHeight };
  }

  setHighlight(h: Highlight) {
    const a = this.highlight;
    if (a?.id === h?.id && a?.mode === h?.mode && a?.kind === h?.kind) return;
    this.highlight = h;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  // ------------------------------------------------------------------ sync with store

  private sync() {
    const { structures, spans, network, selected } = useStore.getState();
    const hl = this.highlight;
    const hlFor = (kind: 'structure' | 'span', id: string) => {
      if (hl && hl.kind === kind && hl.id === id) return hl.mode;
      if (selected && selected.kind === kind && selected.id === id) return 'select';
      return null;
    };

    // Removed structures and spans play a demolition animation, unless a lot
    // disappear at once (Clear map, loading a file) or the 3D view is off.
    const gone = [...this.structs.keys()].filter((id) => !structures[id]).length
      + [...this.wires.keys()].filter((id) => !spans[id]).length;
    const animateRemoval = gone > 0 && gone <= MAX_ANIMATED_REMOVALS && this.zoom >= SHOW_3D_ZOOM;
    const now = performance.now();

    for (const [id, s] of this.structs) {
      if (!structures[id]) {
        if (animateRemoval && s.mesh.userData.grow > 0) {
          const m = getModel(s.st.defId, s.st.voltage);
          s.mesh.geometry = m.geometry; // full detail, not the distance LOD
          this.demolitions.addStructure(s.mesh, s.glow, {
            lng: s.st.lng, lat: s.st.lat, elev: s.st.elev, heading: s.st.rotation,
            height: s.height, radius: m.radius, topple: DEF_BY_ID[s.st.defId].role === 'line',
          }, now);
        } else {
          this.scene.remove(s.mesh);
          if (s.glow) this.scene.remove(s.glow);
        }
        this.structs.delete(id);
      }
    }
    for (const st of Object.values(structures)) {
      const key = `${st.defId}|${st.voltage}`;
      let s = this.structs.get(st.id);
      if (!s || s.key !== key) {
        if (s) {
          this.scene.remove(s.mesh);
          if (s.glow) this.scene.remove(s.glow);
        }
        const m = getModel(st.defId, st.voltage);
        const mesh = new THREE.Mesh(m.geometry, this.matStruct);
        mesh.castShadow = true;
        mesh.userData.grow = 1;
        this.scene.add(mesh);
        let glow: THREE.Mesh | undefined;
        if (m.glow) {
          glow = new THREE.Mesh(m.glow, this.matGlowOff);
          glow.userData.grow = 1;
          this.scene.add(glow);
        }
        s = { mesh, glow, key, st, height: m.height };
        this.structs.set(st.id, s);
      }
      s.st = st;
      this.placeMesh(s.mesh, st, s.glow);
      const mode = hlFor('structure', st.id);
      s.mesh.material = mode === 'delete' ? this.matDelete : mode ? this.matHover : this.matStruct;
      if (s.glow) s.glow.material = network.energizedStructures.has(st.id) ? this.matGlowOn : this.matGlowOff;
    }

    for (const [id, w] of this.wires) {
      if (!spans[id]) {
        if (animateRemoval) {
          this.demolitions.addWire(w.mesh, { lng: w.A.lng, lat: w.A.lat, elev: w.A.elev }, now);
        } else {
          this.scene.remove(w.mesh);
          w.mesh.geometry.dispose();
          w.mesh.material.dispose();
        }
        this.wires.delete(id);
      }
    }
    for (const sp of Object.values(spans)) {
      const A = structures[sp.a];
      const B = structures[sp.b];
      if (!A || !B) continue;
      const key = `${A.lng},${A.lat},${A.rotation},${A.elev},${A.defId}|${B.lng},${B.lat},${B.rotation},${B.elev},${B.defId}|${sp.slotsA}|${sp.slotsB}`;
      let w = this.wires.get(sp.id);
      if (!w || w.key !== key) {
        const layout = layoutSpan(sp, A, B);
        const geom = buildSpanGeometry(layout);
        if (w) {
          w.mesh.geometry.dispose();
          w.mesh.geometry = geom;
          w.layout = layout;
          w.key = key;
        } else {
          const mat = makeWireMaterial(VOLTAGES[sp.voltage].color);
          const mesh = new THREE.Mesh(geom, mat);
          mesh.renderOrder = 2;
          this.scene.add(mesh);
          w = { mesh, key, layout, span: sp, A };
          this.wires.set(sp.id, w);
        }
        w.mesh.material.uniforms.uLen.value = layout.length;
      }
      w.span = sp;
      w.A = A;
      this.placeWire(w.mesh, A);
      const mode = hlFor('span', sp.id);
      w.mesh.material.uniforms.uSel.value = mode === 'delete' ? 2 : mode ? 1 : 0;
      w.mesh.userData.energized = network.energizedSpans.has(sp.id);
    }
  }

  setGhost(g: GhostState | null) {
    const n = g?.structures.length ?? 0;
    while (this.ghostMeshes.length < n) {
      const m = new THREE.Mesh(undefined, this.matGhostOk);
      m.userData.grow = 1;
      m.renderOrder = 5;
      this.ghostGroup.add(m);
      this.ghostMeshes.push(m);
    }
    this.ghostMeshes.forEach((m, i) => {
      m.visible = i < n;
      if (i < n && g) {
        const st = g.structures[i];
        m.geometry = getModel(st.defId, st.voltage).geometry;
        m.userData.st = st;
        m.material = g.valid[i] ? this.matGhostOk : this.matGhostBad;
        this.placeMesh(m, st);
      }
    });
    for (const w of this.ghostWires) {
      this.ghostGroup.remove(w);
      w.geometry.dispose();
      w.material.dispose();
    }
    this.ghostWires = [];
    for (const gs of g?.spans ?? []) {
      const layout = layoutSpan(gs.span, gs.A, gs.B);
      const mat = makeWireMaterial(gs.valid ? '#7dffb0' : '#ff5a4a');
      mat.uniforms.uState.value = 1;
      mat.uniforms.uLen.value = layout.length;
      mat.uniforms.uSel.value = gs.valid ? 0 : 2;
      const mesh = new THREE.Mesh(buildSpanGeometry(layout), mat);
      mesh.renderOrder = 6;
      this.placeWire(mesh, gs.A);
      this.ghostGroup.add(mesh);
      this.ghostWires.push(mesh);
    }
    this.map?.triggerRepaint();
  }

  // ------------------------------------------------------------------ picking

  pick(px: number, py: number, wantSpans = true): { kind: 'structure' | 'span'; id: string } | null {
    if (this.zoom < SHOW_3D_ZOOM) {
      // overview: pick nearest structure base
      let best: string | null = null;
      let bd = 10;
      for (const [id, s] of this.structs) {
        const p = this.project(s.mesh.position);
        if (!p) continue;
        const d = Math.hypot(p.x - px, p.y - py);
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      return best ? { kind: 'structure', id: best } : null;
    }
    let best: { kind: 'structure' | 'span'; id: string } | null = null;
    let bd = Infinity;
    const top = new THREE.Vector3();
    const side = new THREE.Vector3();
    for (const [id, s] of this.structs) {
      if (s.mesh.userData.grow <= 0) continue;
      const base = s.mesh.position;
      const k = s.mesh.scale.x;
      const pa = this.project(base);
      const pb = this.project(top.copy(base).setZ(base.z + s.height * k));
      if (!pa || !pb) continue;
      const r = getModel(s.st.defId, s.st.voltage).radius;
      const ps = this.project(side.copy(base).setX(base.x + r * 0.6 * k));
      const tol = Math.max(9, ps ? Math.hypot(ps.x - pa.x, ps.y - pa.y) : 0);
      const d = segDist(px, py, pa.x, pa.y, pb.x, pb.y);
      if (d < tol && d - tol < bd) {
        bd = d - tol;
        best = { kind: 'structure', id };
      }
    }
    if (best || !wantSpans) return best;
    bd = 7;
    const p = new THREE.Vector3();
    for (const [id, w] of this.wires) {
      const wire = w.layout.lowest ?? w.layout.wires[0];
      if (!wire) continue;
      const k = w.mesh.scale.x;
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        p.set(wire.a.x + (wire.b.x - wire.a.x) * t, wire.a.y + (wire.b.y - wire.a.y) * t, wireHeightAt(wire, t));
        p.multiplyScalar(k).add(w.mesh.position);
        const q = this.project(p);
        if (q && prev) {
          const d = segDist(px, py, prev.x, prev.y, q.x, q.y);
          if (d < bd) {
            bd = d;
            best = { kind: 'span', id };
          }
        }
        prev = q;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ shadows

  private updateCatcher(R: number) {
    const c = this.map.getCenter();
    const now = performance.now();
    const at = this.catcherAt;
    if (at && distanceM(at, c) < R * 0.2 && Math.abs(at.R - R) / R < 0.3 && now - at.t < 2500) return;
    const N = 48;
    const g = new THREE.PlaneGeometry(2 * R, 2 * R, N, N);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const ctr = this.worldOf(c);
    const k = mercScale(c.lat) / this.s0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      // inverse of worldOf for a small offset
      const lng = c.lng + ((x * k * this.s0) * 360);
      const my = mercY(c.lat) - y * k * this.s0;
      const lat = (360 / Math.PI) * Math.atan(Math.exp(((180 - my * 360) * Math.PI) / 180)) - 90;
      const e = this.map.queryTerrainElevation({ lng, lat }) ?? 0;
      pos.setXYZ(i, ctr.x + x * k, ctr.y + y * k, e + 0.4);
    }
    g.computeVertexNormals();
    this.catcher.geometry.dispose();
    this.catcher.geometry = g;
    this.catcherAt = { lng: c.lng, lat: c.lat, R, t: now };
  }

  // ------------------------------------------------------------------ render

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frames++;
    if (now - this.fpsT > 1000) {
      this.onFps?.(Math.round((this.frames * 1000) / (now - this.fpsT)));
      this.frames = 0;
      this.fpsT = now;
    }

    const store = useStore.getState();
    const env = store.env;
    const center = map.getCenter();
    const zoom = map.getZoom();
    this.zoom = zoom;
    if (distanceM(this.origin, center) > (zoom > 12 ? 2500 : 60000)) this.setOrigin({ lng: center.lng, lat: center.lat });
    if (this.dirty) {
      this.dirty = false;
      this.sync();
    }

    // world → clip
    // mainMatrix: float64 mercator (0..1, z in mercator units) → clip space
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    const ox = mercX(this.origin.lng);
    const oy = mercY(this.origin.lat);
    m.multiply(new THREE.Matrix4().makeTranslation(ox, oy, 0)).multiply(new THREE.Matrix4().makeScale(this.s0, -this.s0, this.s0));
    this.camera.projectionMatrix.copy(m);
    this.camera.projectionMatrixInverse.copy(m).invert();
    this.viewProj.copy(m);

    // environment
    const sun = SUN;
    const mpp = (40075016.686 * Math.cos(center.lat * D2R)) / (512 * Math.pow(2, zoom));
    wireShared.uTime.value = now / 1000;
    wireShared.uWind.value = env.wind * (env.rain ? 1.6 : 1);
    wireShared.uMinRad.value = mpp * 0.7;
    wireShared.uSunDir.value.copy(sun.dir);
    wireShared.uSunI.value = env.rain ? 0.5 : 1;
    wireShared.uAmb.value = 0.58;
    wireShared.uNight.value = 0;
    wireShared.uGlow.value = env.glow ? 1 : 0;
    wireShared.uFlow.value = env.flow ? 1 : 0;

    this.sun.color.set(0xffffff);
    this.sun.intensity = env.rain ? 1.05 : 2.55;
    this.hemi.intensity = 1.2;
    this.hemi.color.set(0xdfeeff);
    const glowPulse = 0.75 + 0.25 * Math.sin(now / 260);
    this.matGlowOn.color.setRGB(0.55 + 0.45 * glowPulse, 0.85 + 0.15 * glowPulse, 1);

    const show3D = zoom >= SHOW_3D_ZOOM;
    const centerW = this.worldOf(center);
    const shadowsOn = env.shadows && show3D && zoom >= 13 && !env.rain;
    this.renderer.shadowMap.enabled = shadowsOn;
    this.catcher.visible = shadowsOn;
    this.sun.castShadow = shadowsOn;
    if (shadowsOn) {
      const R = Math.min(5000, Math.max(250, mpp * 900));
      this.updateCatcher(R);
      const sc = this.sun.shadow.camera;
      sc.left = sc.bottom = -R;
      sc.right = sc.top = R;
      sc.near = 1;
      sc.far = R * 6;
      sc.updateProjectionMatrix();
      this.sun.target.position.copy(centerW);
      this.sun.position.copy(centerW).addScaledVector(sun.dir, R * 3);
      this.sun.target.updateMatrixWorld();
    } else {
      this.sun.position.copy(centerW).addScaledVector(sun.dir, 1000);
      this.sun.target.position.copy(centerW);
      this.sun.target.updateMatrixWorld();
    }

    // build / stringing animations (structures always use their full-detail model)
    let animating = false;
    for (const s of this.structs.values()) {
      s.mesh.visible = show3D;
      if (s.glow) s.glow.visible = show3D;
      const t = (now - s.st.builtAt) / BUILD_MS;
      const grow = t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3);
      if (grow !== s.mesh.userData.grow) {
        s.mesh.userData.grow = grow;
        s.mesh.visible = show3D && grow > 0;
        this.placeMesh(s.mesh, s.st, s.glow);
        if (s.glow) s.glow.visible = s.mesh.visible && grow >= 1;
        animating = true;
      }
    }
    for (const w of this.wires.values()) {
      w.mesh.visible = show3D;
      const u = w.mesh.material.uniforms;
      const t = (now - Math.max(w.span.builtAt, 0)) / STRING_MS;
      if (t < 1) {
        u.uState.value = 2;
        u.uProgress.value = Math.max(0, t);
        animating = true;
      } else {
        u.uState.value = w.mesh.userData.energized ? 1 : 0;
      }
    }
    if (this.demolitions.active) {
      const anchor = (lng: number, lat: number, elev: number, out: THREE.Vector3) => {
        this.worldOf({ lng, lat }, elev, out);
        return mercScale(lat) / this.s0;
      };
      if (this.demolitions.update(now, anchor, show3D)) animating = true;
    }
    this.ghostGroup.visible = show3D;

    // clouds: a high deck that fades as the camera comes down
    // Visible while "flying" between regional and local views; faded out at
    // country scale, where the cloud texture would read as noise.
    const cloudIn = Math.max(0, Math.min(1, (zoom - 7.5) / 1.5));
    const cloudOut = Math.max(0, Math.min(1, (12.8 - zoom) / 2.5));
    const cloudA = env.clouds ? cloudIn * cloudOut : 0;
    this.clouds.visible = cloudA > 0.01;
    if (this.clouds.visible) {
      const size = mpp * Math.max(map.getCanvas().clientWidth, map.getCanvas().clientHeight) * 4;
      this.clouds.position.set(centerW.x, centerW.y, 3200);
      this.clouds.scale.set(size, size, 1);
      const u = this.clouds.material.uniforms;
      u.uOpacity.value = cloudA * (env.rain ? 0.85 : 0.55);
      u.uCover.value = env.rain ? 0.32 : 0.52;
      u.uCol.value.setRGB(1, 1, 1).lerp(new THREE.Color(0x9aa3ad), env.rain ? 0.5 : 0);
      u.uOff.value.set(((mercX(this.origin.lng) / this.s0) % 90000), ((-mercY(this.origin.lat) / this.s0) % 90000));
    }

    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.render(this.scene, this.camera);

    // keep animating: wires, flow, clouds and time of day are always moving
    if (animating || this.wires.size > 0 || this.clouds.visible || this.structs.size > 0) map.triggerRepaint();
    void dt;
  }
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}
