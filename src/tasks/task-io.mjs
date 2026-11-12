// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

export async function ensurePrivateDirectory(path) {
	const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
	await chmod(path, 0o700);
	if (firstCreated) {
		const firstCreatedPath = resolve(firstCreated);
		let current = resolve(path);
		while (true) {
			await syncDirectory(dirname(current));
			if (current === firstCreatedPath) {
				break;
			}
			const parent = dirname(current);
			if (parent === current) {
				break;
			}
			current = parent;
		}
	}
}

async function syncDirectory(path) {
	let directory;
	try {
		directory = await open(path, "r");
		await directory.sync();
	} catch (error) {
		const code =
			error instanceof Error && "code" in error ? error.code : undefined;
		if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
			throw error;
		}
	} finally {
		await directory?.close();
	}
}

export async function atomicWriteFile(path, contents, faults = {}) {
	const directory = dirname(path);
	await ensurePrivateDirectory(directory);
	const temporaryPath = resolve(
		directory,
		`.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`,
	);
	const temporaryFile = await open(temporaryPath, "wx", 0o600);
	try {
		try {
			await temporaryFile.writeFile(contents, "utf8");
			await temporaryFile.sync();
		} finally {
			await temporaryFile.close();
		}
		await faults.beforeRename?.();
		await rename(temporaryPath, path);
		await chmod(path, 0o600);
		await syncDirectory(directory);
	} catch (error) {
		await unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}

/** Synchronous durable counterpart for same-process read/check CLIs. */
export function atomicWriteFileSync(path, contents, { mode = 0o600, beforeRename } = {}) {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporaryPath = resolve(directory, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}`);
	const file = openSync(temporaryPath, "wx", mode);
	try {
		writeFileSync(file, contents, "utf8");
		fsyncSync(file);
		closeSync(file);
		beforeRename?.();
		renameSync(temporaryPath, path);
		chmodSync(path, mode);
		syncDirectorySync(directory);
	} catch (error) {
		try { closeSync(file); } catch {}
		try { unlinkSync(temporaryPath); } catch {}
		throw error;
	}
}

/** Create a new private file durably and exclusively. */
export function atomicCreateFileSync(path, contents, { mode = 0o600 } = {}) {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let file;
	try { file = openSync(path, "wx", mode); }
	catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") return false; throw error; }
	try {
		writeFileSync(file, contents, "utf8");
		fsyncSync(file);
	} catch (error) {
		try { closeSync(file); } catch {}
		try { unlinkSync(path); } catch {}
		throw error;
	}
	closeSync(file);
	syncDirectorySync(directory);
	return true;
}

function syncDirectorySync(path) {
	let directory;
	try { directory = openSync(path, "r"); fsyncSync(directory); }
	catch (error) {
		const code = error instanceof Error && "code" in error ? error.code : undefined;
		if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") throw error;
	} finally { if (directory !== undefined) closeSync(directory); }
}

/** Create a private file only when absent; return false without changing an existing file. */
export async function atomicCreateFile(path, contents) {
	const directory = dirname(path);
	await ensurePrivateDirectory(directory);
	let file;
	try {
		file = await open(path, "wx", 0o600);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			return false;
		}
		throw error;
	}
	try {
		await file.writeFile(contents, "utf8");
		await file.sync();
	} catch (error) {
		await file.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
		throw error;
	}
	await file.close();
	await syncDirectory(directory);
	return true;
}

export async function appendDurableLine(path, line) {
	const directory = dirname(path);
	await ensurePrivateDirectory(directory);
	let created = false;
	let file;
	try {
		file = await open(path, "ax", 0o600);
		created = true;
	} catch (error) {
		if (
			!(error instanceof Error && "code" in error && error.code === "EEXIST")
		) {
			throw error;
		}
		file = await open(path, "a", 0o600);
	}
	try {
		await chmod(path, 0o600);
		if (created) {
			await file.sync();
			await syncDirectory(directory);
		}
		await file.writeFile(`${line}\n`, "utf8");
		await file.sync();
	} catch (error) {
		await file.close().catch(() => undefined);
		throw error;
	}
	await file.close().catch(() => undefined);
}
