import type { Cell, Row, Sheet, SheetData } from 'write-excel-file/browser';
import { DEF_BY_ID, insulatorRange, modelOf } from '../catalog/structures';
import { VOLTAGES, type VoltageId } from '../catalog/voltages';
import { bearingDeg, distanceM } from './geo';
import { toPrs92 } from './prs92';
import { traceAlignmentChains } from './row';
import { structureTag } from './store';
import type { Span, Structure } from './types';
import { angleRemark, lineAngle, neighbours } from '../network/connectivity';

// NGCP-format Tower Schedule & Bill of Materials Excel (.xlsx) builder.
// Mirrors the standard interleaved Structure / Span row layout with live Excel
// formulas for forward spans, km+m stationing, wind spans, deviation angles
// (decimal & DMS), automatic DQ4–DV4 tower classification, spacer dampers,
// hardware & insulator totals, conductor/OPGW cable lengths with 5% sag,
// and tower-type COUNTIF summary.

const M_TO_FT = 3.280839895;

const BORDER = { borderStyle: 'thin' as const, borderColor: '#B8C4D4' };
const HEAD_BORDER = { borderStyle: 'thin' as const, borderColor: '#64748B' };

const headCell = (
  value: string,
  extra: Partial<Exclude<Cell, string | number | boolean | Date | null | undefined>> = {},
): Cell => ({
  value,
  fontWeight: 'bold',
  fontSize: 10,
  backgroundColor: '#DCE6F1',
  textColor: '#0F172A',
  align: 'center',
  alignVertical: 'center',
  wrap: true,
  ...HEAD_BORDER,
  ...extra,
});

const strCell = (
  value: string | null,
  extra: Partial<Exclude<Cell, string | number | boolean | Date | null | undefined>> = {},
): Cell => ({
  value: value ?? undefined,
  type: value == null ? undefined : String,
  fontSize: 10,
  align: 'center',
  alignVertical: 'center',
  ...BORDER,
  ...extra,
});

const numCell = (
  value: number,
  format: string,
  extra: Partial<Exclude<Cell, string | number | boolean | Date | null | undefined>> = {},
): Cell => ({
  value,
  type: Number,
  format,
  fontSize: 10,
  align: 'right',
  alignVertical: 'center',
  ...BORDER,
  ...extra,
});

/** Live Excel formula cell (formula string MUST omit leading '=' for valid OOXML). */
const fmlCell = (
  formula: string,
  format?: string,
  extra: Partial<Exclude<Cell, string | number | boolean | Date | null | undefined>> = {},
): Cell => ({
  value: formula,
  type: 'Formula',
  format,
  fontSize: 10,
  align: 'right',
  alignVertical: 'center',
  ...BORDER,
  ...extra,
});

const emptyRow = (len = 28): Row => Array.from({ length: len }, () => null);

/** Build a 28-column (A..AB) row initialized with nulls, setting entries by 0-based col index. */
function makeRow(entries: Record<number, Cell>, fillBlankBorders?: { from: number; to: number; bg?: string }): Row {
  const row: Row = Array.from({ length: 28 }, () => null);
  if (fillBlankBorders) {
    for (let c = fillBlankBorders.from; c <= fillBlankBorders.to; c++) {
      row[c] = {
        value: undefined,
        fontSize: 10,
        backgroundColor: fillBlankBorders.bg,
        ...BORDER,
      };
    }
  }
  for (const [k, v] of Object.entries(entries)) {
    row[Number(k)] = v;
  }
  return row;
}

