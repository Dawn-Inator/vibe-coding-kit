// Static guard for the task-progress browser suites and the native panel shell (no browser needed).
// Root cause of the "locator.click: Timeout 5000ms ... <html> / .summary intercepts pointer events" flake on a
// starved runner: aborting a request (identity switch, newer refresh) drops its response handler, so the host's late
// answer reaches the SDK's `onerror` as "Received a response for an unknown message ID: {...}". The shell painted that
// raw JSON-RPC payload into the unbounded `#native-panel-error` banner (~500px), which squeezed the panel body to
// 15px and pushed every control below the iframe viewport; whether the banner was cleared before the next click
// depended only on timing. The class fix is that (1) stale SDK traffic never reaches the banner, (2) the banner is
// height-bounded so no message can push the panel out of view, and (3) clicks are never forced or given a longer
// timeout to hide a covered target. (The reducedMotion pin below is kept as harmless hygiene; it was not the cause.)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'optional', 'plugins', 'codex-task-progress', 'tests');
const rendererSrc = join(testsDir, '..', 'packages', 'renderer', 'src');
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

export function errorBannerRule(html) {
  return html.match(/#native-panel-error\s*\{([^}]*)\}/u)?.[1] ?? '';
}
export function onerrorHandler(source) {
  return source.match(/app\.onerror\s*=\s*\(\s*\w+\s*\)\s*=>\s*\{[\s\S]*?\n\};/u)?.[0] ?? '';
}
test('the shell detectors flag the shapes they guard against', () => {
  assert.equal(/max-height/u.test(errorBannerRule('#native-panel-error { margin: 0; overflow-wrap: anywhere; }')), false);
  assert.equal(/max-height/u.test(errorBannerRule('#native-panel-error { max-height: 4.5em; overflow-y: auto; }')), true);
  const unfiltered = 'app.onerror = (error) => {\n  showError(String(error));\n};\nnext();';
  assert.ok(onerrorHandler(unfiltered).indexOf('showError') >= 0 && !/STALE_HOST_TRAFFIC/u.test(onerrorHandler(unfiltered)));
});
test('the native panel error banner is height-bounded and scrolls instead of growing', () => {
  const rule = errorBannerRule(readFileSync(join(rendererSrc, 'native-panel.html'), 'utf8'));
  assert.match(rule, /max-height\s*:/u, 'an unbounded banner can push the panel body out of the iframe viewport');
  assert.match(rule, /overflow-y\s*:\s*(?:auto|scroll)/u);
});
test('native-panel-entry drops stale SDK traffic before app.onerror can show a banner', () => {
  const handler = onerrorHandler(readFileSync(join(rendererSrc, 'native-panel-entry.ts'), 'utf8'));
  assert.ok(handler, 'app.onerror handler not found');
  const filter = handler.indexOf('STALE_HOST_TRAFFIC');
  const show = handler.indexOf('showError');
  assert.ok(filter >= 0 && show >= 0 && filter < show, 'the stale-traffic filter must run before showError');
});
