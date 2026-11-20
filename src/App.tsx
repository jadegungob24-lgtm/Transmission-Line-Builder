import { useEffect, useState } from 'react';
import { TRANSMISSION_VOLTAGES } from './catalog/voltages';
import { useStore } from './core/store';
import { MapView } from './map/MapView';
import { northUp, resetTilt, resetView } from './map/navigation';
import { runtime, setView } from './map/runtime';
import { NavWidget } from './ui/NavWidget';
import { Hud, InfoPanel, Rain, Settings, SideTools, TopBar, Welcome } from './ui/Panels';
import { focusSearch } from './ui/Search';
import { Toolbar } from './ui/Toolbar';

// Keys that move the camera while held down (checked every frame).
const HELD_KEYS = new Set([
  'w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright',
  '+', '=', '-', '_', 'pageup', 'pagedown',
]);

export default function App() {
  const [settings, setSettings] = useState(false);
  const showWelcome = useStore((s) => s.showWelcome);
  const set = useStore((s) => s.set);

  useEffect(() => {
    const held = new Set<string>();
    let shift = false;
    let raf = 0;

    const tick = () => {
      const nav = runtime.nav;
      if (nav && held.size) {
        const has = (...k: string[]) => k.some((x) => held.has(x));
        const PAN = 12;
        const right = (has('d', 'arrowright') ? 1 : 0) - (has('a', 'arrowleft') ? 1 : 0);
        const down = (has('s', 'arrowdown') ? 1 : 0) - (has('w', 'arrowup') ? 1 : 0);
        let pan: [number, number] = [right * PAN, down * PAN];
        let rotate = (has('e') ? 1.5 : 0) - (has('q') ? 1.5 : 0);
        let tilt = 0;
        if (shift) {
          // Google Earth: Shift + arrows rotates (left/right) and tilts (up/down)
          rotate += right * 1.5;
          tilt = -down * 1.2;
          pan = [0, 0];
        }
        const zoom = (has('+', '=', 'pageup') ? 0.035 : 0) - (has('-', '_', 'pagedown') ? 0.035 : 0);
        nav.keyboardStep(pan, rotate, tilt, zoom);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const down = (e: KeyboardEvent) => {
      shift = e.shiftKey;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      const s = useStore.getState();

      if ((e.ctrlKey || e.metaKey) && k === 'f') {
        e.preventDefault();
        focusSearch();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (HELD_KEYS.has(k)) {
        held.add(k);
        e.preventDefault();
        return;
      }
      const map = runtime.map;
      switch (k) {
        case 'escape': runtime.ctrl?.cancel(); break;
        case 'r': if (map) resetView(map); break;
        case 't': runtime.ctrl?.rotate(e.shiftKey ? -15 : 15); break;
        case 'v': s.setTool('select'); break;
        case 'm': s.setTool('move'); break;
        case 'x': s.setTool('bulldoze'); break;
        case 'c': s.setTool('connect'); break;
        case 'n': if (map) northUp(map); break;
        case 'u': if (map) resetTilt(map); break;
        case '/': e.preventDefault(); focusSearch(); break;
        case '1': setView('top'); break;
        case '2': setView('iso'); break;
        case '3': setView('ground'); break;
        case 'delete':
        case 'backspace':
          if (s.selected?.kind === 'structure') s.removeStructure(s.selected.id);
          else if (s.selected?.kind === 'span') s.removeSpan(s.selected.id);
          break;
        case '[':
        case ']': {
          const i = TRANSMISSION_VOLTAGES.indexOf(s.voltage);
          const n = TRANSMISSION_VOLTAGES[Math.max(0, Math.min(TRANSMISSION_VOLTAGES.length - 1, i + (k === ']' ? 1 : -1)))];
          s.setVoltage(n);
          break;
        }
        default:
          if (/^f[1-5]$/.test(k)) {
            e.preventDefault();
            document.querySelectorAll<HTMLButtonElement>('.tabs .tab')[parseInt(k.slice(1)) - 1]?.click();
          }
      }
    };
    const up = (e: KeyboardEvent) => {
      shift = e.shiftKey;
      held.delete(e.key.toLowerCase());
      // Shift changes e.key for some keys ('+' / '='), so release both forms
      if (e.key === '=' || e.key === '+') { held.delete('='); held.delete('+'); }
      if (e.key === '-' || e.key === '_') { held.delete('-'); held.delete('_'); }
    };
    const blur = () => {
      held.clear();
      shift = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <div className="app">
      <MapView />
      <Rain />
      <TopBar onSettings={() => setSettings(true)} onHelp={() => set({ showWelcome: true })} />
      <SideTools />
      <InfoPanel />
      <NavWidget />
      <Hud />
      <Toolbar />
      {settings && <Settings onClose={() => setSettings(false)} />}
      {showWelcome && <Welcome onClose={() => set({ showWelcome: false })} />}
    </div>
  );
}
