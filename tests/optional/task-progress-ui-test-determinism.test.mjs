// Static guard for the task-progress browser suites (no browser needed). The panel body plays a 200ms entry
// animation; on a starved CI runner a click that lands mid-animation is hit-tested against a stale transform and
// `<html>` / `.summary` intercept it ("locator.click: Timeout 5000ms ... intercepts pointer events"). The class fix
// is that every browser context in these suites pins `reducedMotion`, and clicks are never forced or given a
// longer timeout to hide a covered target.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'optional', 'plugins', 'codex-task-progress', 'tests');
const browserSuites = readdirSync(testsDir).filter((name) => name.endsWith('.test.mjs')).filter((name) => /@playwright\/test/u.test(readFileSync(join(testsDir, name), 'utf8')));

// Source text of the balanced `(...)` argument list opening at `open`, skipping string and template literals.
export function argumentList(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') {
      for (i += 1; i < source.length && source[i] !== char; i += 1) if (source[i] === '\\') i += 1;
    } else if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}
export function contextCreationsWithoutReducedMotion(source) {
  return [...source.matchAll(/\.newContext\(/gu)]
    .filter((match) => !/\breducedMotion\b/u.test(argumentList(source, match.index + match[0].length - 1)))
    .map((match) => source.slice(0, match.index).split('\n').length);
}
export function maskedClicks(source) {
  return [...source.matchAll(/\.click\(\s*\{[^)]*\b(?:force|timeout)\s*:/gu)].map((match) => source.slice(0, match.index).split('\n').length);
}

test('the guard sees the task-progress browser suites', () => {
  assert.deepEqual(browserSuites.filter((name) => name === 'native-panel.test.mjs' || name === 'task-panel.test.mjs').sort(), ['native-panel.test.mjs', 'task-panel.test.mjs']);
});

test('the detectors flag the shapes they guard against', () => {
  assert.deepEqual(contextCreationsWithoutReducedMotion('a\nawait browser.newContext({ viewport: { width: 1, height: 1 } });'), [2]);
  assert.deepEqual(contextCreationsWithoutReducedMotion('await browser.newContext({ locale: "x", reducedMotion: "reduce" });'), []);
  assert.deepEqual(maskedClicks('x\nawait frame.locator("a").click({ force: true });'), [2]);
  assert.deepEqual(maskedClicks('await frame.locator("a").click({ timeout: 30_000 });'), [1]);
  assert.deepEqual(maskedClicks('await frame.locator("a").click();'), []);
});

for (const name of browserSuites) {
  test(`${name} pins reducedMotion on every browser context`, () => {
    assert.deepEqual(contextCreationsWithoutReducedMotion(readFileSync(join(testsDir, name), 'utf8')), [], 'every newContext() call must pass reducedMotion (see the header of this guard)');
  });
  test(`${name} never forces a click or stretches its timeout`, () => {
    assert.deepEqual(maskedClicks(readFileSync(join(testsDir, name), 'utf8')), [], 'click({ force | timeout }) hides a covered target instead of fixing it');
  });
}
