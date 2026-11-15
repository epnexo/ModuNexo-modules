const PAD = 2;
const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * The `points` attribute of a polyline that draws `values` across `width` by `height`, high values at the top.
 * The scale runs from the lowest to the highest value, or from 0 to `max` when given (so 50% is always half way).
 * Fewer than two values draw nothing; a flat series sits in the middle.
 */
export function sparkPoints(values: number[], width: number, height: number, max?: number): string {
  if (values.length < 2) return "";
  const low = max === undefined ? Math.min(...values) : 0;
  const high = max === undefined ? Math.max(...values) : max;
  const span = high - low;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const ratio = span === 0 ? 0.5 : Math.min(1, Math.max(0, (value - low) / span));
      return `${round(index * step)},${round(height - PAD - ratio * (height - 2 * PAD))}`;
    })
    .join(" ");
}
