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
      <img
        src="/icons/icon-48.png"
        width={size}
        height={size}
        alt="Lio"
        className={`shrink-0 select-none ${active ? "animate-pulse" : ""}`}
      />
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
