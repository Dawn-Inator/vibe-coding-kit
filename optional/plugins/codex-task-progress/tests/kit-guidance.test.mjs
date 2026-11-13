import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleKitTaskGuidance } from "../scripts/kit_task_guidance.mjs";

test("packaged task guidance derives from the pinned Kit source and preserves portable links", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-guidance-"));
  try {
    const kitRoot = join(root, "kit");
    const directory = join(kitRoot, "skills/task-progress");
    await mkdir(directory, { recursive: true });
    const content =
      "---\nname: task-progress\ndescription: Shared task rules.\n---\nKeep one source. [Plan](../normal-plan/SKILL.md)\n";
    await writeFile(join(directory, "SKILL.md"), content);
    const revision = "a".repeat(40);
    const destination = await bundleKitTaskGuidance(join(root, "output"), { kitRoot, revision });
    const packaged = await readFile(destination, "utf8");
    assert.ok(packaged.includes(`vibe-coding-kit@${revision}`));
    assert.ok(packaged.includes("Keep one source."));
    assert.ok(
      packaged.includes(
        `https://github.com/Dawn-Inator/vibe-coding-kit/blob/${revision}/skills/normal-plan/SKILL.md`,
      ),
    );
    await writeFile(join(directory, "SKILL.md"), "Updated shared rule.\n");
    await bundleKitTaskGuidance(join(root, "output"), { kitRoot, revision });
    assert.ok((await readFile(destination, "utf8")).endsWith("Updated shared rule.\n"));
    assert.equal(await readFile(join(directory, "SKILL.md"), "utf8"), "Updated shared rule.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaging refuses missing shared guidance and unpinned Kit versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-guidance-missing-"));
  try {
    await assert.rejects(
      bundleKitTaskGuidance(join(root, "output"), { kitRoot: root, revision: "main" }),
      /exact pinned Kit commit/u,
    );
    await assert.rejects(
      bundleKitTaskGuidance(join(root, "output"), { kitRoot: root, revision: "b".repeat(40) }),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaging locates the enclosing Kit checkout by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "kit-guidance-default-"));
  try {
    const destination = await bundleKitTaskGuidance(root, { revision: "c".repeat(40) });
    assert.match(await readFile(destination, "utf8"), /vibe-coding-kit@c{40}/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
