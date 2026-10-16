// Carapace data marks for the usage overview: the page computes geometry, the
// vendored oc-* classes own stroke, tone and readout. Stepped segments, not splines.
import { createMemo, createSignal, For, Show } from "solid-js";

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 28;

function steppedPath(values: number[], width: number, height: number): string {
  const max = Math.max(...values, 0);
  if (values.length === 0 || max <= 0) {
    return `M0 ${height - 1} H${width}`;
  }
  const step = width / values.length;
  const y = (value: number) => (height - 2 - (value / max) * (height - 4) + 1).toFixed(1);
  return values
    .map(
      (value, index) =>
        `${index === 0 ? `M0 ${y(value)}` : `V${y(value)}`} H${((index + 1) * step).toFixed(1)}`,
    )
    .join(" ");
}

/** A provider's daily trend beside its totals; the tone is the provider's series color. */
export function StepSparkline(props: { values: number[]; color: string; label: string }) {
  const path = createMemo(() => steppedPath(props.values, SPARK_WIDTH, SPARK_HEIGHT));
  return (
    <svg
      class="oc-sparkline usage-sparkline"
      style={{ "--oc-chart-color": props.color }}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <path class="oc-sparkline-line" d={path()} />
    </svg>
  );
}

const COLUMN_HEIGHT = 120;

export type ColumnSeries = { id: string; label: string; color: string; values: number[] };

/** Daily totals as square columns, stacked by provider in each provider's tone. */
export function DailyColumns(props: {
  dates: string[];
  series: ColumnSeries[];
  label: string;
  formatValue: (value: number) => string;
  formatDate: (date: string) => string;
}) {
  // An object, not the raw index: index 0 must still count as hovering.
  const [hover, setHover] = createSignal<{ index: number } | null>(null);
  const totals = createMemo(() =>
    props.dates.map((_, index) =>
      props.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
    ),
  );
  const max = createMemo(() => Math.max(...totals(), 0));
  // Largest provider sits on the baseline; each day stacks the same order.
  const days = createMemo(() =>
    props.dates.map((_, index) => {
      let top = COLUMN_HEIGHT;
      return props.series.flatMap((series) => {
        const value = series.values[index] ?? 0;
        if (max() <= 0 || value <= 0) {
          return [];
        }
        const height = Math.max(1, (value / max()) * COLUMN_HEIGHT);
        top -= height;
        return [{ id: series.id, color: series.color, y: top, height }];
      });
    }),
  );
  const pointer = (event: PointerEvent) => {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * props.dates.length);
    setHover({ index: Math.min(props.dates.length - 1, Math.max(0, index)) });
  };
  const left = (index: number) => `${((index + 0.5) / props.dates.length) * 100}%`;
  return (
    <div class="oc-chart-hover usage-columns">
      <svg
        viewBox={`0 0 ${props.dates.length * 10} ${COLUMN_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={props.label}
        onPointerMove={pointer}
        onPointerLeave={() => setHover(null)}
      >
        <For each={days()}>
          {(segments, index) => (
            <g
              class={[
                "usage-columns__day",
                { "usage-columns__day--dim": hover() !== null && hover()?.index !== index() },
              ]}
            >
              <For each={segments}>
                {(segment, position) => (
                  <rect
                    class="usage-columns__bar"
                    style={{ "--oc-chart-color": segment.color }}
                    x={index() * 10 + 1}
                    y={segment.y}
                    width="8"
                    // A surface seam between stacked providers keeps them distinct.
                    height={Math.max(0.5, segment.height - (position() > 0 ? 0.6 : 0))}
                  />
                )}
              </For>
            </g>
          )}
        </For>
      </svg>
      <div class="usage-columns__axis" aria-hidden="true">
        <span>{props.dates[0] ? props.formatDate(props.dates[0]) : ""}</span>
        <span>{props.dates.at(-1) ? props.formatDate(props.dates.at(-1)!) : ""}</span>
      </div>
      <Show when={hover()}>
        {(point) => (
          <>
            <span class="oc-chart-cursor" style={{ left: left(point().index) }} />
            <span
              class="oc-chart-tip usage-columns__tip"
              role="status"
              style={{ left: left(point().index) }}
            >
              <strong>
                {props.formatDate(props.dates[point().index] ?? "")} ·{" "}
                {props.formatValue(totals()[point().index] ?? 0)}
              </strong>
              <For each={props.series.filter((series) => (series.values[point().index] ?? 0) > 0)}>
                {(series) => (
                  <span>
                    <i class="oc-split-key" style={{ "--oc-chart-color": series.color }} />
                    {series.label} {props.formatValue(series.values[point().index] ?? 0)}
                  </span>
                )}
              </For>
            </span>
          </>
        )}
      </Show>
    </div>
  );
}

export type ShareSegment = {
  id: string;
  label: string;
  color: string;
  value: number;
  text: string;
};

/** One composition row: every provider's share of the selected measure. */
export function ShareBar(props: { segments: ShareSegment[]; label: string }) {
  const total = createMemo(() => props.segments.reduce((sum, segment) => sum + segment.value, 0));
  const placed = createMemo(() => {
    let x = 0;
    return props.segments
      .filter((segment) => segment.value > 0)
      .map((segment) => {
        const width = total() > 0 ? (segment.value / total()) * 100 : 0;
        const entry = { segment, x, width };
        x += width;
        return entry;
      });
  });
  return (
    <div class="usage-share">
      <svg
        class="oc-split"
        viewBox="0 0 100 4"
        preserveAspectRatio="none"
        role="img"
        aria-label={props.label}
      >
        <For each={placed()}>
          {(entry) => (
            <rect
              class="oc-split-segment"
              style={{ "--oc-chart-color": entry.segment.color }}
              x={entry.x}
              y="0"
              // A surface gap between segments keeps neighbors distinct.
              width={Math.max(0, entry.width - 0.4)}
              height="4"
            />
          )}
        </For>
      </svg>
      <ul class="oc-split-legend">
        <For each={props.segments}>
          {(segment) => (
            <li>
              <span class="oc-split-key" style={{ "--oc-chart-color": segment.color }} />
              {segment.label}
              <b>{segment.text}</b>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
