import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { parseWakes } from './check-heartbeat-ledger.mjs';
import { inspectHeartbeatLedger } from './heartbeat-ledger-api.mjs';
import { resolveProjectLedgerPathSync, validateProjectLedgerSidecarSync } from '../tasks/project-ledger-path.mjs';
import { atomicCreateFileSync, atomicWriteFileSync } from '../tasks/task-io.mjs';

const HISTORY_VERSION = 1;
const WAKE = /^#{1,6}\s+\d{4}-\d\d-\d\dT\S+\s+wake\b.*$/i;
const HISTORY_MARKER = /^<!-- heartbeat-history:v1 source=([^\s>]+)(?: pending=([a-f0-9]{64}))? -->\n/;
const HEAD_MARKER = /^<!-- heartbeat-head:v1 source=([^\s>]+) history=([^\s>]+) -->\n/;

export function heartbeatLedgerPairPaths(path) {
	if (typeof path !== 'string' || !path.trim()) throw new TypeError('path is required');
	const headPath = resolve(path);
	const name = basename(headPath);
	const historyPath = name.toLowerCase() === 'heartbeat.md'
		? resolve(dirname(headPath), 'taskhistory.md')
		: resolve(dirname(headPath), `${name.replace(/\.md$/i, '')}.taskhistory.md`);
	return { headPath, historyPath, legacyBackupPath: `${headPath}.legacy` };
}

function safePaths(root, path) {
	if (typeof root !== 'string' || !root.trim() || !isAbsolute(root)) throw new TypeError('root must be an absolute path');
	if (typeof path !== 'string' || !path.trim()) throw new TypeError('path is required');
	const canonicalRoot = realpathSync(root);
	const requested = resolve(canonicalRoot, path);
	if (basename(requested).toLowerCase() === 'taskhistory.md' || requested.endsWith('.taskhistory.md') || requested.endsWith('.legacy') || /\.tmp(?:-|$)/i.test(requested)) throw new Error('History, backup, and temporary files cannot be used as heartbeat heads');
	const { path: canonicalHead } = resolveProjectLedgerPathSync(canonicalRoot, requested);
	const paths = heartbeatLedgerPairPaths(canonicalHead);
	for (const companion of [paths.historyPath, paths.legacyBackupPath]) {
		const validated = validateProjectLedgerSidecarSync(canonicalRoot, companion);
		if (validated.exists && validated.path !== companion) throw new Error('Heartbeat companion paths cannot be symlinks');
	}
	if (canonicalHead === paths.historyPath) throw new Error('History files cannot be used as heartbeat heads');
	return { ...paths, root: canonicalRoot };
}