const NGCP_COLUMNS: { width: number }[] = [
  { width: 3 },  // A: margin
  { width: 20 }, // B: TOWER No.
  { width: 7 },  // C: STATION (km.)
  { width: 12 }, // D: STATION (meter)
  { width: 13 }, // E: SPAN Actual (Forward)
  { width: 12 }, // F: SPAN Wind
  { width: 11 }, // G: Deviation Angle (Decimal)
  { width: 13 }, // H: Deviation Angle (DMS)
  { width: 12 }, // I: POLE / TOWER Type
  { width: 11 }, // J: Structure Height (ft)
  { width: 14 }, // K: Easting
  { width: 15 }, // L: Northing
  { width: 11 }, // M: Elevation
  { width: 11 }, // N: Conductor Suspension String
  { width: 11 }, // O: Conductor Tension String
  { width: 10 }, // P: Conductor Jumper String
  { width: 10 }, // Q: Conductor Jumper Spacer
  { width: 10 }, // R: Conductor Spacer Damper
  { width: 11 }, // S: OPGW Suspension Assy
  { width: 10 }, // T: OPGW Tension Assy
  { width: 9 },  // U: OPGW Joint Box
  { width: 11 }, // V: OPGW Vibration Damper
  { width: 8 },  // W: Grounding Type G1
  { width: 8 },  // X: Grounding Type G2
  { width: 9 },  // Y: Danger Sign
  { width: 10 }, // Z: Ground Patrol Number
  { width: 12 }, // AA: Plan & Profile (Sheet No.)
  { width: 28 }, // AB: REMARKS
];

function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/?*[\]:]+/g, ' ').trim().slice(0, 31) || 'Tower Schedule';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; i < 99; i++) {
    const suffix = ` (${i})`;
    const candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return base;
}

/**
 * Build one NGCP-format Tower Schedule sheet for a single ordered line alignment.
 */
