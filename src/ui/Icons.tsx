// Small line-art silhouettes for the construction menu (original drawings).

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Lattice({ arms, gw2, heavy, banded }: { arms: 'dc' | 'sc'; gw2?: boolean; heavy?: boolean; banded?: boolean }) {
  const w = heavy ? 9 : 7;
  return (
    <g {...S}>
      <path d={`M${24 - w} 44 L22 18 M${24 + w} 44 L26 18 M22 18 L22 6 M26 18 L26 6`} />
      <path d={`M${24 - w + 1} 40 L${24 + w - 1} 32 M${24 + w - 1} 40 L${24 - w + 1} 32 M${24 - w + 2.5} 30 L${24 + w - 2.5} 22 M${24 + w - 2.5} 30 L${24 - w + 2.5} 22`} strokeWidth={1} />
      {arms === 'dc' ? (
        <path d="M22 20 L12 20 M26 20 L36 20 M22 14 L10 14 M26 14 L38 14 M22 8 L12 8 M26 8 L36 8" />
      ) : (
        <path d="M22 20 L12 20 M26 15 L36 15 M22 10 L12 10" />
      )}
      {heavy && <path d="M12 20 L12 23 M36 20 L36 23 M10 14 L10 17 M38 14 L38 17 M12 8 L12 11 M36 8 L36 11" strokeWidth={2.4} />}
      {gw2 ? <path d="M22 6 L16 3 M26 6 L32 3" /> : <path d="M22 6 L24 2 L26 6" />}
      {banded && <path d="M18 34 L30 34 M20 26 L28 26" stroke="#ff5a4a" strokeWidth={2.2} />}
    </g>
  );
}

export function StructureIcon({ icon }: { icon: string }) {
  let body: JSX.Element;
  switch (icon) {
    case 'dc': body = <Lattice arms="dc" gw2 />; break;
    case 'sc': body = <Lattice arms="sc" />; break;
    case 'angle': body = <Lattice arms="dc" gw2 heavy />; break;
    case 'deadend': body = <Lattice arms="dc" gw2 heavy />; break;
    case 'scdeadend': body = <Lattice arms="sc" heavy />; break;
    case 'crossing': body = <Lattice arms="dc" gw2 heavy banded />; break;
    case 'pole':
      body = <g {...S}><path d="M24 44 L24 4 M24 12 L16 14 M24 20 L32 22 M24 28 L16 30" /><circle cx="16" cy="14" r="1.4" /><circle cx="32" cy="22" r="1.4" /><circle cx="16" cy="30" r="1.4" /></g>;
      break;
    case 'poledc':
      body = <g {...S}><path d="M24 44 L24 4 M24 12 L14 9 M24 12 L34 9 M24 20 L12 17 M24 20 L36 17 M24 28 L14 25 M24 28 L34 25" /></g>;
      break;
    case 'dist':
      body = <g {...S}><path d="M24 44 L24 6 M12 9 L36 9 M18 9 L24 14 L30 9" /><path d="M13 9 L13 6 M30 9 L30 6 M35 9 L35 6" /><rect x="17" y="18" width="5" height="7" rx="1.5" /></g>;
      break;
    case 'substation':
      body = <g {...S}><path d="M4 42 L44 42" /><path d="M8 42 L8 14 M20 42 L20 14 M8 14 L20 14 M28 42 L28 14 M40 42 L40 14 M28 14 L40 14" /><rect x="11" y="30" width="7" height="9" /><rect x="30" y="30" width="7" height="9" /><path d="M6 22 L42 22" strokeDasharray="2 2" /></g>;
      break;
    case 'plant':
      body = <g {...S}><path d="M4 42 L44 42" /><path d="M8 42 L8 22 L30 22 L30 42" /><path d="M34 42 L35 6 L39 6 L40 42" /><path d="M35 14 L39 14" stroke="#ff5a4a" strokeWidth={2} /><path d="M37 4 C 39 1, 43 2, 44 0" strokeWidth={1} /></g>;
      break;
    case 'solar':
      body = <g {...S}><path d="M4 42 L44 42" /><path d="M6 34 L20 26 L28 30 L14 38 Z M22 38 L36 30 L44 34 L30 42" /><circle cx="36" cy="10" r="5" /><path d="M36 1 L36 3 M45 10 L43 10 M42 4 L41 5" /></g>;
      break;
    case 'connect':
      body = <g {...S}><path d="M8 44 L10 10 L12 44 M36 44 L38 10 L40 44" /><path d="M10 12 Q24 26 38 12 M10 18 Q24 32 38 18" /></g>;
      break;
    case 'route':
      body = <g {...S}><path d="M4 40 L6 26 L8 40 M21 34 L23 20 L25 34 M38 28 L40 14 L42 28" /><path d="M6 27 Q14 32 23 21 Q31 26 40 15" /><path d="M2 46 L46 46" strokeDasharray="3 3" /></g>;
      break;
    default:
      body = <g {...S}><circle cx="24" cy="24" r="12" /></g>;
  }
  return <svg viewBox="0 0 48 48" width="100%" height="100%">{body}</svg>;
}

export function ToolIcon({ name }: { name: string }) {
  const p: Record<string, JSX.Element> = {
    select: <path d="M10 6 L10 36 L18 28 L24 40 L29 38 L23 26 L34 26 Z" />,
    move: <path d="M24 6 L24 42 M6 24 L42 24 M24 6 L19 11 M24 6 L29 11 M24 42 L19 37 M24 42 L29 37 M6 24 L11 19 M6 24 L11 29 M42 24 L37 19 M42 24 L37 29" />,
    bulldoze: <path d="M8 30 L30 30 L30 20 L22 20 L18 26 L8 26 Z M30 22 L40 18 L42 34 L30 32 M10 36 A3 3 0 1 0 10.1 36 M26 36 A3 3 0 1 0 26.1 36 M10 39 L26 39" />,
    top: <g><rect x="10" y="10" width="28" height="28" /><path d="M24 4 L24 10 M24 38 L24 44" /></g>,
    iso: <path d="M24 8 L40 16 L40 34 L24 42 L8 34 L8 16 Z M24 8 L24 24 M8 16 L24 24 L40 16 M24 24 L24 42" />,
    ground: <path d="M4 38 L44 38 M10 38 L14 14 L18 38 M30 38 L34 20 L38 38 M14 16 Q24 24 34 22" />,
    settings: <path d="M24 16 A8 8 0 1 0 24.1 16 M24 4 L24 10 M24 38 L24 44 M4 24 L10 24 M38 24 L44 24 M10 10 L14 14 M34 34 L38 38 M38 10 L34 14 M14 34 L10 38" />,
    help: <path d="M17 18 C17 10 31 10 31 18 C31 24 24 24 24 30 M24 36 L24 38" />,
    pin: <path d="M24 44 C24 44 10 28 10 18 A14 14 0 0 1 38 18 C38 28 24 44 24 44 Z M24 13 A5 5 0 1 0 24.1 13" />,
    north: <path d="M24 4 L32 40 L24 33 L16 40 Z" />,
  };
  return <svg viewBox="0 0 48 48" width="100%" height="100%"><g {...S} strokeWidth={2.4}>{p[name]}</g></svg>;
}
