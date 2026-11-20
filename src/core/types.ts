import type { VoltageId } from '../catalog/voltages';

export interface Structure {
  id: string;
  defId: string;
  voltage: VoltageId;
  lng: number;
  lat: number;
  /** Heading of the structure's "along line" axis, degrees clockwise from north. */
  rotation: number;
  /** True once the player rotated it by hand; auto-orientation then leaves it alone. */
  manualRot: boolean;
  /** Ground elevation in metres, sampled from the terrain. */
  elev: number;
  builtAt: number;
  /** Structure number in its project (T-001, T-002 …), in the order it was plotted. */
  no?: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  created: number;
  updated: number;
}

export interface Span {
  id: string;
  a: string;
  b: string;
  voltage: VoltageId;
  /** Bays occupied at each end when that end is a station (exclusive bays). */
  slotsA: number[];
  slotsB: number[];
  builtAt: number;
}

export type Tool = 'select' | 'build' | 'connect' | 'route' | 'move' | 'bulldoze';

export interface Selection {
  kind: 'structure' | 'span';
  id: string;
}
