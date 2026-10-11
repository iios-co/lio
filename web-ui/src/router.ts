// Minimal hash router. Routes are in the URL hash so the statically-served SPA
// needs no server route config, and browser back/forward work correctly.
//
// Routes:
//   #/                     → collections dashboard
//   #/c/<token>            → collection bookmarks page
//   #/c/<token>/tabs       → collection tabs page

import { useEffect, useState } from "react";

export type Route =
  | { name: "collections" }
  | { name: "bookmarks"; token: string }
  | { name: "tabs"; token: string };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const parts = h.split("/").filter(Boolean); // e.g. ["c","<token>","tabs"]
  if (parts[0] === "c" && parts[1]) {
    const token = decodeURIComponent(parts[1]);
    if (parts[2] === "tabs") return { name: "tabs", token };
    return { name: "bookmarks", token };
  }
  return { name: "collections" };
}

export function navigate(route: Route): void {
  let hash = "#/";
  if (route.name === "bookmarks") hash = `#/c/${encodeURIComponent(route.token)}`;
  else if (route.name === "tabs") hash = `#/c/${encodeURIComponent(route.token)}/tabs`;
  if (location.hash !== hash) location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
