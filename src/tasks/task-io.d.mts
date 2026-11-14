/** Whether an exact-mode private path still needs chmod for ownership enforcement. */
export function privateModeNeedsChmod(info: { mode: number; uid?: number }, mode: number, uid?: number): boolean;
/** Ensure a private directory exists with owner-only permissions. */
export function ensurePrivateDirectory(path: string): Promise<void>;
/** Atomically replace a file with private, durable contents. */
export function atomicWriteFile(path: string, contents: string, faults?: { beforeRename?: () => void | Promise<void> }): Promise<void>;
/** Synchronous durable atomic replacement; default permissions are owner-only. */
export function atomicWriteFileSync(path: string, contents: string, options?: { mode?: number; beforeRename?: () => void }): void;
/** Create a private file only when absent; return false without changing an existing file. */
export function atomicCreateFile(path: string, contents: string): Promise<boolean>;
/** Synchronously create a private file durably and exclusively. */
export function atomicCreateFileSync(path: string, contents: string, options?: { mode?: number }): boolean;
/** Append and durably sync one newline-terminated record. */
export function appendDurableLine(path: string, line: string): Promise<void>;
