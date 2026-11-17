import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMainModule } from "../scripts/lib/main-module.mjs";

test("isMainModule is true when argv1 is the module file itself", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-main-module-"));
  try {
    const file = join(dir, "entry.mjs");
    writeFileSync(file, "");
    assert.equal(isMainModule(pathToFileURL(file).href, file), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMainModule is false for a different file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tp-main-module-"));
  try {
    const file = join(dir, "entry.mjs");
    const other = join(dir, "other.mjs");
    writeFileSync(file, "");
    writeFileSync(other, "");
    assert.equal(isMainModule(pathToFileURL(file).href, other), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMainModule is false for an empty argv1 or a missing path", () => {
  const url = pathToFileURL(join(tmpdir(), "tp-main-module-missing.mjs")).href;
  assert.equal(isMainModule(url, ""), false);
  assert.equal(isMainModule(url, undefined), false);
  assert.equal(isMainModule(url, join(tmpdir(), "tp-main-module-missing.mjs")), false);
});
