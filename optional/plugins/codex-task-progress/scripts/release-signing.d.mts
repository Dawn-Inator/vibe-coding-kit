export const GOAL_PROGRESS_HELPER_SIGNING_IDENTIFIER: "com.codextaskprogress.helper";
export const GOAL_PROGRESS_STARTUP_LISTENER_SIGNING_IDENTIFIER: "com.codextaskprogress.startup-listener";

export interface SigningCandidate {
  identity: string;
  name: string;
}

export interface SigningInspection {
  status: "ready" | "confirmation-required" | "unavailable";
  candidates: SigningCandidate[];
  configPath: string;
  identity?: string;
  warning?: string;
}

export interface ReleaseSigningConfig {
  identity: string;
  source: "environment" | "config" | "ad-hoc-default";
  warning: string | undefined;
}

export function resolveReleaseSigning(options?: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFileImpl?: (path: string, encoding: string) => Promise<string | Buffer>;
}): Promise<ReleaseSigningConfig>;

export function createCodesignArgs(
  identity: string,
  identifier: string,
  binaryPath: string,
): string[];

export function defaultReleaseSigningConfigPath(home?: string): string;

export function parseSigningIdentities(output: string): SigningCandidate[];

export function inspectReleaseSigning(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  runner: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout?: string; stderr?: string };
  readFileImpl?: (path: string, encoding: string) => Promise<string | Buffer>;
}): Promise<SigningInspection>;

export function configureReleaseSigning(options: {
  identity: string;
  replace?: boolean;
  home?: string;
  runner: (
    command: string,
    args: string[],
  ) => { status: number | null; stdout?: string; stderr?: string };
  readFileImpl?: (path: string, encoding: string) => Promise<string | Buffer>;
  mkdirImpl?: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>;
  writeFileImpl?: (
    path: string,
    contents: string,
    options: { encoding: string; mode: number; flag: string },
  ) => Promise<unknown>;
  renameImpl?: (from: string, to: string) => Promise<void>;
  linkImpl?: (existingPath: string, newPath: string) => Promise<void>;
  unlinkImpl?: (path: string) => Promise<void>;
  rmImpl?: (path: string, options: { force: true }) => Promise<unknown>;
}): Promise<{ status: "configured"; identity: string; configPath: string; changed: boolean }>;
