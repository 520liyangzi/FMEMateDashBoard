import { buildPrintTrend, PRINT_CHART, type PrintTrendDatum } from '../lib/print-chart.ts';

export type PrintTrendChartProps = {
  data: PrintTrendDatum[];
  primaryLabel: string;
  secondaryLabel?: string;
  title: string;
  lang: 'zh' | 'en';
};

/** A fully rendered vector chart for print/PDF; no resizing or animation race at print time. */
export default function PrintTrendChart({ data, primaryLabel, secondaryLabel, title, lang }: PrintTrendChartProps) {
  const chart = buildPrintTrend(data);
  return <div className="print-trend-chart">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 230" width="900" height="230" preserveAspectRatio="xMidYMid meet" role="img" aria-label={title}>
      <title>{title}</title>
      {!chart.points.length ? <text x="450" y="115" textAnchor="middle" fill="#718590" fontSize="14">{lang === 'zh' ? '当前范围暂无记录' : 'No records in the selected range'}</text> : <>
        <g fontFamily="inherit" fontSize="14" fill="#4e6774">
          <line x1="62" y1="14" x2="84" y2="14" stroke="#0d8d7c" strokeWidth="2.5"/>
          <text x="91" y="18">{primaryLabel}</text>
          {secondaryLabel && <><line x1="450" y1="14" x2="472" y2="14" stroke="#6c89bb" strokeWidth="2" strokeDasharray="5 4"/><text x="479" y="18">{secondaryLabel}</text></>}
        </g>
        <g fontFamily="inherit" fontSize="13" fill="#617782">
          {chart.yTicks.map(tick => <g key={tick.value}><line x1={PRINT_CHART.left} x2={PRINT_CHART.right} y1={tick.y} y2={tick.y} stroke="#dce5e8" strokeDasharray="3 4"/><text x="51" y={tick.y + 4} textAnchor="end">{tick.label}</text></g>)}
          {chart.xTicks.map(tick => <text key={tick.date} x={tick.x} y="208" textAnchor="middle">{tick.date}</text>)}
        </g>
        {chart.area && <polygon points={chart.area} fill="#e6f3ee"/>}
        <polyline points={chart.primaryLine} fill="none" stroke="#0d8d7c" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
        {chart.points.length === 1 && <circle cx={chart.points[0].x} cy={chart.points[0].primaryY} r="3.5" fill="#0d8d7c"/>}
        {secondaryLabel && chart.secondarySegments.map((segment, index) => <g key={index}><polyline points={segment.map(point => `${point.x},${point.secondaryY}`).join(' ')} fill="none" stroke="#6c89bb" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round"/>{segment.length === 1 && <circle cx={segment[0].x} cy={segment[0].secondaryY} r="3" fill="#6c89bb"/>}</g>)}
      </>}
    </svg>
  </div>;
}
