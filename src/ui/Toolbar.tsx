import { useState } from 'react';
import { Category, defSupports, STRUCTURE_DEFS } from '../catalog/structures';
import { VOLTAGES, VoltageId } from '../catalog/voltages';
import { useStore } from '../core/store';
import { StructureIcon } from './Icons';

type Tab = 'tower' | 'pole' | 'conductor' | 'substation' | 'other';
const TABS: { id: Tab; label: string; key: string }[] = [
  { id: 'tower', label: 'Transmission Towers', key: 'F1' },
  { id: 'pole', label: 'Distribution Poles', key: 'F2' },
  { id: 'conductor', label: 'Conductors', key: 'F3' },
  { id: 'substation', label: 'Substations', key: 'F4' },
  { id: 'other', label: 'Other Infrastructure', key: 'F5' },
];

const CONDUCTOR_TOOLS = [
  { id: 'connect', tool: 'connect' as const, defId: null, name: 'String Conductors', icon: 'connect', desc: 'Click structures one after another to string phase conductors and ground wires between them.' },
  { id: 'route-dc', tool: 'route' as const, defId: 'dc-suspension', name: 'Auto Route · DC Lattice', icon: 'route', desc: 'Click start and end: suspension towers are placed at the ruling span along the terrain, with dead-ends at the ends.' },
  { id: 'route-sc', tool: 'route' as const, defId: 'sc-suspension', name: 'Auto Route · SC Lattice', icon: 'route', desc: 'Single-circuit lattice route between two points.' },
  { id: 'route-pole', tool: 'route' as const, defId: 'pole-dc', name: 'Auto Route · Steel Poles', icon: 'route', desc: 'Double-circuit steel pole line (69–138 kV).' },
  { id: 'route-dist', tool: 'route' as const, defId: 'pole-dist', name: 'Auto Route · Distribution', icon: 'route', desc: '13.8 kV distribution feeder on concrete poles.' },
];

const VOLT_ORDER: VoltageId[] = ['v13', 'v69', 'v115', 'v138', 'v230', 'v500'];

export function Toolbar() {
  const [tab, setTab] = useState<Tab | null>('tower');
  const tool = useStore((s) => s.tool);
  const buildDefId = useStore((s) => s.buildDefId);
  const voltage = useStore((s) => s.voltage);
  const setTool = useStore((s) => s.setTool);
  const setVoltage = useStore((s) => s.setVoltage);
  const [hover, setHover] = useState<{ name: string; desc: string; extra?: string } | null>(null);

  const defs = STRUCTURE_DEFS.filter((d) => d.category === (tab as Category));
  const activeDef = buildDefId ? STRUCTURE_DEFS.find((d) => d.id === buildDefId) : null;
  const allowed = (v: VoltageId) => !activeDef || defSupports(activeDef, v);

  return (
    <div className="toolbar">
      {hover && (
        <div className="tooltip panel">
          <b>{hover.name}</b>
          <p>{hover.desc}</p>
          {hover.extra && <p className="muted">{hover.extra}</p>}
        </div>
      )}
      <div className="toolbar-head">
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(tab === t.id ? null : t.id)} title={t.key}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="volts">
          <span className="muted">Voltage</span>
          {VOLT_ORDER.map((v) => (
            <button
              key={v}
              className={`volt ${voltage === v ? 'on' : ''}`}
              style={{ ['--vc' as string]: VOLTAGES[v].color }}
              disabled={!allowed(v)}
              onClick={() => setVoltage(v)}
            >
              {VOLTAGES[v].label}
            </button>
          ))}
        </div>
      </div>
      {tab && (
        <div className="cards panel">
          {tab === 'conductor'
            ? CONDUCTOR_TOOLS.map((c) => {
                const on = tool === c.tool && (c.defId == null || buildDefId === c.defId);
                return (
                  <button
                    key={c.id}
                    className={`card ${on ? 'on' : ''}`}
                    onClick={() => {
                      setTool(c.tool, c.defId);
                      if (c.id === 'route-dist') setVoltage('v13');
                      if (c.id === 'route-pole' && !['v69', 'v115', 'v138'].includes(voltage)) setVoltage('v69');
                      if ((c.id === 'route-dc' || c.id === 'route-sc') && ['v13'].includes(voltage)) setVoltage('v230');
                    }}
                    onMouseEnter={() => setHover({ name: c.name, desc: c.desc })}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div className="card-icon"><StructureIcon icon={c.icon} /></div>
                    <div className="card-name">{c.name}</div>
                  </button>
                );
              })
            : defs.map((d) => {
                const on = tool === 'build' && buildDefId === d.id;
                const vs = d.voltages === 'any' ? 'All voltages' : d.voltages.map((v) => VOLTAGES[v].label).join(' · ');
                return (
                  <button
                    key={d.id}
                    className={`card ${on ? 'on' : ''}`}
                    onClick={() => setTool(on ? 'select' : 'build', on ? null : d.id)}
                    onMouseEnter={() => setHover({
                      name: d.name, desc: d.description,
                      extra: `${vs}${d.capacityMW ? ` · ${d.capacityMW} MW` : ''}${d.loadMW ? ` · ${d.loadMW} MW load` : ''}${d.maxAngle != null ? ` · max angle ${d.maxAngle}°` : ''}`,
                    })}
                    onMouseLeave={() => setHover(null)}
                  >
                    <div className="card-icon"><StructureIcon icon={d.icon} /></div>
                    <div className="card-name">{d.short}</div>
                  </button>
                );
              })}
          {tab === 'conductor' && (
            <div className="spec">
              <b>{VOLTAGES[voltage].label} conductor</b>
              <span>{VOLTAGES[voltage].conductor}</span>
              <span>{VOLTAGES[voltage].groundWires} × OPGW / ground wire</span>
              <span>Ruling span ≈ {Math.round(VOLTAGES[voltage].maxSpan * 0.82)} m</span>
              <span>ROW ±{VOLTAGES[voltage].rowHalfWidthM} m from CL ({VOLTAGES[voltage].rowHalfWidthM * 2} m)</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
