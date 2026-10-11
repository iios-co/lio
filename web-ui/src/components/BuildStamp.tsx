import { useQuery } from "@tanstack/react-query";
import { admin } from "../api";

// The single place build identity is rendered. Shown on EVERY page, ALWAYS with
// both halves: `server v<x>` from GET /version, and `ui <stamp>` baked in at
// build time by vite.config.ts. There is deliberately no opt-out — the
// collection pages used to suppress the server half, so exactly the screens you
// spend time on were the ones that could not tell you which server build they
// were talking to.
export function BuildStamp() {
  const { data } = useQuery({
    queryKey: ["server-version"],
    queryFn: () => admin.version(),
    staleTime: 10_000,
  });
  return (
    <span className="text-[11px] text-fg-subtle font-mono whitespace-nowrap">
      server {data?.display ?? "…"}
    </span>
  );
}
