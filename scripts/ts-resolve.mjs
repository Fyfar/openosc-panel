// Lets the check scripts import src/*.ts the way the app does (extensionless, `./io` = io/index.ts).
// Node strips the types itself. Used as: node --import ./scripts/ts-resolve.mjs scripts/check-x.mts
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const ext of ['.ts', '/index.ts']) {
        try { return next(specifier + ext, context); } catch { /* try the next form */ }
      }
    }
    return next(specifier, context);
  },
});
