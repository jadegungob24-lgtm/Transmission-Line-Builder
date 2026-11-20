import { useRef } from 'react';
import { useHud } from '../core/store';
import { flyHome, northUp, resetView, toggle3D } from '../map/navigation';
import { runtime } from '../map/runtime';

// Google Earth–style camera control: a compass ring you can drag to rotate the
// view (click to face north), a 2D/3D tilt toggle, zoom buttons and "home".

export function NavWidget() {
  const bearing = useHud((h) => h.bearing);
  const pitch = useHud((h) => h.pitch);
  const drag = useRef<{ startAngle: number; startBearing: number; moved: boolean } | null>(null);
  const ring = useRef<HTMLDivElement>(null);

  const angleAt = (e: React.PointerEvent) => {
    const r = ring.current!.getBoundingClientRect();
    return (Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180) / Math.PI;
  };

  const onDown = (e: React.PointerEvent) => {
    const map = runtime.map;
    if (!map) return;
    e.preventDefault();
    runtime.nav?.interrupt();
    drag.current = { startAngle: angleAt(e), startBearing: map.getBearing(), moved: false };
    try {
      ring.current!.setPointerCapture(e.pointerId);
    } catch {
      /* some pointer sources can't be captured; dragging still works while over the ring */
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const map = runtime.map;
    if (!d || !map) return;
    let delta = angleAt(e) - d.startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) > 2) d.moved = true;
    if (d.moved) map.setBearing(d.startBearing - delta);
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && runtime.map) northUp(runtime.map);
  };

  const is3D = pitch > 5;
  const zoom = (dir: 1 | -1) => {
    const map = runtime.map;
    if (map) (dir > 0 ? map.zoomIn : map.zoomOut).call(map, { duration: 300 });
  };

  return (
    <>
    <OrbitHint />
    <div className="navw">
      <div
        ref={ring}
        className="compass"
        title="Drag to rotate · click to face north (N)"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <svg viewBox="0 0 64 64" style={{ transform: `rotate(${-bearing}deg)` }}>
          <circle cx="32" cy="32" r="29" className="ring" />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} x1="32" y1="5" x2="32" y2={i % 3 === 0 ? 10 : 8} className="tick" transform={`rotate(${i * 30} 32 32)`} />
          ))}
          <path d="M32 12 L37 32 L27 32 Z" className="needle-n" />
          <path d="M32 52 L37 32 L27 32 Z" className="needle-s" />
          <text x="32" y="22.5" className="n-label">N</text>
        </svg>
      </div>
      <div className="navw-col panel">
        <button onClick={() => runtime.map && toggle3D(runtime.map)} title={is3D ? 'Switch to top-down view (U)' : 'Switch to oblique 3D view'}>
          <b>{is3D ? '3D' : '2D'}</b>
        </button>
        <button onClick={() => { runtime.nav?.forgetReturn(); if (runtime.map) resetView(runtime.map); }} title="Reset view: face north and look straight down here (R)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.5 12 A7.5 7.5 0 1 0 7 6.4" />
            <path d="M3.5 4.5 L7 6.4 L5.6 10" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <span className="sep" />
        <button onClick={() => zoom(1)} title="Zoom in (+ / Page Up)">＋</button>
        <button onClick={() => zoom(-1)} title="Zoom out (− / Page Down)">－</button>
        <span className="sep" />
        <button onClick={() => { runtime.nav?.forgetReturn(); if (runtime.map) flyHome(runtime.map); }} title="Fit your whole network in view (or the whole country if it's empty)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 11 L12 4 L21 11 M6 9.5 V20 H18 V9.5" />
          </svg>
        </button>
      </div>
    </div>
    </>
  );
}

/** Shown while the camera orbits a double-clicked structure or span (as in the Laguna map). */
function OrbitHint() {
  const orbiting = useHud((h) => h.orbiting);
  if (!orbiting) return null;
  return (
    <div className="orbit-hint">
      <kbd>Esc</kbd> exit view · <kbd>R</kbd> reset view · click or drag to take control
    </div>
  );
}
