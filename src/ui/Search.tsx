import { useEffect, useMemo, useRef, useState } from 'react';
import { inPhilippines, PLACES } from '../core/geo';
import { flyHome, flyToBounds } from '../map/navigation';
import { flyTo, runtime } from '../map/runtime';

// Google Earth–style "search for a place" box. Quick-jump regions show
// instantly; pressing Enter searches OpenStreetMap (Nominatim) within the
// Philippines. Typing coordinates such as "14.58, 121.03" flies straight there.

interface Result {
  label: string;
  detail?: string;
  go: () => void;
}

let inputEl: HTMLInputElement | null = null;
export function focusSearch() {
  inputEl?.focus();
  inputEl?.select();
}

const COORDS = /^\s*(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)\s*$/;

function parseCoords(q: string): { lng: number; lat: number } | null {
  const m = q.match(COORDS);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (inPhilippines(b, a)) return { lat: a, lng: b };
  if (inPhilippines(a, b)) return { lat: b, lng: a };
  return null;
}

interface NominatimHit {
  display_name: string;
  name?: string;
  type?: string;
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
}

export function Search() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<Result[] | null>(null);
  const [status, setStatus] = useState<'' | 'busy' | 'none' | 'error'>('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputEl = ref.current;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  const finish = () => {
    setOpen(false);
    ref.current?.blur();
  };

  const local: Result[] = useMemo(() => {
    const t = q.trim().toLowerCase();
    const out: Result[] = [];
    const c = parseCoords(q);
    if (c) out.push({ label: `${c.lat.toFixed(5)}°N, ${c.lng.toFixed(5)}°E`, detail: 'Fly to coordinates', go: () => flyTo(c.lng, c.lat, 16) });
    for (const p of PLACES) {
      if (!t || p.name.toLowerCase().includes(t)) out.push({ label: p.name, detail: 'Region', go: () => flyTo(p.lng, p.lat, p.zoom) });
    }
    if (!t || 'whole country philippines'.includes(t)) out.push({ label: 'Whole Philippines', detail: 'Overview', go: () => runtime.map && flyHome(runtime.map) });
    return out;
  }, [q]);

  const results = [...(remote ?? []), ...local];

  const searchOnline = async () => {
    const t = q.trim();
    if (!t || parseCoords(t)) return;
    setStatus('busy');
    setRemote(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ph&limit=6&q=${encodeURIComponent(t)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) throw new Error(String(res.status));
      const hits: NominatimHit[] = await res.json();
      const mapped = hits.map<Result>((h) => {
        const [s, n, w, e] = h.boundingbox.map(parseFloat);
        const parts = h.display_name.split(', ');
        return {
          label: h.name || parts[0],
          detail: parts.slice(1, 4).join(', '),
          go: () => runtime.map && flyToBounds(runtime.map, w, s, e, n),
        };
      });
      setRemote(mapped);
      setActive(0);
      setStatus(mapped.length ? '' : 'none');
    } catch {
      setStatus('error');
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Escape') finish();
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = parseCoords(q);
      if (c) { flyTo(c.lng, c.lat, 16); finish(); return; }
      // Enter on a highlighted result picks it; otherwise search online
      if (remote && results[active]) { results[active].go(); finish(); }
      else void searchOnline();
    }
  };

  return (
    <div className="search" ref={box}>
      <svg className="search-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 L21 21" />
      </svg>
      <input
        ref={ref}
        value={q}
        placeholder="Search places or lat, lng   ( / )"
        onChange={(e) => { setQ(e.target.value); setRemote(null); setStatus(''); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        spellCheck={false}
      />
      {q && <button className="search-clear" onClick={() => { setQ(''); setRemote(null); setStatus(''); ref.current?.focus(); }} title="Clear">×</button>}
      {open && (
        <div className="search-drop panel">
          {q.trim() && !parseCoords(q) && !remote && (
            <button className={`search-item hint-row ${status === 'busy' ? 'busy' : ''}`} onMouseDown={(e) => { e.preventDefault(); void searchOnline(); }}>
              {status === 'busy' ? 'Searching…' : <>Press <kbd>Enter</kbd> to search “{q.trim()}” across the Philippines</>}
            </button>
          )}
          {status === 'none' && <div className="search-msg">No places found. Try a town, barangay or landmark name.</div>}
          {status === 'error' && <div className="search-msg bad">Search is unavailable right now. Check your connection.</div>}
          {results.map((r, i) => (
            <button
              key={`${r.label}-${i}`}
              className={`search-item ${i === active && remote ? 'on' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); r.go(); finish(); }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{r.label}</span>
              {r.detail && <small className="muted">{r.detail}</small>}
            </button>
          ))}
          {remote && <div className="search-attrib">Search © OpenStreetMap contributors</div>}
        </div>
      )}
    </div>
  );
}
