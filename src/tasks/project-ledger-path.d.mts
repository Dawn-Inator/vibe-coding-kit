import type { Stats } from 'node:fs';

export class ProjectLedgerPathError extends Error {
	code: string;
	constructor(code: string, message: string);
}
export function isProjectPathWithinRoot(root: string, candidate: string): boolean;
export function isNestedGitProject(root: string, directory: string): Promise<boolean>;
/** root must be canonical; create a fresh instance for each discovery scan. */
export function createProjectLedgerPathScan(root: string): {
	/** Entries must come from a fresh successful readdir of this canonical directory. */
	isNestedListedCanonical(directory: string, entries: Array<{ name: string }>): Promise<boolean>;
	/** The argument must be a freshly resolved canonical path. */
	isNestedCanonical(directory: string): Promise<boolean>;
	isNested(directory: string): Promise<boolean>;
	resolve(candidate: string): Promise<{ path: string; info: Stats }>;
};
export function resolveProjectLedgerPath(root: string, candidate: string): Promise<{ path: string; info: Stats }>;
export function resolveProjectLedgerPathSync(root: string, candidate: string): { path: string; info: Stats };
export function validateProjectLedgerSidecarSync(root: string, candidate: string): { path: string; info?: Stats; exists: boolean };