function buildNgcpLineSheet(
  title: string,
  sheetName: string,
  sts: Structure[],
  voltageId: VoltageId | null,
  exaggeration: number,
  isConnectedLine: boolean,
): Sheet<unknown> {
  const data: SheetData = [];
  const ex = exaggeration || 1;

  // Determine line parameters (circuits & ground wires) from the voltage class / structures
  const sampleLineSt = sts.find((s) => DEF_BY_ID[s.defId]?.role === 'line');
  const vId: VoltageId = voltageId ?? sampleLineSt?.voltage ?? sts[0]?.voltage ?? 'v230';
  const vSpec = VOLTAGES[vId];
  const circuits = sampleLineSt ? Math.max(1, DEF_BY_ID[sampleLineSt.defId].circuits) : 2;
  const phases = circuits * 3; // 6 for double-circuit, 3 for single-circuit
  const groundWires = Math.max(1, vSpec.groundWires);
  const tensionPerTerminal = phases; // 6 for DC, 3 for SC
  const tensionPerTower = phases * 2; // 12 for DC, 6 for SC
  const jumperPerTower = phases * 2; // 12 for DC, 6 for SC
  const jumperSpacerPerTower = circuits >= 2 ? 78 : 39;
  const opgwTensionPerStruct = groundWires * 2; // 4 for 2 OPGWs, 2 for 1 OPGW
  const spacerDivisor = phases === 6 ? 10 : Math.round(60 / phases); // 60m sub-span spacing

  // Rows 1–3: top blank rows
  data.push(emptyRow(), emptyRow(), emptyRow());

  // Row 4: Title row
  data.push(
    makeRow({
      1: {
        value: title.toUpperCase(),
        fontWeight: 'bold',
        fontSize: 13,
        textColor: '#0F172A',
        columnSpan: 12,
        height: 22,
        alignVertical: 'center',
      },
    }),
  );

  // Row 5: blank spacer
  data.push(emptyRow());

  // Row 6: Group header row (merged horizontally & vertically matching NGCP template;
  // overlapped slots are left as null as required by write-excel-file)
  data.push(
    makeRow({
      1: headCell('T O W E R No.', { rowSpan: 2, height: 28 }),
      2: headCell('S T A T I O N No.', { columnSpan: 2 }),
      4: headCell('S P A N\n(meters)', { columnSpan: 2 }),
      6: headCell('Deviation Angle', { columnSpan: 2 }),
      8: headCell('P O L E / T O W E R\nType', { rowSpan: 2 }),
      9: headCell('Structure\nHeight\n(ft)', { rowSpan: 2 }),
      10: headCell('C O O R D I N A T E S', { columnSpan: 3 }),
      13: headCell('C O N D U C T O R', { columnSpan: 5 }),
      18: headCell('O P G W', { columnSpan: 4 }),
      22: headCell('G R O U N D I N G', { columnSpan: 2 }),
      24: headCell('Danger\nSign', { rowSpan: 2 }),
      25: headCell('Ground\nPatrol\nNumber', { rowSpan: 2 }),
      26: headCell('Plan & Profile\n(Sheet No.)', { rowSpan: 2 }),
      27: headCell('REMARKS', { rowSpan: 2 }),
    }),
  );

  // Row 7: Sub-header row (slots overlapped by rowSpan: 2 above are left null)
  data.push(
    makeRow({
      2: headCell('(km.)', { height: 34 }),
      3: headCell('(meter)'),
      4: headCell('Actual\n(Forward)'),
      5: headCell('Wind'),
      6: headCell('Decimal\n(°)'),
      7: headCell('DMS'),
      10: headCell('Easting'),
      11: headCell('Northing'),
      12: headCell('Elevation'),
      13: headCell('Suspension\nString'),
      14: headCell('Tension\nString'),
      15: headCell('Jumper\nString'),
      16: headCell('Jumper\nSpacer'),
      17: headCell('Spacer\nDamper'),
      18: headCell('Suspension\nAssy'),
      19: headCell('Tension\nAssy'),
      20: headCell('Joint\nBox'),
      21: headCell('Vibration\nDamper'),
      22: headCell('Type\nG1'),
      23: headCell('Type\nG2'),
    }),
  );

  // Interleaved Structure rows (8, 10, 12, ...) & Span rows (9, 11, 13, ...)
  const firstRow = 8;
  const n = sts.length;
  const lastRow = n > 0 ? firstRow + 2 * (n - 1) : firstRow;

  for (let i = 0; i < n; i++) {
    const st = sts[i];
    const r = firstRow + 2 * i; // 1-based Excel row for this structure
    const def = DEF_BY_ID[st.defId];
    const isStation = def.role !== 'line';
    const c = toPrs92(st.lng, st.lat);
    const elevM = st.elev / ex;
    const heightFt = modelOf(st).height * M_TO_FT;
    const isFirst = i === 0;
    const isLast = i === n - 1;
    const isInterior = !isFirst && !isLast;

    // Station formulas (km only displayed when crossing into a new km; meter is MOD 1000)
    let kmCell: Cell = strCell(null);
    let mCell: Cell = strCell(null);
    if (isConnectedLine && i >= 1) {
      const cumFormula = `SUM($E$9:E${r - 1})`;
      const prevCumFormula = i >= 2 ? `SUM($E$9:E${r - 3})` : '0';
      kmCell = fmlCell(
        `IF(INT(${cumFormula}/1000)>INT(${prevCumFormula}/1000),INT(${cumFormula}/1000),"")`,
        '0',
        { align: 'center', fontWeight: 'bold' },
      );
      mCell = fmlCell(`MOD(${cumFormula},1000)`, '#,##0.000');
    }

    // Wind span = average of back span (E{r-1}) and forward span (E{r+1})
    const windCell: Cell =
      isConnectedLine && isInterior
        ? fmlCell(`(E${r - 1}+E${r + 1})/2`, '#,##0.000')
        : strCell(null);

    // Deviation angle (Decimal & DMS) computed live from Easting (K) & Northing (L)
    let angleDecCell: Cell = strCell(null);
    let angleDmsCell: Cell = strCell(null);
    if (isConnectedLine && isInterior) {
      const dot = `(K${r}-K${r - 2})*(K${r + 2}-K${r})+(L${r}-L${r - 2})*(L${r + 2}-L${r})`;
      const denom = `(E${r - 1}*E${r + 1})`;
      angleDecCell = fmlCell(
        `IFERROR(DEGREES(ACOS(MAX(-1,MIN(1,(${dot})/${denom})))),0)`,
        '0.00',
      );
      angleDmsCell = fmlCell(`TEXT(G${r}/24,"[h]° mm' ss""")`, undefined, { align: 'center' });
    }

    // Tower Type: GANTRY for stations, live NGCP angle classification formula for interior towers, DT4 for dead-end terminal towers
    let typeCell: Cell;
    if (isStation) {
      typeCell = strCell('GANTRY', { fontWeight: 'bold' });
    } else if (isConnectedLine && isInterior) {
      typeCell = fmlCell(
        `IF(G${r}<=1,"DQ4",IF(G${r}<=5,"DR4",IF(G${r}<=10,"DS4",IF(G${r}<=30,"DT4",IF(G${r}<=60,"DU4","DV4")))))`,
        undefined,
        { align: 'center', fontWeight: 'bold' },
      );
    } else {
      typeCell = strCell('DT4', { fontWeight: 'bold' });
    }

    const baseRemark = `${def.short} · ${vSpec.label} · PTM Zone ${c.zone.roman}`;
    const remarkCell: Cell =
      isConnectedLine && isInterior && !isStation && def.maxAngle != null
        ? fmlCell(
            `IF(G${r}>90.5,"Exceeds ${def.maxAngle}° limit (above 90° max)",IF(G${r}>${def.maxAngle + 0.5},"Exceeds ${def.maxAngle}° limit — use "&IF(G${r}>30,"Dead-End","Angle or Dead-End")&" tower","${baseRemark}"))`,
            undefined,
            { align: 'left' },
          )
        : strCell(baseRemark, { align: 'left' });

    data.push(
      makeRow(
        {
          1: strCell(structureTag(st), { align: 'left', fontWeight: 'bold' }),
          2: kmCell,
          3: mCell,
          4: strCell(null),
          5: windCell,
          6: angleDecCell,
          7: angleDmsCell,
          8: typeCell,
          9: numCell(heightFt, '0.0', { align: 'center' }),
          10: numCell(c.easting, '#,##0.000'),
          11: numCell(c.northing, '#,##0.000'),
          12: numCell(elevM, '0.0'),
          13: numCell(0, '#,##0', { align: 'center' }),
          14: numCell(isStation ? tensionPerTerminal : tensionPerTower, '#,##0', { align: 'center' }),
          15: isStation ? strCell('-') : numCell(jumperPerTower, '#,##0', { align: 'center' }),
          16: isStation ? strCell('-') : numCell(jumperSpacerPerTower, '#,##0', { align: 'center' }),
          17: strCell(null),
          18: numCell(0, '#,##0', { align: 'center' }),
          19: numCell(opgwTensionPerStruct, '#,##0', { align: 'center' }),
          20: numCell(2, '#,##0', { align: 'center' }),
          21: strCell(null),
          22: numCell(2, '#,##0', { align: 'center' }),
          23: numCell(2, '#,##0', { align: 'center' }),
          24: numCell(2, '#,##0', { align: 'center' }),
          25: numCell(2, '#,##0', { align: 'center' }),
          26: strCell(null),
          27: remarkCell,
        },
        { from: 1, to: 27 },
      ),
    );

    // Interleaved Span row between structure i and structure i + 1
    if (i < n - 1) {
      const sr = r + 1;
      const spanEntries: Record<number, Cell> = {};
      if (isConnectedLine) {
        spanEntries[4] = fmlCell(
          `SQRT((K${r + 2}-K${r})^2+(L${r + 2}-L${r})^2)`,
          '#,##0.000',
          { backgroundColor: '#F8FAFC' },
        );
        spanEntries[17] = fmlCell(`ROUNDUP(E${sr}/${spacerDivisor},0)`, '#,##0', {
          align: 'center',
          backgroundColor: '#F8FAFC',
        });
        spanEntries[21] = numCell(2, '#,##0', { align: 'center', backgroundColor: '#F8FAFC' });
      }
      data.push(makeRow(spanEntries, { from: 1, to: 27, bg: '#F8FAFC' }));
    }
  }

  // Trailing row below last structure (matches user template spacing before totals)
  if (n > 0) {
    const trailingRowIdx = lastRow + 1; // eslint-disable-line @typescript-eslint/no-unused-vars
    data.push(emptyRow());
  }

  // ---- Summary & Bill of Materials (BOM) Block (all live Excel formulas) ----
  if (n > 0) {
    const sumSpanRow = lastRow + 2; // 1-based Excel row
    const firstSpanRow = firstRow + 1;
    const lastSpanRow = n > 1 ? lastRow - 1 : firstRow;

    // Row sumSpanRow: Total actual route length
    data.push(
      makeRow({
        3: strCell('Total Route Length (m)', { align: 'right', fontWeight: 'bold', borderStyle: undefined }),
        4: isConnectedLine && n > 1
          ? fmlCell(`SUM(E${firstSpanRow}:E${lastSpanRow})`, '#,##0.000', {
              fontWeight: 'bold',
              backgroundColor: '#EEF2FF',
            })
          : numCell(0, '#,##0.000', { fontWeight: 'bold', backgroundColor: '#EEF2FF' }),
      }),
    );

    // Blank spacer row (sumSpanRow + 1)
    data.push(emptyRow());

    // Row asmRow: Assembly totals + base route length for cable BOM
    const asmRow = sumSpanRow + 2;
    const sumCol = (col: string) =>
      fmlCell(`SUM(${col}${firstRow}:${col}${lastRow})`, '#,##0', {
        align: 'center',
        fontWeight: 'bold',
        backgroundColor: '#DCE6F1',
      });

    data.push(
      makeRow({
        3: fmlCell(`E${sumSpanRow}`, '#,##0.000', { fontWeight: 'bold' }),
        4: fmlCell(`E${sumSpanRow}`, '#,##0.000', { fontWeight: 'bold', backgroundColor: '#FEF9C3' }),
        8: strCell('assembly', { fontWeight: 'bold', backgroundColor: '#DCE6F1' }),
        13: sumCol('N'),
        14: sumCol('O'),
        15: sumCol('P'),
        16: sumCol('Q'),
        17: sumCol('R'),
        18: sumCol('S'),
        19: sumCol('T'),
        20: sumCol('U'),
        21: sumCol('V'),
        22: sumCol('W'),
        23: sumCol('X'),
        24: sumCol('Y'),
        25: sumCol('Z'),
      }),
    );

    // Row condRow: Conductor length & Insulators disc counts
    const condRow = asmRow + 1;
    data.push(
      makeRow({
        2: strCell('conductor length', { align: 'left', columnSpan: 2, fontWeight: 'bold' }),
        4: fmlCell(`E${asmRow}*${phases}`, '#,##0.000'),
        5: numCell(0.05, '0%', { align: 'center', backgroundColor: '#FEF9C3' }),
        8: strCell('insulators', { fontWeight: 'bold', backgroundColor: '#E2E8F0' }),
        13: fmlCell(`N${asmRow}*44`, '#,##0', { align: 'center', fontWeight: 'bold' }),
        14: fmlCell(`O${asmRow}*88`, '#,##0', { align: 'center', fontWeight: 'bold' }),
        15: fmlCell(`P${asmRow}*21`, '#,##0', { align: 'center', fontWeight: 'bold' }),
      }),
    );

    // Row sagRow: Conductor length with 5% sag
    data.push(
      makeRow({
        2: strCell('conductor length with 5% sag', { align: 'left', columnSpan: 2, fontWeight: 'bold' }),
        4: fmlCell(`E${condRow}*(1+F${condRow})`, '#,##0.000', { fontWeight: 'bold' }),
        5: fmlCell(`E${condRow}*F${condRow}`, '#,##0.000'),
      }),
    );

    // Row jointRow: Joint & repair assembly (1 per 2,000 m reel)
    data.push(
      makeRow({
        2: strCell('joint & repair assembly', { align: 'left', columnSpan: 2, fontWeight: 'bold' }),
        4: fmlCell(`ROUNDUP(E${condRow}/2000,0)`, '#,##0', { align: 'center', fontWeight: 'bold' }),
      }),
    );

    // Row ttHeadRow: Tower Type summary table header
    data.push(
      makeRow({
        9: headCell('Angle Range'),
        10: headCell('Tower Type'),
        11: headCell('Number of Towers'),
        12: headCell('Symbol'),
      }),
    );

    // Row opgwSagRow: OPGW 5% sag factor
    const opgwSagRow = asmRow + 5;
    data.push(
      makeRow({
        5: numCell(0.05, '0%', { align: 'center', backgroundColor: '#FEF9C3' }),
      }),
    );

    // Rows ttStart..ttStart+5: OPGW length + DQ4–DV4 COUNTIF summary table
    const ttStart = opgwSagRow + 1;
    const towerTypes: { range: string; code: string; symbol: string }[] = [
      { range: '0°-1°', code: 'DQ4', symbol: 'Triangle' },
      { range: '0°-5°', code: 'DR4', symbol: 'Triangle' },
      { range: '0°-10°', code: 'DS4', symbol: 'Triangle' },
      { range: '0°-30°', code: 'DT4', symbol: 'Square' },
      { range: '0°-60°', code: 'DU4', symbol: 'Square' },
      { range: '61°-90°', code: 'DV4', symbol: 'Square' },
    ];

    towerTypes.forEach((tt, idx) => {
      const rr = ttStart + idx;
      const entries: Record<number, Cell> = {
        9: strCell(tt.range),
        10: strCell(tt.code, { fontWeight: 'bold' }),
        11: fmlCell(`COUNTIF(I${firstRow}:I${lastRow},K${rr})`, '#,##0', { align: 'center' }),
        12: strCell(tt.symbol),
      };
      if (idx === 0) {
        entries[2] = strCell('OPGW', { align: 'left', columnSpan: 2, fontWeight: 'bold' });
        entries[4] = fmlCell(`E${asmRow}*${groundWires}`, '#,##0.000');
        entries[5] = fmlCell(`E${rr}*(1+F${opgwSagRow})`, '#,##0.000', { fontWeight: 'bold' });
      }
      data.push(makeRow(entries));
    });

    // Total of Towers row
    data.push(
      makeRow({
        10: strCell('Total of Towers', { fontWeight: 'bold', backgroundColor: '#DCE6F1' }),
        11: fmlCell(`SUM(L${ttStart}:L${ttStart + towerTypes.length - 1})`, '#,##0', {
          align: 'center',
          fontWeight: 'bold',
          backgroundColor: '#DCE6F1',
        }),
      }),
    );
  }

  return {
    data,
    sheet: sheetName,
    orientation: 'landscape',
    stickyRowsCount: 7,
    columns: NGCP_COLUMNS,
  };
}

