import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BACKLOG_MAX_AGE_MS, REQUIRED_SOURCES, gradeSources, hasBacklogOwnerItem, parseIsoMs, parseSourceTokens } from '../../src/supervision/heartbeat-ledger-sources.mjs';

const FULL = 'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T09:30Z) worker-health(✓)';
const WAKE_MS = Date.parse('2026-01-01T10:00Z');
const grade = (line, ownerRows = []) => gradeSources(line, { wakeMs: WAKE_MS, ownerRows }).map((f) => f.rule);

test('parseSourceTokens reads name(value) tokens, including slashes and a named backlog', () => {
  const tokens = parseSourceTokens('sweep(✓) memory/handoff(✓ at resume) external-backlog:bugs(blocked ← no access)');
  assert.equal(tokens.get('memory/handoff'), '✓ at resume');
  assert.equal(tokens.get('external-backlog:bugs'), 'blocked ← no access');
});

test('parseIsoMs reads Z, offset and zone-less ISO times, and refuses anything else', () => {
  assert.equal(parseIsoMs('✓ 2026-01-01T09:30Z'), Date.parse('2026-01-01T09:30Z'));
  assert.equal(parseIsoMs('2026-01-01T09:30:15+02:00'), Date.parse('2026-01-01T07:30:15Z'));
  assert.equal(parseIsoMs('2026-01-01T09:30'), Date.parse('2026-01-01T09:30Z'));
  assert.equal(parseIsoMs('2026-01-01'), null);
  assert.equal(parseIsoMs(undefined), null);
  assert.equal(parseIsoMs('yesterday'), null);
});

test('the full skill line is green and the cadence is six hours', () => {
  assert.deepEqual(grade(FULL), []);
  assert.equal(BACKLOG_MAX_AGE_MS, 6 * 3600 * 1000);
  assert.equal(REQUIRED_SOURCES.length > 0, true);
});

test('stale, timestamp-less and unparseable backlog values are red; an unknown wake time skips the staleness check only', () => {
  assert.deepEqual(grade(FULL.replace('09:30Z', '03:00Z')), ['external-backlog-stale']);
  assert.deepEqual(grade(FULL.replace('✓ 2026-01-01T09:30Z', '✓')), ['external-backlog-timestamp-missing']);
  assert.deepEqual(grade(FULL.replace('✓ 2026-01-01T09:30Z', 'later')), ['external-backlog-format']);
  assert.deepEqual(gradeSources(FULL.replace('09:30Z', '03:00Z'), { wakeMs: null, ownerRows: [] }), []);
});

test('hasBacklogOwnerItem matches the generic words or the token name, in any owner column', () => {
  const row = (fields) => ({ item: '', status: 'owner <- x + y', evidence: '', ...fields });
  assert.equal(hasBacklogOwnerItem([row({ item: 'fix external-backlog access' })]), true);
  assert.equal(hasBacklogOwnerItem([row({ evidence: 'the External Backlog login' })]), true);
  assert.equal(hasBacklogOwnerItem([row({ item: 'unlock the bugs tracker' })], 'bugs'), true);
  assert.equal(hasBacklogOwnerItem([row({ item: 'unlock the bugs tracker' })]), false);
  assert.equal(hasBacklogOwnerItem([], 'bugs'), false);
});
