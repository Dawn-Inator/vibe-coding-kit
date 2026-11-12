import { lstat, realpath, stat } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export class ProjectLedgerPathError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ProjectLedgerPathError";
		this.code = code;
	}
}

export const isProjectPathWithinRoot = (root, candidate) => {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Check for an actual nested Git marker, stopping before the trusted project root itself. */
export async function isNestedGitProject(root, directory) {
	const canonicalRoot = resolve(root);
	const canonicalDirectory = await realpath(directory).catch(() => null);
	if (
		!canonicalDirectory ||
		!isProjectPathWithinRoot(canonicalRoot, canonicalDirectory)
	)
		return false;
	let current = canonicalDirectory;
	while (current !== canonicalRoot) {
		if (await lstat(resolve(current, ".git")).catch(() => null)) return true;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

/** Canonicalize and validate one ledger against the current project's Git boundary. */
export async function resolveProjectLedgerPath(root, candidate) {
	const canonicalRoot = await realpath(root);
	const requested = resolve(canonicalRoot, candidate);
	let canonicalPath;
	try {
		canonicalPath = await realpath(requested);
	} catch (error) {
		throw new ProjectLedgerPathError(
			"unreadable",
			`Project ledger path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isProjectPathWithinRoot(canonicalRoot, canonicalPath))
		throw new ProjectLedgerPathError(
			"outside-root",
			"Project ledger path must stay within the project root",
		);
	if (await isNestedGitProject(canonicalRoot, dirname(canonicalPath)))
		throw new ProjectLedgerPathError(
			"nested-git",
			"Project ledger is inside a nested Git project",
		);
	let info;
	try {
		info = await stat(canonicalPath);
	} catch (error) {
		throw new ProjectLedgerPathError(
			"unreadable",
			`Project ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!info.isFile())
		throw new ProjectLedgerPathError(
			"not-file",
			"Project ledger path is not a file",
		);
	return { path: canonicalPath, info };
}

/** Synchronous counterpart for file-only CLIs and the paired heartbeat storage API. */
export function resolveProjectLedgerPathSync(root, candidate) {
	const canonicalRoot = realpathSync(root);
	const requested = resolve(canonicalRoot, candidate);
	let canonicalPath;
	try {
		canonicalPath = realpathSync(requested);
	} catch (error) {
		throw new ProjectLedgerPathError("unreadable", `Project ledger path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isProjectPathWithinRoot(canonicalRoot, canonicalPath))
		throw new ProjectLedgerPathError("outside-root", "Project ledger path must stay within the project root");
	let current = dirname(canonicalPath);
	while (current !== canonicalRoot) {
		if (existsSync(resolve(current, ".git")))
			throw new ProjectLedgerPathError("nested-git", "Project ledger is inside a nested Git project");
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	let info;
	try { info = statSync(canonicalPath); }
	catch (error) { throw new ProjectLedgerPathError("unreadable", `Project ledger cannot be read: ${error instanceof Error ? error.message : String(error)}`); }
	if (!info.isFile()) throw new ProjectLedgerPathError("not-file", "Project ledger path is not a file");
	return { path: canonicalPath, info };
}

/** Validate an existing companion with the same root and nested-Git boundary as a ledger. */
export function validateProjectLedgerSidecarSync(root, candidate) {
	const canonicalRoot = realpathSync(root);
	const requested = resolve(canonicalRoot, candidate);
	if (!existsSync(requested)) return { path: requested, exists: false };
	return { ...resolveProjectLedgerPathSync(canonicalRoot, requested), exists: true };
}