function sha(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }
function atomicWrite(path, text) {
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	atomicWriteFileSync(path, text, { mode });
}
function splitWakeSections(text) {
	const lines = text.split('\n');
	const sections = [];
	let start = -1;
	for (let i = 0; i < lines.length; i += 1) {
		if (!WAKE.test(lines[i])) continue;
		if (start >= 0) sections.push(lines.slice(start, i).join('\n'));
		start = i;
	}
	if (start >= 0) sections.push(lines.slice(start).join('\n'));
	return sections;
}
function wakeCore(section) {
	return section.replace(/\n#{1,6}\s+Items\s*(?:\n|$)[\s\S]*$/i, '').replace(/(?:\n-{3,}[ \t]*)+\s*$/, '').trimEnd();
}
function stripItems(section) { return section.replace(/\n#{1,6}\s+Items\s*(?:\n|$)[\s\S]*$/i, ''); }
function latestHead(text) {
	const sections = splitWakeSections(text);
	if (!sections.length) return text;
	const last = sections.at(-1);
	const index = text.lastIndexOf(last);
	const prefix = text.slice(0, index);
	const firstWake = text.search(/^#{1,6}\s+\d{4}-\d\d-\d\dT\S+\s+wake\b.*$/im);
	const leading = firstWake >= 0 ? text.slice(0, firstWake) : prefix;
	const trailing = text.slice(index + last.length);
	return `${leading}${last}${trailing}`;
}
function appendHead(previous, wake) {
	const match = /^#{1,6}\s+\d{4}-\d\d-\d\dT\S+\s+wake\b.*$/im.exec(previous);
	const itemIndex = previous.search(/^#{1,6}\s+Items\s*$/im);
	const prefix = match ? previous.slice(0, match.index) : '';
	const trailing = itemIndex >= 0 ? previous.slice(itemIndex) : '';
	return `${prefix}${wake}${wake.endsWith('\n') ? '' : '\n'}${trailing}`;
}
function canonicalHistory(raw, identity, pending = null) {
	return `<!-- heartbeat-history:v${HISTORY_VERSION} source=${encodeURIComponent(identity)}${pending ? ` pending=${pending}` : ''} -->\n${raw}`;
}
function canonicalHead(raw, paths) {
	const body = raw.replace(HEAD_MARKER, '');
	return `<!-- heartbeat-head:v1 source=${encodeURIComponent(paths.headPath)} history=${encodeURIComponent(paths.historyPath)} -->\n${body}`;
}
function validateHeadReference(raw, paths) {
	const match = HEAD_MARKER.exec(raw);
	if (!match) return false;
	if (decodeURIComponent(match[1]) !== paths.headPath || decodeURIComponent(match[2]) !== paths.historyPath)
		throw new Error('Heartbeat head references an unrelated history companion');
	if (!existsSync(paths.historyPath)) throw new Error('Canonical heartbeat head references a missing history companion');
	return true;
}
function historyBody(text, identity) {
	const match = HISTORY_MARKER.exec(text);
	if (!match) throw new Error('Heartbeat history companion has an invalid or unrelated format');
	if (decodeURIComponent(match[1]) !== identity) throw new Error('Heartbeat history companion belongs to another heartbeat source');
	return { body: text.slice(match[0].length), pending: match[2] ?? null };
}
function logicalText(historyText, headText, identity) {
	if (!historyText) return headText;
	const old = historyBody(historyText, identity).body;
	const prior = splitWakeSections(old);
	const current = splitWakeSections(headText);
	if (!prior.length && !current.length) return headText;
	let overlap = 0;
	for (let size = Math.min(prior.length, current.length); size > 0; size -= 1) {
		if (prior.slice(-size).every((part, index) => wakeCore(part) === wakeCore(current[index]))) { overlap = size; break; }
	}
	const firstWake = headText.search(/^#{1,6}\s+\d{4}-\d\d-\d\dT\S+\s+wake\b.*$/im);
	const prelude = firstWake < 0 ? headText : headText.slice(0, firstWake);
	const itemIndex = headText.search(/^#{1,6}\s+Items\s*$/im);
	const items = itemIndex < 0 ? '' : headText.slice(itemIndex);
	const wakes = [...prior, ...current.slice(overlap)].map(stripItems);
	const wakeText = wakes.filter(Boolean).join('\n');
	return `${prelude}${wakeText}${wakeText && !wakeText.endsWith('\n') ? '\n' : ''}${items}`;
}

function readPair(paths) {
	if (!existsSync(paths.headPath)) throw new Error(`Heartbeat ledger does not exist: ${paths.headPath}`);
	const headText = readFileSync(paths.headPath, 'utf8');
	const hasHeadReference = validateHeadReference(headText, paths);
	const headModified = statSync(paths.headPath).mtimeMs;
	const isLegacy = !existsSync(paths.historyPath) && !hasHeadReference;
	const historyText = isLegacy ? '' : readFileSync(paths.historyPath, 'utf8');
	if (!isLegacy) {
		const marker = HISTORY_MARKER.exec(historyText);
		const pending = historyBody(historyText, paths.headPath).pending;
		if (pending && sha(wakeCore(splitWakeSections(headText).at(-1) ?? '')) !== pending) throw new Error('Heartbeat pair write is interrupted; refusing a stale current head until explicit recovery');
	}
	const modifiedAt = new Date(Math.max(headModified, isLegacy ? 0 : statSync(paths.historyPath).mtimeMs)).toISOString();
	const identity = paths.headPath;
	const fullText = isLegacy ? headText : logicalText(historyText, headText, identity);
	const contentHash = sha(`${headText}\0${historyText}`);
	const headWakes = parseWakes(headText).map((wake) => ({ ...wake, sourcePath: paths.headPath, sourceLine: wake.line }));
	const body = isLegacy ? '' : historyBody(historyText, paths.headPath).body;
	const archiveSegments = splitWakeSections(body);
	const headSegments = splitWakeSections(headText);
	let overlap = 0;
	for (let size = Math.min(archiveSegments.length, headSegments.length); size > 0; size -= 1) {
		if (archiveSegments.slice(-size).every((part, index) => wakeCore(part) === wakeCore(headSegments[index]))) { overlap = size; break; }
	}
	const archivedWakes = isLegacy ? [] : parseWakes(body).map((wake) => ({ ...wake, sourcePath: paths.historyPath, sourceLine: wake.line + 1 }));
	const liveWakes = headWakes.slice(overlap);
	return { headText, historyText, fullText, contentHash, modifiedAt, headPath: paths.headPath, historyPath: paths.historyPath, isLegacy, wakes: [...archivedWakes, ...liveWakes] };
}

export function readHeartbeatLedgerPair({ root, path }) {
	const paths = safePaths(root, path);
	return readPair(paths);
}

/** Inspect a pair with the same synchronous inspector used for legacy single-file ledgers. */
export function inspectHeartbeatLedgerPair(pair, { mode = 'current', latest = true, now = new Date(), inspect = inspectHeartbeatLedger, ...options } = {}) {
	if (!pair || typeof pair.headText !== 'string' || typeof pair.fullText !== 'string') throw new TypeError('A heartbeat ledger pair is required');
	const text = mode === 'items' ? pair.headText : pair.fullText;
	const report = inspect(text, { mode, latest, now, ...options });
	if (mode !== 'items') {
		const headInventory = inspect(pair.headText, { mode: 'items', latest: true, now, ...options });
		report.items = headInventory.items;
		report.itemCount = headInventory.itemCount;
		report.tables = headInventory.tables;
	}
	let sourceIndex = 0;
	for (const wake of report.wakes ?? []) {
		let source = pair.wakes?.[sourceIndex++];
		while (source && source.heading !== wake.heading) source = pair.wakes?.[sourceIndex++];
		if (!source) continue;
		const logicalWakeLine = wake.line;
		wake.sourcePath = source.sourcePath;
		wake.sourceLine = source.sourceLine;
		wake.logicalLine = logicalWakeLine;
		wake.line = source.sourceLine;
		wake.lineNumber = source.sourceLine;
		wake.headingLine = source.sourceLine;
		for (const row of wake.rows ?? []) {
			const logicalRowLine = row.line;
			row.sourcePath = source.sourcePath;
			row.sourceLine = source.sourceLine + (logicalRowLine - logicalWakeLine);
			row.logicalLine = logicalRowLine;
			row.line = row.sourceLine;
			row.lineNumber = row.sourceLine;
		}
	}
	report.items = report.items.map((item) => ({ ...item, sourcePath: pair.headPath, sourceLine: item.line }));
	report.tables = (report.tables ?? []).map((table) => ({
		...table,
		rows: table.rows.map((item) => ({ ...item, sourcePath: pair.headPath, sourceLine: item.line })),
	}));
	return report;
}

export function migrateHeartbeatLedgerPair({ root, path }) {
	const paths = safePaths(root, path);
	if (!existsSync(paths.headPath)) throw new Error(`Heartbeat ledger does not exist: ${paths.headPath}`);
	const original = readFileSync(paths.headPath, 'utf8');
	if (HEAD_MARKER.test(original) && !existsSync(paths.historyPath)) throw new Error('Canonical heartbeat head references a missing history companion; refusing to rebuild history from a truncated head');
	if (existsSync(paths.historyPath)) {
		const existing = readFileSync(paths.historyPath, 'utf8');
		const identity = paths.headPath;
		const existingBody = historyBody(existing, identity).body;
		const backup = existsSync(paths.legacyBackupPath) ? readFileSync(paths.legacyBackupPath, 'utf8') : null;
		if (backup && backup !== original) return readPair(paths); // completed migration; history is already canonical
		// An interrupted history-first migration is recoverable only when the immutable backup proves
		// the companion was written for these exact original bytes.
		if (!HISTORY_MARKER.test(existing)) throw new Error('Refusing to overwrite an unrelated heartbeat history companion');
		if (!backup) throw new Error('Heartbeat migration is incomplete: history exists without its immutable legacy backup');
		if (backup !== original) throw new Error('Heartbeat migration is incomplete and the current head differs from its immutable legacy backup');
		const nextHead = canonicalHead(latestHead(existingBody), paths);
		atomicWrite(paths.headPath, nextHead);
		return readPair(paths);
	}
	if (existsSync(paths.legacyBackupPath)) {
		if (readFileSync(paths.legacyBackupPath, 'utf8') !== original) throw new Error('Immutable legacy backup already exists with different content');
	} else {
		atomicCreateFileSync(paths.legacyBackupPath, original, { mode: 0o600 });
	}
	const verifiedBackup = readFileSync(paths.legacyBackupPath, 'utf8');
	if (verifiedBackup !== original) throw new Error('Legacy backup verification failed');
	const history = canonicalHistory(original, paths.headPath);
	atomicWrite(paths.historyPath, history);
	const verifiedHistory = readFileSync(paths.historyPath, 'utf8');
	if (historyBody(verifiedHistory, paths.headPath).body !== original) throw new Error('Heartbeat history verification failed');
	atomicWrite(paths.headPath, canonicalHead(latestHead(original), paths));
	return readPair(paths);
}

export function writeHeartbeatLedgerPair({ root, path, text }) {
	if (typeof text !== 'string') throw new TypeError('text must be a string');
	const paths = safePaths(root, path);
	if (!existsSync(paths.historyPath)) migrateHeartbeatLedgerPair({ root, path });
	const prior = readPair(paths);
	const wakes = splitWakeSections(text);
	const wake = wakes.at(-1);
	if (!wake) throw new Error('Heartbeat writer requires at least one wake section');
	const body = historyBody(prior.historyText, paths.headPath).body;
	const combined = `${body}${body.endsWith('\n') ? '' : '\n'}${wake}\n`;
	const history = canonicalHistory(combined, paths.headPath, sha(wakeCore(wake)));
	atomicWrite(paths.historyPath, history);
	if (historyBody(readFileSync(paths.historyPath, 'utf8'), paths.headPath).body !== combined) throw new Error('Heartbeat history verification failed');
	atomicWrite(paths.headPath, canonicalHead(latestHead(text), paths));
	atomicWrite(paths.historyPath, canonicalHistory(combined, paths.headPath));
	return readPair(paths);
}

export function appendHeartbeatWake({ root, path, wakeText }) {
	if (typeof wakeText !== 'string' || !splitWakeSections(wakeText).length) throw new TypeError('wakeText must contain a wake section');
	const paths = safePaths(root, path);
	if (!existsSync(paths.historyPath)) migrateHeartbeatLedgerPair({ root, path });
	const prior = readPair(paths);
	const body = historyBody(prior.historyText, paths.headPath).body;
	const cleanWake = splitWakeSections(wakeText).at(-1);
	const nextHistory = `${body}${body.endsWith('\n') ? '' : '\n'}${cleanWake}\n`;
	atomicWrite(paths.historyPath, canonicalHistory(nextHistory, paths.headPath, sha(wakeCore(cleanWake))));
	if (historyBody(readFileSync(paths.historyPath, 'utf8'), paths.headPath).body !== nextHistory) throw new Error('Heartbeat history verification failed');
	const head = canonicalHead(appendHead(prior.headText, cleanWake), paths);
	atomicWrite(paths.headPath, head);
	atomicWrite(paths.historyPath, canonicalHistory(nextHistory, paths.headPath));
	return readPair(paths);
}
