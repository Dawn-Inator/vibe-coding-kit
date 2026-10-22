// The `unchanged -- `<command rerun this wake>`` shorthand for the ten-row ledger.
//
// A row whose state did not change since the previous wake may say so instead of restating itself,
// but only where restating adds nothing and the checker's other rules can still see through it:
//   - rows 2-9 only (never the goal row 1a/1b, never the drift row 10);
//   - not on the first wake (there is no previous state to carry forward);
//   - not when the same row was `deferred` last wake (the repeated-deferral rule must keep seeing its input);
//   - it must cite, in backticks, the command rerun this wake (an unchanged claim without a rerun is a guess).
// An `unchanged` row inherits its predecessor's resolved kind, so a chain of them stays traceable.
// Kept out of check-heartbeat-ledger.mjs so that file stays about the table grammar.

export const UNCHANGED_ROWS = new Set(['2', '3', '4', '5', '6', '7', '8', '9']);
const BACKTICK_RE = /`[^`]+`/;

export const isUnchangedState = (text) => /^unchanged\b/i.test(text.trim());

export function createUnchangedTracker() {
  let previous = new Map();
  let current = new Map();
  let first = true;
  return {
    startWake() {
      current = new Map();
    },
    // Records the cell's resolved kind. Returns a problem string when the shorthand is not allowed here,
    // null when it is (or when the cell does not use it). `kind` is the cell's own kind, `key` is '2'..'10', '1a', '1b'.
    check(key, state, kind) {
      const unchanged = isUnchangedState(state);
      const previousKind = previous.get(key);
      current.set(key, unchanged ? (previousKind ?? 'unknown') : kind);
      if (!unchanged) return null;
      if (!UNCHANGED_ROWS.has(key)) return 'only rows 2-9 may use it; the goal row (1a/1b) and the drift row (10) are restated every wake';
      if (first) return 'it is not allowed on the first wake: there is no previous wake to carry a state forward from';
      if (previousKind === undefined || previousKind === 'unknown') return 'the previous wake has no valid state for this row to carry forward';
      if (previousKind === 'deferred') return 'a row that was deferred last wake must be restated, so the repeated-deferral rule can see its input';
      if (!BACKTICK_RE.test(state)) return 'it must cite the command rerun this wake in backticks';
      return null;
    },
    endWake() {
      previous = current;
      first = false;
    },
  };
}
