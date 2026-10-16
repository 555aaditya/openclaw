// Carapace stepped sparkline: the caller supplies values and tone; the vendored
// oc-sparkline classes own stroke and size. Stepped segments, not splines.
import { createMemo } from "solid-js";
import "../../styles/carapace-data.css";

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

/** A daily trend beside its totals; the tone is the series color. */
export function StepSparkline(props: { values: number[]; color: string; label: string }) {
  const path = createMemo(() => steppedPath(props.values, SPARK_WIDTH, SPARK_HEIGHT));
  return (
    <svg
      class="oc-sparkline"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <path class="oc-sparkline-line" style={{ stroke: props.color }} d={path()} />
    </svg>
  );
}
