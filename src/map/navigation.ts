import type { Map as MLMap, MapMouseEvent } from 'maplibre-gl';
import { PH_VIEW_BOUNDS } from '../core/geo';
import { useStore } from '../core/store';
import type { SceneLayer } from './sceneLayer';

// Google Earth–style navigation layered on top of MapLibre's defaults:
//
//   Left-drag            pan (grab the ground)            — MapLibre
//   Right-drag           rotate + tilt                      — MapLibre
//   Ctrl + left-drag     rotate + tilt                      — MapLibre
//   Shift + left-drag    rotate + tilt (Google Earth)       — here
//   Middle-drag          pan                                — controller.ts
//   Wheel                zoom toward the cursor             — MapLibre
//   Double-click         zoom in at the point, or fly to a structure (Select tool)
//
// Keyboard navigation lives in App.tsx and calls `keyboardStep` every frame.

const DEG_PER_PX_ROTATE = 0.35;
const DEG_PER_PX_TILT = 0.3;

export class Navigation {
  private orbit: { x: number; y: number } | null = null;
  private removeDom: () => void;
  private unsub: () => void;

  constructor(private map: MLMap, private layer: SceneLayer) {
    // Shift+drag is used for orbiting, so MapLibre's shift box-zoom is turned off.
    map.boxZoom.disable();

    const el = map.getCanvasContainer();
    const down = (e: MouseEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      // Runs in the capture phase, before MapLibre decides to start a pan.
      map.dragPan.disable();
      this.orbit = { x: e.clientX, y: e.clientY };
      el.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const move = (e: MouseEvent) => {
      if (!this.orbit) return;
      const dx = e.clientX - this.orbit.x;
      const dy = e.clientY - this.orbit.y;
      this.orbit = { x: e.clientX, y: e.clientY };
      map.jumpTo({
        bearing: map.getBearing() + dx * DEG_PER_PX_ROTATE,
        pitch: clamp(map.getPitch() - dy * DEG_PER_PX_TILT, 0, map.getMaxPitch()),
      });
    };
    const up = () => {
      if (!this.orbit) return;
      this.orbit = null;
      map.dragPan.enable();
      el.style.cursor = '';
    };
    el.addEventListener('mousedown', down, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    window.addEventListener('blur', up);
    this.removeDom = () => {
      el.removeEventListener('mousedown', down, true);
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
    });
    map.on('dblclick', this.onDblClick);
  }

  dispose() {
    this.removeDom();
    this.unsub();
    this.map.off('dblclick', this.onDblClick);
  }

  /** Double-click a structure to fly to it, like a placemark in Google Earth. */
  private onDblClick = (e: MapMouseEvent) => {
    const s = useStore.getState();
    if (s.tool !== 'select') return;
    const hit = this.layer.pick(e.point.x, e.point.y, false);
    const st = hit?.kind === 'structure' ? s.structures[hit.id] : null;
    if (!st) return;
    e.preventDefault();
    // Start after MapLibre finishes handling this event, which would otherwise
    // stop a camera animation begun inside the handler.
    setTimeout(() => {
      this.map.flyTo({
        center: [st.lng, st.lat],
        zoom: Math.max(this.map.getZoom(), 17.2),
        pitch: Math.max(this.map.getPitch(), 62),
        duration: 1600,
        essential: true,
      });
    }, 0);
  };

  /**
   * Apply one frame of held-key movement.
   * pan: screen pixels; rotate: degrees; tilt: degrees; zoom: zoom levels.
   */
  keyboardStep(pan: [number, number], rotate: number, tilt: number, zoom: number) {
    const map = this.map;
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

export function toggle3D(map: MLMap) {
  map.easeTo({ pitch: map.getPitch() > 5 ? 0 : 60, duration: 800 });
}

export function flyHome(map: MLMap) {
  const cam = map.cameraForBounds(PH_VIEW_BOUNDS, { padding: 40 });
  map.flyTo({ ...cam, ...DEFAULT_VIEW, duration: 2500, essential: true });
}

export function flyToBounds(map: MLMap, west: number, south: number, east: number, north: number) {
  const cam = map.cameraForBounds([[west, south], [east, north]], { padding: 90, maxZoom: 16, bearing: 0 });
  if (!cam) return;
  map.flyTo({ ...cam, ...DEFAULT_VIEW, duration: 2600, essential: true });
}

/** Approximate camera height above sea level, like Google Earth's "eye altitude". */
export function eyeAltitude(map: MLMap): number {
  const c = map.getCenter();
  const zoom = map.getZoom();
  const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * Math.pow(2, zoom));
  const fov = ((map.transform as unknown as { fov?: number }).fov ?? 36.87) * (Math.PI / 180);
  const dist = (map.getCanvas().clientHeight / 2 / Math.tan(fov / 2)) * mpp;
  const ground = map.queryTerrainElevation(c) ?? 0;
  return dist * Math.cos((map.getPitch() * Math.PI) / 180) + ground;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
