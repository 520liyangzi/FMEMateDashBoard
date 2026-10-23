/** Fixed geometry for print charts: never depends on a measured browser viewport. */
export type PrintTrendDatum = { date: string; primary: number; secondary?: number };
export type PrintTrendPoint = PrintTrendDatum & { x: number; primaryY: number; secondaryY?: number };

export const PRINT_CHART = { width: 900, height: 230, left: 62, right: 838, top: 38, bottom: 184 } as const;
const DAY = 86_400_000;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function timestamp(value: string): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
}

export function formatPrintCount(value: number): string {
  // Only axis labels are abbreviated. Exact values remain in the page's metrics/tables.
  if (value >= 1_000_000_000_000) return `${Number((value / 1_000_000_000_000).toFixed(1))}T`;
  if (value >= 1_000_000_000) return `${Number((value / 1_000_000_000).toFixed(1))}B`;
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 10_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

export function buildPrintTrend(data: readonly PrintTrendDatum[]) {
  const byDate = new Map<string, PrintTrendDatum>();
  for (const row of data) {
    if (timestamp(row.date) === null || !count(row.primary)) continue;
    byDate.set(row.date, { date: row.date, primary: row.primary, ...(count(row.secondary) ? { secondary: row.secondary } : {}) });
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const maximum = rows.reduce((max, row) => Math.max(max, row.primary, row.secondary ?? 0), 0);
  const rawStep = Math.max(maximum, 1) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const step = Math.max(1, (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude);
  const ceiling = Math.max(1, Math.ceil(maximum / step) * step);
  const y = (value: number) => PRINT_CHART.bottom - value / ceiling * (PRINT_CHART.bottom - PRINT_CHART.top);
  const first = rows.length ? timestamp(rows[0].date)! : 0;
  const last = rows.length ? timestamp(rows[rows.length - 1].date)! : first;
  const span = last - first;
  const x = (stamp: number) => span > 0
    ? PRINT_CHART.left + (stamp - first) / span * (PRINT_CHART.right - PRINT_CHART.left)
    : (PRINT_CHART.left + PRINT_CHART.right) / 2;
  const points: PrintTrendPoint[] = rows.map(row => ({
    ...row, x: x(timestamp(row.date)!), primaryY: y(row.primary),
    ...(row.secondary === undefined ? {} : { secondaryY: y(row.secondary) }),
  }));
  const tickCount = rows.length ? Math.min(8, Math.round(span / DAY) + 1) : 0;
  const candidates = Array.from({ length: tickCount }, (_, index) => {
    const offset = tickCount > 1 ? Math.round(span / DAY * index / (tickCount - 1)) * DAY : 0;
    const stamp = first + offset;
    return { date: new Date(stamp).toISOString().slice(0, 10), x: x(stamp) };
  });
  // Rounding temporal ticks to whole dates can put two labels only one day apart.
  // Keep both boundaries, and reserve enough space for every centered ISO label.
  const xTicks: typeof candidates = [];
  for (const [index, tick] of candidates.entries()) {
    if (index === 0 || index === candidates.length - 1 ||
        (tick.x - xTicks[xTicks.length - 1].x >= 100 && candidates[candidates.length - 1].x - tick.x >= 100)) {
      xTicks.push(tick);
    }
  }
  const yTicks = Array.from({ length: Math.round(ceiling / step) + 1 }, (_, index) => {
    const value = index * step;
    return { value, y: y(value), label: formatPrintCount(value) };
  });
  const primaryLine = points.map(point => `${point.x},${point.primaryY}`).join(' ');
  const area = points.length > 1
    ? `${points[0].x},${PRINT_CHART.bottom} ${primaryLine} ${points[points.length - 1].x},${PRINT_CHART.bottom}` : '';
  const secondarySegments: PrintTrendPoint[][] = [];
  let segment: PrintTrendPoint[] = [];
  for (const point of points) {
    if (point.secondaryY !== undefined) segment.push(point);
    else if (segment.length) { secondarySegments.push(segment); segment = []; }
  }
  if (segment.length) secondarySegments.push(segment);
  return { points, primaryLine, area, secondarySegments, xTicks, yTicks, ceiling };
}
