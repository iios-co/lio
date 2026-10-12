import { useId } from "react";

export function Logo({
  size = 36,
  withWordmark = true,
}: {
  size?: number;
  withWordmark?: boolean;
}) {
  const id = useId().replace(/:/g, "_");
  const bgId = `lio-bg-${id}`;
  const lGradId = `lio-lgrad-${id}`;
  const oGradId = `lio-ograd-${id}`;
  const dotGradId = `lio-dotgrad-${id}`;
  const glowId = `lio-glow-${id}`;

  return (
    <span className="inline-flex items-center gap-2.5 select-none">
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        fill="none"
        aria-label="Lio"
        role="img"
        className="shrink-0"
      >
        <defs>
          <linearGradient id={bgId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0c0d14" />
            <stop offset="100%" stopColor="#050508" />
          </linearGradient>
          <linearGradient id={lGradId} x1="0%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stopColor="#00d2ff" />
            <stop offset="40%" stopColor="#0084ff" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
          <linearGradient id={oGradId} x1="0%" y1="20%" x2="100%" y2="80%">
            <stop offset="0%" stopColor="#0084ff" />
            <stop offset="60%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#c084fc" />
          </linearGradient>
          <linearGradient id={dotGradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00c6ff" />
            <stop offset="100%" stopColor="#0072ff" />
          </linearGradient>
          <filter id={glowId} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="12" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <rect x="16" y="16" width="480" height="480" rx="110" ry="110" fill={`url(#${bgId})`} />
        <rect x="16" y="16" width="480" height="480" rx="110" ry="110" stroke="#1f2233" strokeWidth="4" fill="none" />

        <g filter={`url(#${glowId})`}>
          <path
            d="M 100 80 L 100 375 A 55 55 0 0 0 155 430 L 270 430"
            stroke={`url(#${lGradId})`}
            strokeWidth="54"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          <path
            d="M 235 185 A 115 115 0 1 1 228 275"
            stroke={`url(#${oGradId})`}
            strokeWidth="54"
            strokeLinecap="round"
            fill="none"
          />
          <circle cx="325" cy="240" r="38" fill={`url(#${dotGradId})`} />
        </g>
      </svg>
      {withWordmark && (
        <span className="text-xl font-bold tracking-tight logo-gradient">Lio</span>
      )}
    </span>
  );
}
