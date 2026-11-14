import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { atomicWriteFile } from "../../../packages/store/src/atomic.js";
import type { GoalProgressPaths } from "../../../packages/store/src/paths.js";

export interface CodexStartupRecoveryPolicy {
  readonly schemaVersion: 1;
  readonly autoPrepareOnLaunch: boolean;
}

export type StartupRecoveryPolicyAction = "enable" | "disable";

export const DEFAULT_CODEX_STARTUP_RECOVERY_POLICY: CodexStartupRecoveryPolicy = {
  schemaVersion: 1,
  autoPrepareOnLaunch: false,
};

const policyFileName = "startup-recovery.json";
const maxPolicyBytes = 4096;

function invalidPolicy(): Error {
  return new Error("GOAL_PROGRESS_STARTUP_RECOVERY_CONFIG_INVALID");
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasExpectedOwner(metadata: { readonly uid?: number }): boolean {
  const uid = process.getuid?.();
  return uid === undefined || metadata.uid === undefined || metadata.uid === uid;
}

async function validateDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      !hasExpectedOwner(metadata) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw invalidPolicy();
    }
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function parsePolicy(contents: string): CodexStartupRecoveryPolicy {
  if (Buffer.byteLength(contents, "utf8") > maxPolicyBytes) throw invalidPolicy();
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw invalidPolicy();
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "schemaVersion") ||
    !Object.hasOwn(value, "autoPrepareOnLaunch")
  ) {
    throw invalidPolicy();
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.autoPrepareOnLaunch !== "boolean") {
    throw invalidPolicy();
  }
  return { schemaVersion: 1, autoPrepareOnLaunch: candidate.autoPrepareOnLaunch };
}

export async function readCodexStartupRecoveryPolicy(
  paths: Pick<GoalProgressPaths, "preferencesRoot"> | { readonly preferencesRoot: string },
): Promise<CodexStartupRecoveryPolicy> {
  if (!(await validateDirectory(paths.preferencesRoot))) {
    return DEFAULT_CODEX_STARTUP_RECOVERY_POLICY;
  }
  const path = resolve(paths.preferencesRoot, policyFileName);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return DEFAULT_CODEX_STARTUP_RECOVERY_POLICY;
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    !hasExpectedOwner(metadata) ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > maxPolicyBytes
  ) {
    throw invalidPolicy();
  }
  try {
    return parsePolicy(await readFile(path, "utf8"));
  } catch (error) {
    if (isNotFound(error)) throw invalidPolicy();
    throw error;
  }
}

export async function writeCodexStartupRecoveryPolicy(
  paths: Pick<GoalProgressPaths, "preferencesRoot"> | { readonly preferencesRoot: string },
  action: StartupRecoveryPolicyAction,
): Promise<CodexStartupRecoveryPolicy> {
  const current = await readCodexStartupRecoveryPolicy(paths);
  const requestedValue = action === "enable";
  if (current.autoPrepareOnLaunch === requestedValue) return current;
  const path = resolve(paths.preferencesRoot, policyFileName);
  await validateDirectory(paths.preferencesRoot);
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      !hasExpectedOwner(metadata) ||
      (metadata.mode & 0o077) !== 0 ||
      metadata.size > maxPolicyBytes
    ) {
      throw invalidPolicy();
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const policy: CodexStartupRecoveryPolicy = {
    schemaVersion: 1,
    autoPrepareOnLaunch: action === "enable",
  };
  await atomicWriteFile(path, `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}
