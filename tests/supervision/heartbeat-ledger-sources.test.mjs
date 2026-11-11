import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BACKLOG_MAX_AGE_MS, REQUIRED_SOURCES, gradeSources, hasBacklogOwnerItem, parseIsoMs, parseSourceTokens } from '../../src/supervision/heartbeat-ledger-sources.mjs';

const FULL = 'sources: sweep(✓) landings(✓) reports(✓) drift-matrix(✓) memory/handoff(✓ at resume) external-backlog(✓ 2026-01-01T09:30Z) worker-health(✓)';
const WAKE_MS = Date.parse('2026-01-01T10:00Z');
const grade = (line, ownerRows = []) => gradeSources(line, { wakeMs: WAKE_MS, ownerRows }).map((f) => f.rule);
const HERE = dirname(fileURLToPath(import.meta.url));
const BACKLOG_AUDIT = join(HERE, '..', '..', 'skills', 'agent-task-supervision', 'references', 'backlog-audit.md');

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

test('backlog-audit source examples are complete and pass the real checked/blocked source grader', () => {
  const markdown = readFileSync(BACKLOG_AUDIT, 'utf8');
  const examples = [...markdown.matchAll(/`([^`]*\bsources:[^`]*)`/g)].map((match) => match[1]);
  const checkedExample = examples.find((example) => {
    const value = parseSourceTokens(example).get('external-backlog');
    return value && /<read-at>/i.test(value);
  });
  const blockedExample = examples.find((example) => {
    const tokens = parseSourceTokens(example);
    return [...tokens.entries()].some(([name, value]) => name === 'external-backlog:tracker' && /blocked\s*(?:←|<-).*<permission>/i.test(value));
  });

  assert.ok(checkedExample, 'reference must include an inline full-channel checked backlog source example');
  assert.ok(blockedExample, 'reference must include an inline full-channel named blocked backlog source example');

  const checkedLine = checkedExample.replace('<read-at>', '2026-01-01T09:30Z');
  const checkedTokens = parseSourceTokens(checkedLine);
  for (const source of REQUIRED_SOURCES) assert.ok(checkedTokens.has(source), `checked example is missing ${source}`);
  assert.deepEqual(gradeSources(checkedLine, { wakeMs: WAKE_MS, ownerRows: [] }), []);

  const blockedLine = blockedExample.replace('<permission>', 'tracker access denied');
  const blockedTokens = parseSourceTokens(blockedLine);
  for (const source of REQUIRED_SOURCES) assert.ok(blockedTokens.has(source), `blocked example is missing ${source}`);
  assert.deepEqual(grade(blockedLine), ['external-backlog-owner-missing']);
  const unrelatedOwner = [{ item: 'release mobile build', status: 'owner <- unrelated decision + checked scope', evidence: '' }];
  assert.deepEqual(grade(blockedLine, unrelatedOwner), ['external-backlog-owner-missing']);
  const matchingOwner = [{ item: 'restore tracker access', status: 'owner <- security boundary + checked tracker access scope', evidence: '' }];
  assert.deepEqual(gradeSources(blockedLine, { wakeMs: WAKE_MS, ownerRows: matchingOwner }), []);
});
