# PH Grid Builder — Philippine Power Grid Simulator (prototype)

A browser-based 3D sandbox for building electrical transmission lines on real
Philippine terrain. You place towers, string sagging three-phase conductors and
energise the grid from power plants. The construction workflow is
city-builder style.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production bundle in dist/
```

On Windows you can also double-click `Start PH Grid Builder.bat`. See
[HOW TO RUN.md](HOW%20TO%20RUN.md) for a full walkthrough.

## Deploy

The included `Dockerfile` builds the site and serves it with nginx on port 80.
It is ready for Northflank or any Docker host:

```bash
docker build -t ph-grid-builder .
docker run -p 8080:80 ph-grid-builder   # http://localhost:8080
```

Step-by-step GitHub + Northflank instructions are in [DEPLOY.md](DEPLOY.md).

## Technical plan

| Concern | Choice | Why |
|---|---|---|
| Map + terrain | **MapLibre GL JS 5** with `raster-dem` terrain | Free, open; streams tiles at every zoom (LOD for terrain is built in) |
| Elevation data | AWS / Mapzen **Terrarium** tiles (z ≤ 15, includes bathymetry) | Global, keyless; the sign of the elevation tells land from sea |
| Basemaps | Esri World Imagery (satellite), OpenStreetMap, OpenTopoMap + Esri labels | Switchable in Settings |
| 3D | **Three.js** rendered *inside* MapLibre's WebGL context as a custom layer | Shares the depth buffer, so towers are occluded by hills correctly |
| UI | **React 18 + TypeScript**, **Zustand** store | Plain React for HUD panels; the 3D layer subscribes to the store directly (no React re-render per frame) |
| Models | Procedural geometry (no external assets) | Every voltage class gets correctly proportioned towers; one merged, vertex-coloured mesh per model = 1 draw call |

React Three Fiber was considered. It doesn't fit, because the scene has to
live inside MapLibre's render loop and use its camera matrix. A plain
Three.js custom layer is simpler and faster there.

### Precision

The scene uses a **floating origin** near the camera, in metres
(x = east, y = north, z = up). Each frame, MapLibre's float64 mercator→clip
matrix is multiplied by `translate(origin) · scale(metre→mercator)` and used as
the projection. This keeps geometry jitter-free at street zoom anywhere in the
country.

## Architecture (the seven systems)

```
src/
  core/geo.ts               map bounds, PH territory polygon, mercator/ENU maths
  core/store.ts             game state, placement & link rules, auto-orientation, save/load, demo
  catalog/voltages.ts       69/115/138/230/500 kV (+13.8 kV) classes: clearances, bundles, spans, catenary
  catalog/structures.ts     structure registry → add a tower type by adding one entry
  models/builder.ts         procedural kit: lattice bodies, crossarms, insulators, gantries
  conductors/catenary.ts    true catenary maths (sag, low point, wire length)
  conductors/spanWires.ts   attachment matching (circuits, phases, bundles, OPGW) + tube geometry
  conductors/wireMaterial.ts shader: wind sway, energised glow, power-flow pulses, stringing animation
  network/connectivity.ts   graph search: energised islands, MW served, circuit-km, angle checks
  map/MapView.tsx           map, terrain, sky/fog, day–night styling, 2D overview layers
  map/sceneLayer.ts         Three.js layer: meshes, LOD, shadows, clouds, picking
  map/controller.ts         tools: build / connect / auto-route / move / bulldoze, ghosts, validation
  ui/                       toolbar, info panels, settings, welcome, rain overlay
```

## What's in this prototype

**Phase 1 — environment:** 3D terrain over the whole country, camera locked
to the Philippines, top / isometric / ground-level views, region jump list,
satellite/streets/topo basemaps, terrain exaggeration.

**Phase 2 — placement:** 12 structure types: DC/SC suspension, angle, DC/SC
dead-end, special crossing (aviation-banded), steel poles SC/DC, a 13.8 kV
distribution pole, a substation, a thermal plant and a solar farm. Each has a
ghost preview that turns green or red with a reason, R to rotate, and checks for
territory, water and spacing. You can move a structure (wires update live) and
bulldoze it.

**Phase 3 — conductors:** stringing between towers is automatic while you
place them, and you can also string between existing structures. Spans follow
a real catenary with an elevation difference. Phases are matched to keep circuits
from crossing. Lines can be 1 or 2 circuits, with 1, 2 or 4-conductor bundles per
phase and 1 or 2 OPGW/ground wires. Strain towers get jumper loops. Substation
bays are allocated to the nearest free bay. Span length is limited by voltage and
structure type. A ground-clearance check runs per span. Crossarms orient to the
line automatically (they bisect the angle at a turn). The **Auto Route** tool
places towers at the ruling span between two clicks.

**Phase 4 — animation:** construction rise and conductor-stringing
animations, wind sway with gusts, glow and moving power-flow pulses on
energised lines, a day–night cycle that drives the sun, sky and basemap
brightness, dynamic shadows on the terrain, a drifting cloud deck, and rain
with lightning flashes.

**Phase 5 — network:** generation (solar output follows the sun), substation
load, energised and de-energised states, circuit-km per voltage, and a
line-angle compliance warning.

**Phase 6 — performance:** shared cached geometry per (type, voltage). Towers
switch to a silhouette LOD when small on screen. Below zoom 10.3 the 3D layer is
replaced by a 2D overview. Conductor geometry is rebuilt only when an end
changes. Wind and flow animation run in the GPU shader.

## Next steps
- Glb import for custom tower models (the registry already takes any geometry builder)
- Load-flow lite (line ratings, overload colouring), N-1 outage toggling
- Real NGCP corridor/substation reference layer
- Instanced rendering for very large networks; code-splitting the bundle
