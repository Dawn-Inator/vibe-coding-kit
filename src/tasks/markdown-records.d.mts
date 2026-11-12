export function readMarkdownRecords(
	path: string,
	options: { kind: string; identity: string },
): Promise<{ exists: boolean; records: unknown[] }>;
export function writeMarkdownRecords(
	path: string,
	options: { kind: string; identity: string; records: unknown[] },
): Promise<void>;
/** Process-local lock; caller must provide a single writer process. */
export function withMarkdownLock<T>(
	key: string,
	work: () => Promise<T>,
): Promise<T>;
/** Internal guard for the authoritative typed record sequence. */
export function verifyTaskHistoryHead(
	path: string,
	identity: string,
	records: unknown[],
): Promise<void>;
/** Publish a projection and history-prefix proof, without rewriting an unchanged head. */
export function writeTaskHistoryHead(
	path: string,
	identity: string,
	records: unknown[],
): Promise<void>;
