import { useEffect, useState } from 'react';
import { TRANSMISSION_VOLTAGES } from './catalog/voltages';
import { useStore } from './core/store';
import { MapView } from './map/MapView';
import { runtime, setView } from './map/runtime';
import { Hud, InfoPanel, Rain, Settings, SideTools, TopBar, Welcome } from './ui/Panels';
import { Toolbar } from './ui/Toolbar';

export default function App() {
  const [settings, setSettings] = useState(false);
  const showWelcome = useStore((s) => s.showWelcome);
  const set = useStore((s) => s.set);

  // game clock
  useEffect(() => {
    let last = performance.now();
    let acc = 0;
    const t = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      const { env, setEnv } = useStore.getState();
      if (!env.timeSpeed) return;
      acc += dt * env.timeSpeed;
      if (acc > 0.01) {
        setEnv({ timeOfDay: (env.timeOfDay + acc) % 24 });
        acc = 0;
      }
    }, 100);
    return () => window.clearInterval(t);
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const held = new Set<string>();
    let raf = 0;
    const pan = () => {
      const map = runtime.map;
      if (map && held.size) {
        const k = 12;
        const dx = (held.has('d') || held.has('arrowright') ? k : 0) - (held.has('a') || held.has('arrowleft') ? k : 0);
        const dy = (held.has('s') || held.has('arrowdown') ? k : 0) - (held.has('w') || held.has('arrowup') ? k : 0);
        if (dx || dy) map.panBy([dx, dy], { duration: 0 });
        const rot = (held.has('e') ? 1.5 : 0) - (held.has('q') ? 1.5 : 0);
        if (rot) map.setBearing(map.getBearing() + rot);
      }
      raf = requestAnimationFrame(pan);
    };
    raf = requestAnimationFrame(pan);

    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      const s = useStore.getState();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        held.add(k);
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (k) {
        case 'escape': runtime.ctrl?.cancel(); break;
        case 'r': runtime.ctrl?.rotate(e.shiftKey ? -15 : 15); break;
        case 'v': s.setTool('select'); break;
        case 'm': s.setTool('move'); break;
        case 'x': s.setTool('bulldoze'); break;
        case 'c': s.setTool('connect'); break;
        case '1': setView('top'); break;
        case '2': setView('iso'); break;
        case '3': setView('ground'); break;
        case ' ': s.setEnv({ timeSpeed: s.env.timeSpeed ? 0 : 0.05 }); e.preventDefault(); break;
        case 'delete':
        case 'backspace':
          if (s.selected?.kind === 'structure') s.removeStructure(s.selected.id);
          else if (s.selected?.kind === 'span') s.removeSpan(s.selected.id);
          break;
        case 'pageup':
        case 'pagedown': {
          const i = TRANSMISSION_VOLTAGES.indexOf(s.voltage);
          const n = TRANSMISSION_VOLTAGES[Math.max(0, Math.min(TRANSMISSION_VOLTAGES.length - 1, i + (k === 'pageup' ? 1 : -1)))];
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
    const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase());
    const blur = () => held.clear();
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
      <Hud />
      <Toolbar />
      {settings && <Settings onClose={() => setSettings(false)} />}
      {showWelcome && <Welcome onClose={() => set({ showWelcome: false })} />}
    </div>
  );
}
