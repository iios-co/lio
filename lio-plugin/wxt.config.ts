import { defineConfig } from "wxt";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Auto-bump the manifest patch version on every production build so each reload
// is distinguishable and a stale load is obvious on sight. The bumped number is
// persisted back to package.json. Set BUILD_BUMP=0 to pin (e.g. for release), or
// BUILD_VERSION to force an exact version.
function resolveVersion(): string {
  if (process.env.BUILD_VERSION) {
    return process.env.BUILD_VERSION;
  }
  const pkgPath = fileURLToPath(new URL("./package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  if (process.env.BUILD_BUMP === "0" || process.env.NODE_ENV !== "production") {
    return pkg.version;
  }
  const [maj = 0, min = 0, patch = 0] = pkg.version.split(".").map((n) => parseInt(n, 10) || 0);
  const next = `${maj}.${min}.${patch + 1}`;
  pkg.version = next;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  return next;
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: "src",
  manifest: () => ({
    version: resolveVersion(),
    name: "Lio — Bookmark & Tab Sync",
    description:
      "Sync bookmarks and tab sessions across browsers and devices via a self-hosted lio-server.",
    permissions: ["bookmarks", "tabs", "storage", "alarms"],
    host_permissions: ["http://*/*", "https://*/*"],
    action: {
      default_title: "Lio",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
      },
    },
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    browser_specific_settings: {
      gecko: {
        id: "lio@iios.co",
        strict_min_version: "109.0",
        data_collection_permissions: {
          required: ["bookmarksInfo", "browsingActivity"],
        },
      },
    },
  }),
});
