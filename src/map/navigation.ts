import type { Map as MLMap, MapMouseEvent, LngLat } from 'maplibre-gl';
import { DEF_BY_ID } from '../catalog/structures';
import { distanceM, PH_VIEW_BOUNDS } from '../core/geo';
import { useHud, useStore } from '../core/store';
import type { SceneLayer } from './sceneLayer';

// Camera navigation, modelled on the Laguna Floating TL Map (Cesium) and adapted
// to MapLibre, plus a few Google Earth extras:
//
//   Left-drag                         pan
//   Right-drag                        zoom (drag down = closer), toward the press point
//   Middle-drag, Ctrl/Shift+left-drag rotate + tilt about the screen centre
//   Wheel                             zoom toward the cursor
//   Double-click a structure / span   eased fly-in, then a slow orbit (Select tool)
//   Esc                               leave that view: fly back to where you were
//   R                                 north-up, top-down over the current spot (App.tsx)
//
// Any click, drag, scroll or camera command stops the orbit.
// Keyboard navigation lives in App.tsx and calls `keyboardStep` every frame.

const DEG_PER_PX_ROTATE = 0.35;
const DEG_PER_PX_TILT = 0.3;
const ZOOM_PER_PX = 0.012;
/** Orbit speed, as in the Laguna map (about 3.5° per second). */
const ORBIT_DEG_PER_S = 3.5;
/** Camera pitch for fly-ins and the oblique view (Cesium's −35° looking down). */
export const OBLIQUE_PITCH = 55;

type DragMode = 'tilt' | 'zoom';

interface SavedView {
  center: LngLat;
  zoom: number;
  bearing: number;
  pitch: number;
}

export class Navigation {
  private drag: { mode: DragMode; x: number; y: number; anchor?: LngLat; panOff: boolean } | null = null;
  private orbitRaf = 0;
  private flight = 0;
  /** The view before the first fly-in, so Esc can return to it. */
  private returnView: SavedView | null = null;
  private removeDom: () => void;
  private unsub: () => void;

