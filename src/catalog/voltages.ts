// Voltage classes. Every tower builder and conductor rule reads its dimensions
// from here, so adding a class is one entry in this table.

export type VoltageId = 'v13' | 'v69' | 'v115' | 'v138' | 'v230' | 'v500';

export interface VoltageSpec {
  id: VoltageId;
  kv: number;
  label: string;
  /** Map / UI colour for this class. */
  color: string;
  /** Vertical spacing between crossarm levels (m). */
  vSpacing: number;
  /** Tower centre to phase attachment (m). */
  armLen: number;
  /** Insulator string length (m). */
  insLen: number;
  /** Sub-conductors per phase. */
  bundle: number;
  /** Ground to lowest crossarm on a standard-height tower (m). */
  baseHeight: number;
  /** Tower base width (m). */
  baseWidth: number;
  /** Ruling / maximum span on standard structures (m). */
  maxSpan: number;
  minSpan: number;
  /** Catenary constant H/w at everyday tension (m). Larger = flatter. */
  catenaryC: number;
  conductor: string;
  groundWires: number;
  /** Right-of-Way (ROW) corridor half-width in metres from centerline (NGCP Circular No. 2010-17). */
  rowHalfWidthM: number;
  /** Official NGCP centerline color code (hex) for map alignment, DWG, and KMZ exports. */
  centerlineColor: string;
}

export const VOLTAGES: Record<VoltageId, VoltageSpec> = {
  v13: {
    id: 'v13', kv: 13.8, label: '13.8 kV', color: '#9aa7b4', vSpacing: 1, armLen: 1.1, insLen: 0.3,
    bundle: 1, baseHeight: 10, baseWidth: 0.4, maxSpan: 90, minSpan: 15, catenaryC: 350,
    conductor: '1 × 336.4 MCM ACSR', groundWires: 1, rowHalfWidthM: 5, centerlineColor: '#00FF00',
  },
  v69: {
    id: 'v69', kv: 69, label: '69 kV', color: '#b07cff', vSpacing: 2.4, armLen: 2.3, insLen: 1.0,
    bundle: 1, baseHeight: 15, baseWidth: 4.2, maxSpan: 350, minSpan: 40, catenaryC: 1200,
    conductor: '1 × 336.4 MCM ACSR', groundWires: 1, rowHalfWidthM: 15, centerlineColor: '#00FFFF',
  },
  v115: {
    id: 'v115', kv: 115, label: '115 kV', color: '#39c98a', vSpacing: 3.2, armLen: 3.0, insLen: 1.4,
    bundle: 1, baseHeight: 18, baseWidth: 5.2, maxSpan: 400, minSpan: 50, catenaryC: 1400,
    conductor: '1 × 795 MCM ACSR', groundWires: 1, rowHalfWidthM: 30, centerlineColor: '#FFBF00',
  },
  v138: {
    id: 'v138', kv: 138, label: '138 kV', color: '#ffa63d', vSpacing: 3.8, armLen: 3.5, insLen: 1.7,
    bundle: 1, baseHeight: 20, baseWidth: 5.8, maxSpan: 450, minSpan: 50, catenaryC: 1500,
    conductor: '1 × 795 MCM ACSR', groundWires: 1, rowHalfWidthM: 30, centerlineColor: '#FF7F50',
  },
  v230: {
    id: 'v230', kv: 230, label: '230 kV', color: '#ff5a5f', vSpacing: 5.5, armLen: 5.0, insLen: 2.6,
    bundle: 2, baseHeight: 24, baseWidth: 7.6, maxSpan: 550, minSpan: 60, catenaryC: 1700,
    conductor: '2 × 795 MCM ACSR', groundWires: 2, rowHalfWidthM: 40, centerlineColor: '#FF0000',
  },
  v500: {
    id: 'v500', kv: 500, label: '500 kV', color: '#3da5ff', vSpacing: 10, armLen: 9.5, insLen: 4.8,
    bundle: 4, baseHeight: 32, baseWidth: 12, maxSpan: 700, minSpan: 80, catenaryC: 2000,
    conductor: '4 × 795 MCM ACSR', groundWires: 2, rowHalfWidthM: 60, centerlineColor: '#0000FF',
  },
};

export const TRANSMISSION_VOLTAGES: VoltageId[] = ['v69', 'v115', 'v138', 'v230', 'v500'];
