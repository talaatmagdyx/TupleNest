import { chartData, linePath, type ChartColumn, type ChartKind } from "../lib/chart";

const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });

/**
 * A bar, line or single-number chart of rows already in hand — a dashboard
 * chart's or a notebook cell's. The bars are the result tab's own
 * (`.chart-row`); the line is one SVG path, labelled for a screen reader with
 * its first and last points.
 */
export default function ChartView(p: { kind: ChartKind; columns: ChartColumn[]; rows: unknown[][] }) {
  const data = chartData(p.kind, p.columns, p.rows);
  if (!data) {
    return (
      <div className="center-note chart-empty">
        {p.kind === "number"
          ? "A single number needs a numeric value in the first row."
          : "This chart needs one text column and one numeric column."}
      </div>
    );
  }
  if (data.kind === "number") {
    return (
      <div className="chart-number">
        <span className="chart-big">{fmt(data.value)}</span>
        <span className="chart-sub">{data.title}</span>
      </div>
    );
  }
  if (data.points.length === 0) return <div className="center-note chart-empty">No rows to chart.</div>;
  if (data.kind === "line") {
    const first = data.points[0];
    const last = data.points[data.points.length - 1];
    return (
      <div className="chart-line">
        <div className="chart-sub">{data.title}</div>
        <svg
          viewBox="0 0 600 140"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Line chart of ${data.title}, ${data.points.length} points, from ${fmt(first.v)} at ${first.label} to ${fmt(last.v)} at ${last.label}`}
        >
          <path d={linePath(data.points, 600, 136)} />
        </svg>
      </div>
    );
  }
  const max = Math.max(...data.points.map((x) => x.v), 1);
  return (
    <div className="chart-bars">
      <div className="chart-sub">{data.title}</div>
      {data.points.map((d) => (
        <div key={d.label} className="chart-row">
          <div className="lbl" title={d.label}>
            {d.label}
          </div>
          <div className="track">
            <div className="fill" style={{ width: `${Math.max(0, (d.v / max) * 100)}%` }} />
          </div>
          <div className="val">{fmt(d.v)}</div>
        </div>
      ))}
    </div>
  );
}