/**
 * Build a supplementary reference sheet with WGS84 coordinates, PRS92 zones,
 * insulator lengths, headings, ROW corridor widths, and span bearings.
 */
function buildReferenceSheet(
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
  exaggeration: number,
): Sheet<unknown> {
  const ex = exaggeration || 1;
  const list = Object.values(structures).sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
  const head = (v: string): Cell => headCell(v);

  const data: SheetData = [
    [
      'No.', 'Structure type', 'Voltage', 'ROW (±m)', 'PRS92 zone', 'Easting (m)', 'Northing (m)',
      'Latitude (°)', 'Longitude (°)', 'Ground elev. (m)', 'Height (m)', 'Insulator (m)',
      'Heading (°)', 'Line angle (°)', 'Connected to', 'Remarks',
    ].map(head),
    ...list.map((st): Row => {
      const def = DEF_BY_ID[st.defId];
      const c = toPrs92(st.lng, st.lat);
      const ins = insulatorRange(st.defId, st.voltage) ? st.insLen ?? insulatorRange(st.defId, st.voltage)!.std : null;
      const ang = lineAngle(st, structures, spans);
      const remark = angleRemark(st, ang);
      const links = neighbours(st.id, spans)
        .map((n) => structures[n.other])
        .filter(Boolean)
        .sort((a, b) => (a.no ?? 0) - (b.no ?? 0))
        .map((o) => `${structureTag(o)} (${distanceM(st, o).toFixed(0)} m)`)
        .join(', ');
      const vSpec = VOLTAGES[st.voltage];
      return [
        strCell(structureTag(st), { align: 'left', fontWeight: 'bold' }),
        strCell(def.name, { align: 'left' }),
        strCell(def.voltages === 'any' ? '—' : vSpec.label),
        def.voltages === 'any' ? strCell('—') : numCell(vSpec.rowHalfWidthM, '0.0', { align: 'center' }),
        strCell(`PTM Zone ${c.zone.roman}`),
        numCell(c.easting, '#,##0.000'),
        numCell(c.northing, '#,##0.000'),
        numCell(st.lat, '0.000000'),
        numCell(st.lng, '0.000000'),
        numCell(st.elev / ex, '0.0'),
        numCell(modelOf(st).height, '0.0'),
        ins == null ? strCell('—') : numCell(ins, '0.00'),
        numCell(st.rotation, '0.0'),
        ang == null ? strCell('—') : numCell(ang, '0.0', remark ? { textColor: '#B91C1C', fontWeight: 'bold' } : {}),
        strCell(links, { align: 'left' }),
        strCell(remark ?? '', { align: 'left', ...(remark ? { textColor: '#B91C1C', fontWeight: 'bold' } : {}) }),
      ];
    }),
  ];

  // Add a compact Spans summary table right below
  const spanList = Object.values(spans)
    .map((sp) => ({ sp, A: structures[sp.a], B: structures[sp.b] }))
    .filter((r) => r.A && r.B)
    .sort(
      (x, y) =>
        Math.min(x.A.no ?? 0, x.B.no ?? 0) - Math.min(y.A.no ?? 0, y.B.no ?? 0) ||
        Math.max(x.A.no ?? 0, x.B.no ?? 0) - Math.max(y.A.no ?? 0, y.B.no ?? 0),
    );
  if (spanList.length > 0) {
    data.push([], ['From', 'To', 'Voltage', 'ROW (±m)', 'Span length (m)', 'Bearing (°)'].map(head));
    for (const { sp, A, B } of spanList) {
      const [P, Q] = (A.no ?? 0) <= (B.no ?? 0) ? [A, B] : [B, A];
      const vSpec = VOLTAGES[sp.voltage];
      data.push([
        strCell(structureTag(P), { fontWeight: 'bold' }),
        strCell(structureTag(Q), { fontWeight: 'bold' }),
        strCell(vSpec.label),
        numCell(vSpec.rowHalfWidthM, '0.0', { align: 'center' }),
        numCell(distanceM(P, Q), '#,##0.0'),
        numCell(bearingDeg(P, Q), '0.0'),
      ]);
    }
  }

  return {
    data,
    sheet: 'Coordinates & Spans',
    orientation: 'landscape',
    stickyRowsCount: 1,
    columns: [
      { width: 12 }, { width: 32 }, { width: 10 }, { width: 10 }, { width: 14 },
      { width: 15 }, { width: 14 }, { width: 12 }, { width: 13 }, { width: 12 },
      { width: 10 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 36 }, { width: 38 },
    ],
  };
}

