// Adapted from https://github.com/Dawn-Inator/codex-task-progress; see src/tasks/LICENSE.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
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
