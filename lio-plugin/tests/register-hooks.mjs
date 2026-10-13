// Registers a TS resolve hook for unit tests. Use with:
//   node --import ./tests/register-hooks.mjs --test tests/<file>.test.mjs
//
// The source uses bundler-style extensionless imports ("./config"), which
// Vite/WXT resolve but Node does not; this maps them to their .ts file so tests
// can import real modules without changing production import style.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    let target = specifier;
    if (target.startsWith("@/")) {
      target = new URL(`../src/${target.slice(2)}`, import.meta.url).pathname;
    }
    const relative = target.startsWith("./") || target.startsWith("../") || target.startsWith("/");
    const hasExt = /\.[cm]?[jt]sx?$/i.test(target);
    if (relative && !hasExt) {
      const base = target.startsWith("/") ? new URL(`file://${target}`) : new URL(target, context.parentURL);
      const candidateUrl = new URL(`${base.pathname}.ts`, "file://");
      if (existsSync(fileURLToPath(candidateUrl))) {
        return next(candidateUrl.href, context);
      }
    }
    return next(target, context);
  },
});
