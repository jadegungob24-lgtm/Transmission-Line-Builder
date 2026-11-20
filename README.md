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
  map/MapView.tsx           map, terrain, sky/fog, weather styling, 2D overview layers
  map/navigation.ts         Google Earth–style camera: shift-drag orbit, fly-to, keyboard, eye altitude
  map/sceneLayer.ts         Three.js layer: meshes, LOD, shadows, clouds, picking
  map/controller.ts         tools: build / connect / auto-route / move / bulldoze, ghosts, validation
  ui/                       toolbar, info panels, settings, welcome, rain overlay
```

## What's in this prototype

**Phase 1 — environment:** 3D terrain over the whole country, camera locked
to the Philippines, top / isometric / ground-level views,
satellite/streets/topo basemaps, terrain exaggeration. The camera navigates like
the Laguna Floating TL Map (Cesium-style): right-drag zoom, middle/Ctrl/Shift-drag
tilt and rotate, double-click fly-in with a slow orbit, Esc to return, and R to reset
to north-up top-down. Google Earth extras: a draggable compass, a 2D/3D toggle,
place search (OpenStreetMap Nominatim, Philippines only, or typed coordinates),
keyboard flight, and an eye-altitude status bar with a scale bar.

**Phase 2 — placement:** 12 structure types: DC/SC suspension, angle, DC/SC
dead-end, special crossing (aviation-banded), steel poles SC/DC, a 13.8 kV
distribution pole, a substation, a thermal plant and a solar farm. Each has a
ghost preview that turns green or red with a reason, T to rotate, and checks for
territory, water and spacing. You can move a structure (wires update live, and the
info panel shows its PRS92 coordinates changing) or type PRS92 coordinates to put it
at an exact spot, and bulldoze it with a topple/collapse animation.
Each tower or pole's **insulator length** can be adjusted in its info panel
(− / +, or type a value; the crossarms stay fixed, so longer strings hang the
conductors lower and the sag/clearance update). **Straighten section** lines up the suspension towers between two angle/dead-end
towers on a straight, evenly spaced path (with Undo).

**Names & confirmed edits:** structures can be renamed (info panel ✎, or ✎ in the
schedule; names must be unique and show up in exports, pins and drawings; empty =
automatic number). Changes made from a structure's info panel (move, rotate,
insulator, coordinates, name, straighten) show live but stay unsaved until
**Save** (or Enter); **Cancel**, closing the panel or selecting something else
puts everything back, and unsaved changes are never autosaved.

**Multi-select:** Ctrl+click structures (on the map or in the schedule) to select
several, then rotate, set insulator length, auto-orient or demolish them together.

**Plan & profile:** from any tower, pole or span, a drawing of the whole line:
ground profile, every structure, the sagging lowest conductor and earth wire of
each span, the clearance target (spans below it in red), chainage, and a
straightened plan strip with deflection angles and span lengths. Hover for
elevations and clearance, click a structure to select it, download as SVG.

**Projects & tower schedule:** each project is its own network, saved in the
browser (new / open / rename / delete from the top bar). Every structure gets a
number in the order it is plotted (T-001, SS-002 …). The tower schedule lists them
live with PRS92 zone, northing/easting, lat/lng, elevation, height, heading, line
angle and connections, and exports to Excel (.xlsx, with a Spans sheet) or to
Google Earth (.kmz: a pin per structure with its details, plus the lines).

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
energised lines, a fixed late-morning sun with dynamic shadows on the
terrain, a drifting cloud deck, and rain with lightning flashes.

**Phase 5 — network:** generation (solar output drops under rain), substation
load, energised and de-energised states, circuit-km per voltage, and a
line-angle compliance warning.

**Phase 6 — performance:** shared cached geometry per (type, voltage), always
drawn at full detail. Shadows are re-rendered only when something changes, and the
terrain shadow catcher is rebuilt only once the camera settles. Below zoom 10.3 the
3D layer is replaced by a 2D overview. Conductor geometry is rebuilt only when an end
changes. Wind and flow animation run in the GPU shader.

## Next steps
- Glb import for custom tower models (the registry already takes any geometry builder)
- Load-flow lite (line ratings, overload colouring), N-1 outage toggling
- Real NGCP corridor/substation reference layer
- Instanced rendering for very large networks; code-splitting the bundle
