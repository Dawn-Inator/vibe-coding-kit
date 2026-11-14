import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isNotFound } from "./macos-errors.js";
import { fileSha256 } from "./verified-release.js";

export interface StableHelperSnapshot {
  readonly bytes: Buffer | null;
  readonly mode: number | null;
}

// Inspect the direct parent without resolving it. Ancestor aliases such as
// /var -> /private/var are valid, but install/bin itself must be a directory.
async function stableHelperDirectoryExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(dirname(path));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("GOAL_PROGRESS_STABLE_HELPER_DIRECTORY_UNSAFE");
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function stableHelperMatches(path: string, sha256: string): Promise<boolean> {
  if (!(await stableHelperDirectoryExists(path))) return false;
  try {
    const info = await lstat(path);
    return (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      (info.mode & 0o7777) === 0o700 &&
      (await fileSha256(path)) === sha256
    );
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function captureStableHelper(path: string): Promise<StableHelperSnapshot> {
  if (!(await stableHelperDirectoryExists(path))) return { bytes: null, mode: null };
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error("GOAL_PROGRESS_STABLE_HELPER_UNSAFE");
    return { bytes: await readFile(path), mode: info.mode & 0o7777 };
  } catch (error) {
    if (isNotFound(error)) return { bytes: null, mode: null };
    throw error;
  }
}

async function atomicReplace(
  path: string,
  write: (temporary: string) => Promise<void>,
  mode: number,
): Promise<void> {
  const directory = dirname(path);
  if (!(await stableHelperDirectoryExists(path))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  if (!(await stableHelperDirectoryExists(path))) {
    throw new Error("GOAL_PROGRESS_STABLE_HELPER_DIRECTORY_UNSAFE");
  }
  const temporary = resolve(directory, `.goal-progress-${randomUUID()}.tmp`);
  try {
    await write(temporary);
    await chmod(temporary, mode);
    if (!(await stableHelperDirectoryExists(path))) {
      throw new Error("GOAL_PROGRESS_STABLE_HELPER_DIRECTORY_UNSAFE");
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function installStableHelper(
  path: string,
  source: string,
  sha256: string,
): Promise<boolean> {
  if (await stableHelperMatches(path, sha256)) return false;
  await captureStableHelper(path);
  await atomicReplace(
    path,
    async (temporary) => {
      await copyFile(source, temporary);
      if ((await fileSha256(temporary)) !== sha256)
        throw new Error("GOAL_PROGRESS_STABLE_HELPER_HASH_MISMATCH");
    },
    0o700,
  );
  return true;
}

export async function restoreStableHelper(
  path: string,
  snapshot: StableHelperSnapshot,
): Promise<void> {
  const directoryExists = await stableHelperDirectoryExists(path);
  const bytes = snapshot.bytes;
  if (bytes === null) {
    if (!directoryExists) return;
    await rm(path, { force: true });
    return;
  }
  await atomicReplace(
    path,
    (temporary) => writeFile(temporary, bytes, { flag: "wx" }),
    snapshot.mode ?? 0o700,
  );
}
