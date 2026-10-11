// Circular stat donut. `value` is 0..1. Pass `stops` for a gradient arc.
// The glow is a circular box-shadow on a rounded-full wrapper (an SVG
// drop-shadow filter renders a square halo, which we deliberately avoid).

export function ProgressRing({
  value,
  color = "var(--blue)",
  stops,
  size = 76,
  stroke = 6,
  children,
}: {
  value: number;
  color?: string;
  stops?: [string, string];
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, value));
  // A round linecap turns a sub-pixel arc into a floating dot, so floor any
  // non-zero value to a visible sliver; a true zero draws no arc at all.
  const shown = clamped === 0 ? 0 : Math.max(clamped, 0.06);
  const dash = c * shown;
  const gid = `ring-${(stops ? stops.join("") : color).replace(/[^a-z0-9]/gi, "")}`;
  const arc = stops ? `url(#${gid})` : color;

  return (
    <div
      className="relative grid place-items-center rounded-full"
      style={{
        width: size,
        height: size,
        boxShadow: `0 0 20px -4px ${color}`,
        background: `radial-gradient(circle at 50% 50%, color-mix(in srgb, ${color} 8%, transparent), transparent 72%)`,
      }}
    >
      <svg width={size} height={size} className="-rotate-90 block">
        {stops && (
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={stops[0]} />
              <stop offset="100%" stopColor={stops[1]} />
            </linearGradient>
          </defs>
        )}
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={arc}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          style={{ transition: "stroke-dasharray 0.5s ease" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center" style={{ color }}>
        {children}
      </div>
    </div>
  );
}
