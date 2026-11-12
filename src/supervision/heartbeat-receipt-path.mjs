// Resolve dispatch receipts identically for receipt validation and current-wake dispatch counts.
// Path strings are not identities: existing files resolve through symlinks to their real path.
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export function receiptBaseDir(options = {}) {
  return resolve(options.baseDir || (options.ledgerPath ? dirname(resolve(options.ledgerPath)) : process.cwd()));
}

export function resolveReceiptPathIdentity(ref, options = {}) {
  const baseDir = receiptBaseDir(options);
  const path = isAbsolute(ref) ? resolve(ref) : resolve(baseDir, ref);
  try {
    const realPath = realpathSync(path);
    return { path: realPath, identity: realPath, exists: true, error: null };
  } catch (error) {
    // The caller still reads the resolved path and reports missing/invalid receipts as red.
    // A lexical identity is useful only for deterministic counting while the validation finding
    // makes the certification fail closed.
    return { path, identity: path, exists: false, error };
  }
}
