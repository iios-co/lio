import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { coll } from "../api";
import type { CollectionSummary } from "../types";
import { navigate } from "../router";
import { TabsPanel } from "./TabsPanel";
import { BuildStamp } from "./BuildStamp";
import { useCollectionWebSocket } from "../lib/useCollectionWebSocket";

// Route: #/c/<token>/tabs. Deliberately the same page shell as BookmarksPage —
// same header slots, same content container — so the two pages read as siblings.
export function TabsPage({ collection }: { collection: CollectionSummary }) {
  const token = collection.token;
  useCollectionWebSocket(token);
  const [q, setQ] = useState("");
  const { data, refetch, isFetching } = useQuery({
    queryKey: ["sessions", token],
    queryFn: () => coll.sessions(token),
  });
  const sessions = data?.sessions ?? [];
  const tabTotal = sessions.reduce((n, s) => n + (s.tab_count ?? 0), 0);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-border bg-[color-mix(in_srgb,var(--bg)_75%,transparent)] backdrop-blur-xl">
        <div className="max-w-6xl mx-auto px-5 py-3.5 flex items-center gap-3">
          <button onClick={() => navigate({ name: "collections" })}
            className="btn-ghost btn-sm" title="Back to collections">← Collections</button>
          <span className="text-lg font-semibold text-fg">{collection.name || "Untitled"}</span>
          <span className="text-xs text-fg-subtle">
            {tabTotal} tab{tabTotal === 1 ? "" : "s"} · {sessions.length} device
            {sessions.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-3">
            <BuildStamp />
            <button onClick={() => navigate({ name: "bookmarks", token })}
              className="btn-ghost btn-sm" title="View bookmarks">‹ Bookmarks</button>
          </div>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-5 py-5">
        <div className="flex items-center gap-2 mb-4">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search tabs…"
            className="field flex-1"
          />
          <button onClick={() => refetch()} disabled={isFetching}
            className="btn-ghost accent-magenta">
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <TabsPanel token={token} query={q} />
      </main>
    </div>
  );
}
