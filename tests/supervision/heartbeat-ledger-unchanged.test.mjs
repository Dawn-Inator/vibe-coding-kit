import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UNCHANGED_ROWS, createUnchangedTracker, isUnchangedState } from '../../src/supervision/heartbeat-ledger-unchanged.mjs';

const CMD = 'unchanged — `git log a..b`';

// Feeds one wake's cells ({ key: [state, kind] }) and returns the problems keyed by cell.
function wakeOf(tracker, cells) {
  tracker.startWake();
  const problems = {};
  for (const [key, [state, kind]] of Object.entries(cells)) problems[key] = tracker.check(key, state, kind);
  tracker.endWake();
  return problems;
}

test('isUnchangedState matches the keyword only at the start of the state', () => {
  assert.equal(isUnchangedState('unchanged — `x`'), true);
  assert.equal(isUnchangedState('  Unchanged'), true);
  assert.equal(isUnchangedState('empty -- unchanged `x`'), false);
  assert.equal(isUnchangedState('unchangedly'), false);
});

test('only rows 2-9 are eligible', () => {
  assert.deepEqual([...UNCHANGED_ROWS].sort(), ['2', '3', '4', '5', '6', '7', '8', '9']);
  const tracker = createUnchangedTracker();
  wakeOf(tracker, { 1: ['(1a) x', 'done'], '1a': ['x', 'done'], '1b': ['x', 'done'], 10: ['x', 'done'], 5: ['x', 'done'] });
  const second = wakeOf(tracker, { '1a': [CMD, 'unchanged'], '1b': [CMD, 'unchanged'], 10: [CMD, 'unchanged'], 5: [CMD, 'unchanged'] });
  assert.match(second['1a'], /only rows 2-9/);
  assert.match(second['1b'], /only rows 2-9/);
  assert.match(second['10'], /only rows 2-9/);
  assert.equal(second['5'], null);
});

test('first wake, previous deferred and a missing command are each refused with a reason', () => {
  const tracker = createUnchangedTracker();
  assert.match(wakeOf(tracker, { 4: [CMD, 'unchanged'], 6: ['deferred <- x ETA <=20m', 'deferred'], 7: ['x', 'done'] })['4'], /first wake/);
  const second = wakeOf(tracker, { 4: [CMD, 'unchanged'], 6: [CMD, 'unchanged'], 7: ['unchanged', 'unchanged'] });
  assert.match(second['4'], /no valid state/, 'the refused first-wake row carried nothing forward');
  assert.match(second['6'], /deferred last wake/);
  assert.match(second['7'], /backticks/);
});

test('an unchanged row inherits its predecessor kind, so a deferred row stays unavailable down the chain', () => {
  const tracker = createUnchangedTracker();
  wakeOf(tracker, { 6: ['deferred <- x ETA <=20m', 'deferred'], 7: ['x', 'done'] });
  assert.match(wakeOf(tracker, { 6: [CMD, 'unchanged'], 7: [CMD, 'unchanged'] })['6'], /deferred last wake/);
  const third = wakeOf(tracker, { 6: [CMD, 'unchanged'], 7: ['unchanged', 'unchanged'] });
  assert.match(third['6'], /deferred last wake/);
  assert.match(third['7'], /backticks/);
});

test('a row without a valid previous state cannot carry forward', () => {
  const tracker = createUnchangedTracker();
  wakeOf(tracker, { 2: ['x', 'done'] });
  assert.match(wakeOf(tracker, { 3: [CMD, 'unchanged'] })['3'], /no valid state/);
  assert.match(wakeOf(tracker, { 3: [CMD, 'unchanged'] })['3'], /no valid state/, 'the refused row recorded unknown');
});
