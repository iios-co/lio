// The Lio mark: gradient "LI" wordmark + an animated orbital ring "O".
// A rotating gradient arc with a leading dot orbits a soft core — the
// signature element from the design reference, done as crisp animated SVG.

export function Logo({ size = 36, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  const ringId = "lio-ring-grad";
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        aria-label="Lio"
        role="img"
      >
        <defs>
          <linearGradient id={ringId} x1="0" y1="0" x2="48" y2="48">
            <stop offset="0%" stopColor="#7aa2f7" />
            <stop offset="50%" stopColor="#7dcfff" />
            <stop offset="100%" stopColor="#bb9af7" />
          </linearGradient>
          <filter id="lio-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* faint track */}
        <circle cx="24" cy="24" r="16" stroke="var(--border-bright)" strokeWidth="2.5" opacity="0.5" />

        {/* rotating gradient arc + leading dot */}
        <g style={{ transformOrigin: "24px 24px" }} className="spin" filter="url(#lio-glow)">
          <path
            d="M24 8 a16 16 0 0 1 14.9 10.2"
            stroke={`url(#${ringId})`}
            strokeWidth="3"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="24" cy="8" r="2.6" fill="#7dcfff" />
        </g>

        {/* core */}
        <circle cx="24" cy="24" r="5.5" fill={`url(#${ringId})`} opacity="0.9" filter="url(#lio-glow)" />
      </svg>
      {withWordmark && (
        <span className="text-xl font-bold tracking-tight logo-gradient">Lio</span>
      )}
    </span>
  );
}