  constructor(private map: MLMap, private layer: SceneLayer) {
    // Right-drag and Ctrl+drag are handled here instead of by MapLibre, and
    // Shift+drag is used for rotating, so MapLibre's shift box-zoom is off.
    map.dragRotate.disable();
    map.boxZoom.disable();

    const el = map.getCanvasContainer();
    const down = (e: MouseEvent) => {
      // Runs in the capture phase, before MapLibre decides to start a pan.
      this.interrupt();
      let mode: DragMode | null = null;
      if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.shiftKey))) mode = 'tilt';
      else if (e.button === 2) mode = 'zoom';
      if (!mode) return;
      const panOff = e.button === 0;
      if (panOff) map.dragPan.disable();
      const r = el.getBoundingClientRect();
      this.drag = {
        mode, x: e.clientX, y: e.clientY, panOff,
        anchor: mode === 'zoom' ? map.unproject([e.clientX - r.left, e.clientY - r.top]) : undefined,
      };
      if (mode === 'tilt') el.style.cursor = 'grabbing';
      if (e.button === 1) e.preventDefault(); // no browser auto-scroll
    };
    const move = (e: MouseEvent) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.mode === 'tilt') {
        map.jumpTo({
          bearing: map.getBearing() + dx * DEG_PER_PX_ROTATE,
          pitch: clamp(map.getPitch() - dy * DEG_PER_PX_TILT, 0, map.getMaxPitch()),
        });
      } else {
        const zoom = clamp(map.getZoom() + dy * ZOOM_PER_PX, map.getMinZoom(), map.getMaxZoom());
        map.easeTo({ zoom, around: d.anchor, duration: 0 });
      }
    };
    const up = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.panOff) map.dragPan.enable();
      el.style.cursor = '';
    };
    const stopOnInput = () => this.interrupt();
    el.addEventListener('mousedown', down, true);
    el.addEventListener('wheel', stopOnInput, { capture: true, passive: true });
    el.addEventListener('touchstart', stopOnInput, { capture: true, passive: true });
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    this.removeDom = () => {
      el.removeEventListener('mousedown', down, true);
      el.removeEventListener('wheel', stopOnInput, true);
      el.removeEventListener('touchstart', stopOnInput, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('blur', up);
    };

    // Double-click zoom only in the Select tool, so fast clicking while
    // building doesn't throw the camera around.
    const syncDblClick = () => {
      if (useStore.getState().tool === 'select') map.doubleClickZoom.enable();
      else map.doubleClickZoom.disable();
    };
    syncDblClick();
    this.unsub = useStore.subscribe((s, p) => {
      if (s.tool !== p.tool) syncDblClick();
      if (s.env.orbit !== p.env.orbit && !s.env.orbit) this.stopOrbit();
    });
    map.on('dblclick', this.onDblClick);
  }

  dispose() {
    this.stopOrbit();
    this.removeDom();
    this.unsub();
    this.map.off('dblclick', this.onDblClick);
  }

  // ------------------------------------------------------------------ fly-in + orbit

  /** Double-click a structure or span to fly in and orbit it. */
  private onDblClick = (e: MapMouseEvent) => {
    const s = useStore.getState();
    if (s.tool !== 'select') return;
    const hit = this.layer.pick(e.point.x, e.point.y, true);
    if (!hit) return;
    let target: { lng: number; lat: number } | null = null;
    let range = 450;
    if (hit.kind === 'structure') {
      const st = s.structures[hit.id];
      if (!st) return;
      target = st;
      range = DEF_BY_ID[st.defId].role === 'line' ? 450 : 650;
    } else {
      const sp = s.spans[hit.id];
      const A = sp && s.structures[sp.a];
      const B = sp && s.structures[sp.b];
      if (!A || !B) return;
      target = { lng: (A.lng + B.lng) / 2, lat: (A.lat + B.lat) / 2 };
      range = Math.max(500, distanceM(A, B) * 2.2);
    }
    e.preventDefault();
    s.set({ selected: hit });
    // Start after MapLibre finishes handling this event, which would otherwise
    // stop a camera animation begun inside the handler.
    const t = target;
    setTimeout(() => this.flyIn(t, range), 0);
  };

  flyIn(target: { lng: number; lat: number }, range: number) {
    const map = this.map;
    this.stopOrbit();
    if (!this.returnView) {
      this.returnView = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    }
    const id = ++this.flight;
    const zoom = zoomForRange(map, target.lat, range);
    map.flyTo({ center: [target.lng, target.lat], zoom, pitch: OBLIQUE_PITCH, bearing: map.getBearing(), duration: 2000, essential: true });
    map.once('moveend', () => {
      if (id !== this.flight || !useStore.getState().env.orbit) return;
      // Only orbit if the flight actually arrived (wasn't cut short by another command).
      const c = map.getCenter();
      if (distanceM({ lng: c.lng, lat: c.lat }, target) > 15 || Math.abs(map.getZoom() - zoom) > 0.05) return;
      this.startOrbit();
    });
  }

  private startOrbit() {
    const map = this.map;
    let last = performance.now();
    useHud.setState({ orbiting: true });
    const step = (now: number) => {
      // Another camera animation (a button, R, search…) takes over.
      if (map.isEasing()) return this.stopOrbit();
      map.setBearing(map.getBearing() + ((now - last) / 1000) * ORBIT_DEG_PER_S);
      last = now;
      this.orbitRaf = requestAnimationFrame(step);
    };
    this.orbitRaf = requestAnimationFrame(step);
  }

  stopOrbit() {
    if (this.orbitRaf) cancelAnimationFrame(this.orbitRaf);
    this.orbitRaf = 0;
    if (useHud.getState().orbiting) useHud.setState({ orbiting: false });
  }

  /** The user touched the camera: stop orbiting and cancel any pending orbit. */
  interrupt() {
    this.flight++;
    this.stopOrbit();
  }

  /** True while there's a fly-in view that Esc can leave. */
  get canExitView() {
    return !!this.returnView;
  }

  /** Esc: stop orbiting, clear the selection and fly back to the view you came from. */
  exitView() {
    this.interrupt();
    const back = this.returnView;
    this.returnView = null;
    if (back) this.map.flyTo({ ...back, duration: 1400, essential: true });
    useStore.getState().set({ selected: null });
  }

  /** Forget the fly-in return point (R and ⌂ start fresh, as in the Laguna map). */
  forgetReturn() {
    this.interrupt();
    this.returnView = null;
  }

  // ------------------------------------------------------------------ keyboard

  /**
   * Apply one frame of held-key movement.
   * pan: screen pixels; rotate: degrees; tilt: degrees; zoom: zoom levels.
   */
  keyboardStep(pan: [number, number], rotate: number, tilt: number, zoom: number) {
    const map = this.map;
    this.interrupt();
    if (pan[0] || pan[1]) map.panBy(pan, { duration: 0 });
    if (rotate || tilt || zoom) {
      map.jumpTo({
        bearing: map.getBearing() + rotate,
        pitch: clamp(map.getPitch() + tilt, 0, map.getMaxPitch()),
        zoom: clamp(map.getZoom() + zoom, map.getMinZoom(), map.getMaxZoom()),
      });
    }
  }
}

