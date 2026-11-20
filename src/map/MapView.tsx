import { useEffect, useRef } from 'react';
import maplibregl, { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DEF_BY_ID } from '../catalog/structures';
import { VOLTAGES } from '../catalog/voltages';
import { PH_MAX_BOUNDS, PH_POLY, PH_VIEW_BOUNDS } from '../core/geo';
import { useHud, useStore } from '../core/store';
import { Controller } from './controller';
import { skyColors, SUN } from './environment';
import { eyeAltitude, Navigation } from './navigation';
import { runtime } from './runtime';
import { SceneLayer } from './sceneLayer';

const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const style: StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: 'raster', tileSize: 256, maxzoom: 18,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    streets: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      attribution: '© OpenStreetMap contributors',
    },
    topo: {
      type: 'raster', tileSize: 256, maxzoom: 17,
      tiles: ['https://a.tile.opentopomap.org/{z}/{x}/{y}.png', 'https://b.tile.opentopomap.org/{z}/{x}/{y}.png'],
      attribution: '© OpenTopoMap (CC-BY-SA)',
    },
    labels: {
      type: 'raster', tileSize: 256, maxzoom: 18,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    },
    dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 15, encoding: 'terrarium', attribution: 'Terrain: Mapzen / AWS Terrain Tiles' },
    demHs: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 14, encoding: 'terrarium' },
    mask: {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {},
        geometry: { type: 'Polygon', coordinates: [[[100, -10], [145, -10], [145, 35], [100, 35], [100, -10]], [...PH_POLY, PH_POLY[0]]] },
      },
    },
    ovLines: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    ovPoints: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0c2236' } },
    { id: 'sat', type: 'raster', source: 'sat' },
    { id: 'streets', type: 'raster', source: 'streets', layout: { visibility: 'none' } },
    { id: 'topo', type: 'raster', source: 'topo', layout: { visibility: 'none' } },
    {
      id: 'hillshade', type: 'hillshade', source: 'demHs',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0b1a10', 'hillshade-highlight-color': '#fff6dc' },
    },
    { id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#040b14', 'fill-opacity': 0.38 } },
    { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.9 } },
    {
      id: 'ov-glow', type: 'line', source: 'ovLines', filter: ['==', ['get', 'on'], true],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'], 'line-blur': 4,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 4, 11, 9],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.55, 11, 0.4, 12.5, 0],
      },
    },
    {
      id: 'ov-lines', type: 'line', source: 'ovLines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['case', ['get', 'on'], ['get', 'color'], '#8a929b'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.4, 11, 3],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 1, 11, 0.9, 12.5, 0],
      },
    },
    {
      id: 'ov-points', type: 'circle', source: 'ovPoints',
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['case', ['get', 'station'], 4, 1], 11, ['case', ['get', 'station'], 9, 3]],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case', ['get', 'station'], 1.5, 0],
        'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 12, 0],
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 10, 1, 12, 0],
      },
    },
  ],
};

function overview() {
  const { structures, spans, network } = useStore.getState();
  const lines = Object.values(spans).flatMap((sp) => {
    const A = structures[sp.a];
    const B = structures[sp.b];
    if (!A || !B) return [];
    return [{
      type: 'Feature' as const,
      properties: { color: VOLTAGES[sp.voltage].color, on: network.energizedSpans.has(sp.id) },
      geometry: { type: 'LineString' as const, coordinates: [[A.lng, A.lat], [B.lng, B.lat]] },
    }];
  });
  const points = Object.values(structures).map((s) => {
    const d = DEF_BY_ID[s.defId];
    const station = d.role !== 'line';
    return {
      type: 'Feature' as const,
      properties: { station, color: station ? (d.role === 'source' ? '#ffd23d' : '#ffffff') : VOLTAGES[s.voltage].color },
      geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
    };
  });
  return { lines: { type: 'FeatureCollection' as const, features: lines }, points: { type: 'FeatureCollection' as const, features: points } };
}

export function MapView() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style,
      bounds: PH_VIEW_BOUNDS,
      maxBounds: PH_MAX_BOUNDS,
      minZoom: 4.5,
      maxZoom: 18.5,
      maxPitch: 85,
      pitch: 0,
      bearing: 0,
      attributionControl: { compact: true },
      canvasContextAttributes: { antialias: true },
    });
    runtime.map = map;
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.keyboard.disable();

    const layer = new SceneLayer();
    layer.onFps = (fps) => useHud.setState({ fps });
    runtime.layer = layer;

    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');

    let ctrl: Controller | undefined;
    let nav: Navigation | undefined;
    let ovTimer: number | undefined;
    const pushOverview = () => {
      window.clearTimeout(ovTimer);
      ovTimer = window.setTimeout(() => {
        const o = overview();
        (map.getSource('ovLines') as GeoJSONSource | undefined)?.setData(o.lines);
        (map.getSource('ovPoints') as GeoJSONSource | undefined)?.setData(o.points);
      }, 120);
    };

    let lastEnv = '';
    const applyEnv = () => {
      if (!map.isStyleLoaded()) return;
      const env = useStore.getState().env;
      const key = `${env.rain}|${env.basemap}|${env.labels}|${env.exaggeration}`;
      if (key === lastEnv) return;
      const prev = lastEnv.split('|');
      lastEnv = key;
      const c = skyColors(env.rain);
      map.setSky({
        'sky-color': c.sky, 'horizon-color': c.horizon, 'fog-color': c.fog,
        'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 8, 0.6, 12, 0],
      });
      for (const id of ['sat', 'streets', 'topo']) {
        const want = env.basemap === 'satellite' ? 'sat' : env.basemap;
        map.setLayoutProperty(id, 'visibility', want === id ? 'visible' : 'none');
        map.setPaintProperty(id, 'raster-brightness-max', env.rain ? 0.7 : 1);
        map.setPaintProperty(id, 'raster-saturation', env.rain ? -0.25 : 0);
      }
      map.setLayoutProperty('labels', 'visibility', env.labels ? 'visible' : 'none');
      map.setPaintProperty('hillshade', 'hillshade-illumination-direction', SUN.azimuth);
      map.setPaintProperty('hillshade', 'hillshade-exaggeration', 0.45);
      if (prev[3] !== String(env.exaggeration)) map.setTerrain({ source: 'dem', exaggeration: env.exaggeration });
    };

    map.on('load', () => {
      map.setTerrain({ source: 'dem', exaggeration: useStore.getState().env.exaggeration });
      map.addLayer(layer);
      ctrl = new Controller(map, layer);
      runtime.ctrl = ctrl;
      nav = new Navigation(map, layer);
      runtime.nav = nav;
      pushOverview();
      applyEnv();
    });
    let camRaf = 0;
    const updateCamera = () => {
      if (camRaf) return;
      camRaf = requestAnimationFrame(() => {
        camRaf = 0;
        useHud.setState({ zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), alt: eyeAltitude(map) });
      });
    };
    map.on('move', updateCamera);
    map.on('load', updateCamera);

    const unsub = useStore.subscribe((s, p) => {
      if (s.spans !== p.spans || s.structures !== p.structures || s.network !== p.network) pushOverview();
      if (s.env !== p.env) applyEnv();
    });

    return () => {
      unsub();
      window.clearTimeout(ovTimer);
      cancelAnimationFrame(camRaf);
      nav?.dispose();
      ctrl?.dispose();
      map.remove();
      runtime.map = undefined;
      runtime.layer = undefined;
      runtime.ctrl = undefined;
      runtime.nav = undefined;
    };
  }, []);

  return <div ref={el} className="map" />;
}
