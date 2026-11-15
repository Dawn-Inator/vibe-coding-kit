export interface PresentationSnapshot<T> {
  value: T | null;
  pending: boolean;
  error: unknown | null;
  updatedAt: number | null;
}
export interface ReadOnlySnapshotCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  now?: () => number;
}
/** In-memory display cache only; keys must be supplied by a verified host. */
export class ReadOnlySnapshotCache<T = unknown> {
  constructor(options?: ReadOnlySnapshotCacheOptions);
  read(key: string, loader: () => T | PromiseLike<T>): PresentationSnapshot<T>;
  peek(key: string): PresentationSnapshot<T>;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}
/** Inputs must already be canonical and verified by the caller. */
export function taskPresentationScope(input: { threadId: string; cwd: string; projectRoot: string }): string;
