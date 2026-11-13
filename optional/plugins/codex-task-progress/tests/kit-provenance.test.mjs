import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { kitRevision } from "../scripts/kit_root.mjs";

test("Kit provenance rejects dirty source and records the actual checkout HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-kit-provenance-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "-q");
    git("config", "user.name", "Kit provenance fixture");
    git("config", "user.email", "fixture@example.invalid");
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "skills/task-progress"), { recursive: true });
    await writeFile(join(root, "src/example.mjs"), "export const value = 1;\n");
    await writeFile(join(root, "skills/task-progress/SKILL.md"), "test guidance\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
    assert.equal(kitRevision(root), git("rev-parse", "HEAD"));
    await writeFile(join(root, "src/example.mjs"), "export const value = 2;\n");
    assert.throws(() => kitRevision(root), /Commit Kit sources/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("component paths resolve to the enclosing Kit checkout after the optional plugins move", async () => {
  const { kitRoot } = await import("../scripts/kit_root.mjs");
  const packageJson = JSON.parse(
    await (await import("node:fs/promises")).readFile(join(kitRoot, "package.json"), "utf8"),
  );
  assert.equal(packageJson.name, "vibe-coding-kit");
  const componentJson = JSON.parse(
    await (await import("node:fs/promises")).readFile(
      new URL("../package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(componentJson.dependencies["vibe-coding-kit"], "link:../../..");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const componentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(resolve(componentRoot, "../../../src"), join(kitRoot, "src"));
});
