import type { Map as MLMap } from 'maplibre-gl';
import type { Controller } from './controller';
import type { Navigation } from './navigation';
import type { SceneLayer } from './sceneLayer';

/** Live handles to the map systems, for UI code outside the React map component. */
export const runtime: { map?: MLMap; layer?: SceneLayer; ctrl?: Controller; nav?: Navigation } = {};
if (import.meta.env.DEV) (window as unknown as { __rt: typeof runtime }).__rt = runtime;

export type ViewMode = 'top' | 'iso' | 'ground';

export function setView(mode: ViewMode) {
  const map = runtime.map;
  if (!map) return;
  const z = map.getZoom();
  if (mode === 'top') map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
  if (mode === 'iso') map.easeTo({ pitch: 55, bearing: map.getBearing() || -30, zoom: Math.max(z, 13), duration: 900 });
  if (mode === 'ground') map.easeTo({ pitch: 82, zoom: Math.max(z, 16), duration: 1100 });
}

export function flyTo(lng: number, lat: number, zoom: number) {
  runtime.map?.flyTo({ center: [lng, lat], zoom, bearing: 0, pitch: 0, duration: 2500, essential: true });
}
