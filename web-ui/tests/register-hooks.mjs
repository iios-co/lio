// Registers a TS resolve hook for unit tests. Use with:
//   node --import ./tests/register-hooks.mjs --test tests/<file>.test.mjs
//
// The source uses bundler-style extensionless imports ("./config"), which
// Vite/WXT resolve but Node does not; this maps them to their .ts file so tests
// can import real modules without changing production import style.
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExt = /\.[cm]?[jt]sx?$/i.test(specifier);
    if (relative && !hasExt) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        /* fall through to default resolution */
      }
    }
    return next(specifier, context);
  },
});
