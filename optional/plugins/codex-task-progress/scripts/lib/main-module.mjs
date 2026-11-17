import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Plugin-local copy of the Kit helper (src/lib/main-module.mjs). The plugin ships its scripts/ and bundles its
// TypeScript entries without the Kit's src/lib on a stable relative path, so it carries its own tiny copy.

/** Return true only when the canonical file at argv1 is the module being checked. */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1 || !moduleUrl) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
