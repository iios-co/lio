// A soft area sparkline for card footers — decorative "activity" motif.
// Deterministic from a seed so a given card's wave is stable across renders.

function wave(seed: number, points = 24): number[] {
  const out: number[] = [];
  let x = seed % 100;
  for (let i = 0; i < points; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push((x % 1000) / 1000);
  }
  return out;
}

export function Sparkline({
  seed = 1,
  color = "var(--blue)",
  width = 220,
  height = 34,
}: {
  seed?: number;
  color?: string;
  width?: number;
  height?: number;
}) {
  const pts = wave(seed);
  const step = width / (pts.length - 1);
  const y = (v: number) => height - 4 - v * (height - 10);
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"} ${i * step} ${y(v)}`).join(" ");
  const area = `${line} L ${width} ${height} L 0 ${height} Z`;
  const gid = `spark-${seed}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" opacity="0.7" />
    </svg>
  );
}
