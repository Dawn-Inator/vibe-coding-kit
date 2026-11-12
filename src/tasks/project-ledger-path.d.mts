import type { Stats } from 'node:fs';

export class ProjectLedgerPathError extends Error {
	code: string;
	constructor(code: string, message: string);
}
export function isProjectPathWithinRoot(root: string, candidate: string): boolean;
export function isNestedGitProject(root: string, directory: string): Promise<boolean>;
export function resolveProjectLedgerPath(root: string, candidate: string): Promise<{ path: string; info: Stats }>;
export function resolveProjectLedgerPathSync(root: string, candidate: string): { path: string; info: Stats };
export function validateProjectLedgerSidecarSync(root: string, candidate: string): { path: string; info?: Stats; exists: boolean };