// ------------------------------------------------------------------ camera helpers

/** The default view: facing north and looking straight down. */
export const DEFAULT_VIEW = { bearing: 0, pitch: 0 };

/**
 * Return to the default view (north-up, top-down) over the spot currently in
 * the middle of the screen, keeping the zoom level. Bound to R.
 */
export function resetView(map: MLMap) {
  map.easeTo({ ...DEFAULT_VIEW, duration: 700, essential: true });
}

export function northUp(map: MLMap) {
  map.easeTo({ bearing: 0, duration: 600 });
}

export function resetTilt(map: MLMap) {
  map.easeTo({ pitch: 0, duration: 600 });
}

/** Top-down ↔ oblique view about the screen centre, keeping the heading. */
export function toggle3D(map: MLMap) {
  map.easeTo({ pitch: map.getPitch() > 5 ? 0 : OBLIQUE_PITCH, duration: 800 });
}

/** ⌂: fit the whole network you've built (or the whole country if it's empty). */
export function flyHome(map: MLMap) {
  const pts = Object.values(useStore.getState().structures);
  if (!pts.length) {
    const cam = map.cameraForBounds(PH_VIEW_BOUNDS, { padding: 40 });
    map.flyTo({ ...cam, ...DEFAULT_VIEW, duration: 2500, essential: true });
    return;
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) {
    w = Math.min(w, p.lng); e = Math.max(e, p.lng);
    s = Math.min(s, p.lat); n = Math.max(n, p.lat);
  }
  const cam = map.cameraForBounds([[w, s], [e, n]], { padding: 90, maxZoom: 15, bearing: 0 });
  if (cam) map.flyTo({ ...cam, ...DEFAULT_VIEW, duration: 1600, essential: true });
}

export function flyToBounds(map: MLMap, west: number, south: number, east: number, north: number) {
  const cam = map.cameraForBounds([[west, south], [east, north]], { padding: 90, maxZoom: 16, bearing: 0 });
  if (!cam) return;
  map.flyTo({ ...cam, ...DEFAULT_VIEW, duration: 2600, essential: true });
}

function fovRad(map: MLMap) {
  return ((map.transform as unknown as { fov?: number }).fov ?? 36.87) * (Math.PI / 180);
}

/** Zoom level that puts the camera `range` metres from the target. */
function zoomForRange(map: MLMap, lat: number, range: number) {
  const half = map.getCanvas().clientHeight / 2;
  const mpp = (range * Math.tan(fovRad(map) / 2)) / half;
  const z = Math.log2((40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * mpp));
  return clamp(z, map.getMinZoom(), map.getMaxZoom());
}

/** Approximate camera height above sea level, like Google Earth's "eye altitude". */
export function eyeAltitude(map: MLMap): number {
  const c = map.getCenter();
  const zoom = map.getZoom();
  const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
  const dist = (map.getCanvas().clientHeight / 2 / Math.tan(fovRad(map) / 2)) * mpp;
  const ground = map.queryTerrainElevation(c) ?? 0;
  return dist * Math.cos((map.getPitch() * Math.PI) / 180) + ground;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
