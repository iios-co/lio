import { useQuery } from "@tanstack/react-query";
import { admin } from "./api";
import type { CollectionSummary } from "./types";
import { AdminSetup } from "./components/AdminSetup";
import { AdminLogin } from "./components/AdminLogin";
import { CollectionsDashboard } from "./components/CollectionsDashboard";
import { BookmarksPage } from "./components/BookmarksPage";
import { TabsPage } from "./components/TabsPage";
import { navigate, useRoute } from "./router";

export function App() {
  const route = useRoute();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["admin-state"],
    queryFn: () =>
      admin.state().catch(() => ({ setup_needed: false, authenticated: false, username: null })),
    retry: false,
    staleTime: Infinity,
  });

  // Collections list — used both by the dashboard and to resolve a token → summary
  // when the user deep-links / navigates to a collection page.
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: () => admin.collections(),
    enabled: !!data?.authenticated,
  });

  if (isLoading || !data) {
    return <div className="h-full grid place-items-center text-fg-subtle">Loading…</div>;
  }
  if (data.setup_needed) return <AdminSetup onDone={() => refetch()} />;
  if (!data.authenticated) return <AdminLogin onLoggedIn={() => refetch()} />;

  if (route.name === "bookmarks" || route.name === "tabs") {
    const list = collections.data?.collections ?? [];
    const found = list.find((c) => c.token === route.token) as CollectionSummary | undefined;
    if (collections.isLoading && !found) {
      return <div className="h-full grid place-items-center text-fg-subtle">Loading…</div>;
    }
    if (!found) {
      // Unknown token in URL — bounce home.
      navigate({ name: "collections" });
      return null;
    }
    return route.name === "tabs" ? (
      <TabsPage collection={found} />
    ) : (
      <BookmarksPage collection={found} />
    );
  }

  return <CollectionsDashboard onLogout={() => refetch()} />;
}
