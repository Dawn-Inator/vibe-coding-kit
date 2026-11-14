import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export const GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER = "com.codextaskprogress.helper";
export const GOAL_PROGRESS_STARTUP_LISTENER_SIGNING_IDENTIFIER =
  "com.codextaskprogress.startup-listener";
export const GOAL_PROGRESS_DOCK_LAUNCHER_SIGNING_IDENTIFIER = "com.codextaskprogress.launcher";
export const GOAL_PROGRESS_DOCK_LAUNCHER_APP_SIGNING_IDENTIFIER =
  "com.codextaskprogress.codexlauncher";

const DEFAULT_CONFIG_RELATIVE_PATH =
  "Library/Application Support/CodexTaskProgress/release-signing.json";
const SIGNING_IDENTITY_PATTERN = /^[0-9A-Fa-f]{40}$/u;

export function defaultReleaseSigningConfigPath(home = homedir()) {
  return resolve(home, DEFAULT_CONFIG_RELATIVE_PATH);
}

function validateIdentity(identity, source) {
  if (typeof identity !== "string" || identity.trim().length === 0) {
    throw new Error(`GOAL_PROGRESS_CODESIGN_IDENTITY_INVALID: ${source}`);
  }
  return identity.trim();
}

function parseConfig(contents, path) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_INVALID: ${path}`);
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    Object.keys(value).some((key) => !["schemaVersion", "identity"].includes(key))
  ) {
    throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_INVALID: ${path}`);
  }
  try {
    return validateIdentity(value.identity, "config");
  } catch {
    throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_INVALID: ${path}`);
  }
}

/**
 * Resolve the release signing identity without consulting the Keychain.
 * An absent configuration deliberately retains ad-hoc signing and exposes a warning.
 */
export async function resolveReleaseSigning({
  env = process.env,
  home = homedir(),
  readFileImpl = readFile,
} = {}) {
  if (Object.hasOwn(env, "GOAL_PROGRESS_CODESIGN_IDENTITY")) {
    const identity = validateIdentity(env.GOAL_PROGRESS_CODESIGN_IDENTITY, "environment");
    return {
      identity,
      source: "environment",
      warning:
        identity === "-"
          ? "Ad-hoc signing was explicitly selected; macOS may treat updated releases as a new app for Documents access."
          : undefined,
    };
  }

  const configuredPath = env.GOAL_PROGRESS_CODESIGN_CONFIG;
  const hasExplicitConfig = configuredPath !== undefined;
  if (configuredPath !== undefined && !isAbsolute(configuredPath)) {
    throw new Error("GOAL_PROGRESS_CODESIGN_CONFIG_MUST_BE_ABSOLUTE");
  }
  const path = configuredPath ?? defaultReleaseSigningConfigPath(home);
  let contents;
  try {
    contents = await readFileImpl(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_READ_FAILED: ${path}`);
    }
    if (hasExplicitConfig) {
      throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_MISSING: ${path}`);
    }
    return {
      identity: "-",
      source: "ad-hoc-default",
      warning:
        "No stable macOS signing identity is configured; ad-hoc signing can trigger repeated Documents access prompts after updates. Configure GOAL_PROGRESS_CODESIGN_IDENTITY or the local release-signing.json file.",
    };
  }

  const identity = parseConfig(String(contents), path);
  return {
    identity,
    source: "config",
    warning:
      identity === "-"
        ? "Ad-hoc signing was explicitly selected; macOS may treat updated releases as a new app for Documents access."
        : undefined,
  };
}

function isEligibleIdentityName(name) {
  if (/apple distribution/iu.test(name)) return false;
  return /^(Apple Development|Mac Developer|Developer ID Application):/u.test(name);
}

export function parseSigningIdentities(output) {
  const candidates = [];
  for (const line of String(output).split(/\r?\n/u)) {
    const match = line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/u);
    if (!match || !isEligibleIdentityName(match[2])) continue;
    candidates.push({ identity: match[1].toUpperCase(), name: match[2] });
  }
  return candidates;
}

function matchesCandidate(identity, candidate) {
  return SIGNING_IDENTITY_PATTERN.test(identity)
    ? identity.toUpperCase() === candidate.identity
    : identity === candidate.name;
}

async function readConfiguredSigning({ path, readFileImpl }) {
  let contents;
  try {
    contents = await readFileImpl(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, identity: undefined };
    throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_READ_FAILED: ${path}`);
  }
  return { exists: true, identity: parseConfig(String(contents), path) };
}