/**
 * Build the complete workbook sheets array for `writeXlsxFile(...)`.
 * Exports each contiguous alignment chain as an NGCP Tower Schedule sheet with
 * live formulas, plus a Coordinates & Spans reference sheet.
 */
export function buildNgcpWorkbookSheets(
  project: string,
  structures: Record<string, Structure>,
  spans: Record<string, Span>,
  exaggeration: number,
): Sheet<unknown>[] {
  const chains = traceAlignmentChains(structures, spans);
  const usedNames = new Set<string>();
  const sheets: Sheet<unknown>[] = [];

  if (chains.length > 0) {
    chains.forEach((ch, idx) => {
      const sts = ch.structureIds.map((id) => structures[id]).filter(Boolean);
      const vLabel = VOLTAGES[ch.voltage].label;
      const lineTitle =
        chains.length === 1
          ? `${project} - ${vLabel} LINE 1`
          : `${project} - LINE ${idx + 1} (${vLabel})`;
      const sheetName = sanitizeSheetName(
        chains.length === 1 ? 'Tower Schedule' : `Line ${idx + 1} (${vLabel})`,
        usedNames,
      );
      sheets.push(buildNgcpLineSheet(lineTitle, sheetName, sts, ch.voltage, exaggeration, true));
    });
  } else {
    // Fallback when structures exist without spans yet
    const all = Object.values(structures).sort((a, b) => (a.no ?? 0) - (b.no ?? 0));
    const sheetName = sanitizeSheetName('Tower Schedule', usedNames);
    sheets.push(buildNgcpLineSheet(project, sheetName, all, null, exaggeration, false));
  }

  const refSheet = buildReferenceSheet(structures, spans, exaggeration);
  refSheet.sheet = sanitizeSheetName(refSheet.sheet ?? 'Coordinates & Spans', usedNames);
  sheets.push(refSheet);

  return sheets;
}
