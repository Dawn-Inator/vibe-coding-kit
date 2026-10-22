import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Return true only when the canonical file at argv1 is the module being checked. */
export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1 || !moduleUrl) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