export async function inspectReleaseSigning({
  env = process.env,
  home = homedir(),
  runner,
  readFileImpl = readFile,
} = {}) {
  const explicitPath = env.GOAL_PROGRESS_CODESIGN_CONFIG;
  if (explicitPath !== undefined && !isAbsolute(explicitPath)) {
    throw new Error("GOAL_PROGRESS_CODESIGN_CONFIG_MUST_BE_ABSOLUTE");
  }
  const configPath = explicitPath ?? defaultReleaseSigningConfigPath(home);
  if (typeof runner !== "function") throw new Error("GOAL_PROGRESS_CODESIGN_RUNNER_REQUIRED");
  const result = runner("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  if (result.status !== 0) {
    return { status: "unavailable", candidates: [], configPath };
  }
  const candidates = parseSigningIdentities(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);

  let configuredIdentity;
  if (Object.hasOwn(env, "GOAL_PROGRESS_CODESIGN_IDENTITY")) {
    configuredIdentity = validateIdentity(env.GOAL_PROGRESS_CODESIGN_IDENTITY, "environment");
  } else {
    const local = await readConfiguredSigning({ path: configPath, readFileImpl });
    if (explicitPath !== undefined && !local.exists) {
      throw new Error(`GOAL_PROGRESS_CODESIGN_CONFIG_MISSING: ${configPath}`);
    }
    configuredIdentity = local.identity;
  }
  if (configuredIdentity === "-") {
    return {
      status: "ready",
      candidates,
      configPath,
      identity: "-",
      warning:
        "Ad-hoc signing is explicitly selected and may trigger repeated Documents access prompts.",
    };
  }
  if (candidates.length === 0) return { status: "unavailable", candidates, configPath };
  if (configuredIdentity !== undefined) {
    const match = candidates.find((candidate) => matchesCandidate(configuredIdentity, candidate));
    return match
      ? { status: "ready", candidates, configPath, identity: match.identity }
      : { status: "unavailable", candidates, configPath };
  }
  return { status: "confirmation-required", candidates, configPath };
}

export async function configureReleaseSigning({
  identity,
  replace = false,
  home = homedir(),
  runner,
  readFileImpl = readFile,
  mkdirImpl = mkdir,
  writeFileImpl = writeFile,
  renameImpl = rename,
  linkImpl = link,
  unlinkImpl = unlink,
  rmImpl = rm,
} = {}) {
  if (typeof runner !== "function") throw new Error("GOAL_PROGRESS_CODESIGN_RUNNER_REQUIRED");
  if (typeof identity !== "string" || !SIGNING_IDENTITY_PATTERN.test(identity)) {
    throw new Error("GOAL_PROGRESS_CODESIGN_FINGERPRINT_REQUIRED");
  }
  const normalizedIdentity = identity.toUpperCase();
  const signing = await inspectReleaseSigning({ home, runner, readFileImpl, env: {} });
  const candidate = signing.candidates.find(
    ({ identity: candidateIdentity }) => candidateIdentity === normalizedIdentity,
  );
  if (!candidate) throw new Error("GOAL_PROGRESS_CODESIGN_IDENTITY_NOT_ELIGIBLE");

  const path = defaultReleaseSigningConfigPath(home);
  const current = await readConfiguredSigning({ path, readFileImpl });
  if (current.exists) {
    const sameChoice =
      current.identity === normalizedIdentity || matchesCandidate(current.identity, candidate);
    if (sameChoice)
      return {
        status: "configured",
        identity: normalizedIdentity,
        configPath: path,
        changed: false,
      };
    if (!replace) throw new Error("GOAL_PROGRESS_CODESIGN_CONFIG_EXISTS_DIFFERENT_IDENTITY");
  }

  const directory = dirname(path);
  await mkdirImpl(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFileImpl(
      temporaryPath,
      `${JSON.stringify({ schemaVersion: 1, identity: normalizedIdentity }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    await rmImpl(temporaryPath, { force: true }).catch(() => {});
    throw new Error(
      `GOAL_PROGRESS_CODESIGN_CONFIG_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    if (replace) {
      await renameImpl(temporaryPath, path);
    } else {
      try {
        await linkImpl(temporaryPath, path);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const racedConfig = await readConfiguredSigning({ path, readFileImpl });
        const sameChoice =
          racedConfig.exists &&
          (racedConfig.identity === normalizedIdentity ||
            matchesCandidate(racedConfig.identity, candidate));
        if (sameChoice) {
          return {
            status: "configured",
            identity: normalizedIdentity,
            configPath: path,
            changed: false,
          };
        }
        throw new Error("GOAL_PROGRESS_CODESIGN_CONFIG_EXISTS_DIFFERENT_IDENTITY");
      }
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "GOAL_PROGRESS_CODESIGN_CONFIG_EXISTS_DIFFERENT_IDENTITY"
    ) {
      throw error;
    }
    throw new Error(
      `GOAL_PROGRESS_CODESIGN_CONFIG_WRITE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await unlinkImpl(temporaryPath).catch(() => {});
  }
  return { status: "configured", identity: normalizedIdentity, configPath: path, changed: true };
}

export function createCodesignArgs(identity, identifier, binaryPath) {
  const signingIdentity = validateIdentity(identity, "resolved");
  if (
    identifier !== GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER &&
    identifier !== GOAL_PROGRESS_STARTUP_LISTENER_SIGNING_IDENTIFIER &&
    identifier !== GOAL_PROGRESS_DOCK_LAUNCHER_SIGNING_IDENTIFIER &&
    identifier !== GOAL_PROGRESS_DOCK_LAUNCHER_APP_SIGNING_IDENTIFIER
  ) {
    throw new Error("GOAL_PROGRESS_CODESIGN_IDENTIFIER_INVALID");
  }
  return ["--force", "--sign", signingIdentity, "--identifier", identifier, binaryPath];
}
