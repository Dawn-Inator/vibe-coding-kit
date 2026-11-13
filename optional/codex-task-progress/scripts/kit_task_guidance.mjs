import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { kitRoot as checkoutKitRoot } from "./kit_root.mjs";

/** Package a generated view of the pinned Kit guidance; the Kit remains its sole source. */
export async function bundleKitTaskGuidance(outputRoot, options = {}) {
  const kitRoot = options.kitRoot ?? checkoutKitRoot;
  const revision = options.revision;
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/u.test(revision)) {
    throw new Error("Kit task guidance requires an exact pinned Kit commit");
  }
  const sourcePath = resolve(kitRoot, "skills/task-progress/SKILL.md");
  const source = await readFile(sourcePath, "utf8");
  const rendered = source.replace(/\]\((\.\.?\/[^)]+)\)/gu, (_match, target) => {
    const path = relative(kitRoot, resolve(dirname(sourcePath), target));
    if (path.startsWith("..")) throw new Error("Kit guidance reference leaves the Kit package");
    return `](https://github.com/Dawn-Inator/vibe-coding-kit/blob/${revision}/${path.split(/[\\/]/u).map(encodeURIComponent).join("/")})`;
  });
  const destination = resolve(outputRoot, "skills/task-progress/references/kit-task-progress.md");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    `<!-- Generated from vibe-coding-kit@${revision}/skills/task-progress/SKILL.md. Edit the Kit source. -->\n${rendered}`,
    "utf8",
  );
  return destination;
}
