// The Lio mark: gradient wordmark + an animated orbital ring "O".

export function Logo({
  size = 30,
  withWordmark = true,
  active = false,
}: {
  size?: number;
  withWordmark?: boolean;
  active?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role="img" aria-label="Lio">
        <defs>
          <linearGradient id="lioR" x1="0" y1="0" x2="48" y2="48">
            <stop offset="0%" stopColor="#7aa2f7" />
            <stop offset="50%" stopColor="#7dcfff" />
            <stop offset="100%" stopColor="#bb9af7" />
          </linearGradient>
          <filter id="lioG" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <circle cx="24" cy="24" r="16" stroke="var(--border-bright)" strokeWidth="2.5" opacity="0.5" />
        {/* The ring only spins while `active` (a sync is in flight); otherwise
            it sits still, angled, as a static mark. */}
        <g style={{ transformOrigin: "24px 24px" }} className={active ? "spin" : ""} filter="url(#lioG)">
          <path d="M24 8 a16 16 0 0 1 14.9 10.2" stroke="url(#lioR)" strokeWidth="3" strokeLinecap="round" fill="none" />
          <circle cx="24" cy="8" r="2.6" fill="#7dcfff" />
        </g>
        <circle cx="24" cy="24" r="5.5" fill="url(#lioR)" opacity="0.9" filter="url(#lioG)" />
      </svg>
      {withWordmark && <span className="text-lg font-bold tracking-tight logo-gradient">Lio</span>}
    </span>
  );
}

export function relTime(ms: number | null | undefined): string {
  if (!ms) return "never";
  const d = Date.now() - ms;
  const min = Math.round(d / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}
