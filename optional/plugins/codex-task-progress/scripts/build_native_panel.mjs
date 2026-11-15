import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Allow up to 1 MiB for the MCP Apps SDK and native checklist resource.
const maxBundleBytes = 1024 * 1024;

export function renderNativePanelHtml(template, script) {
  const scriptSlot = "<!-- NATIVE_PANEL_SCRIPT -->";
  if (template.split(scriptSlot).length !== 2)
    throw new Error("NATIVE_PANEL_TEMPLATE_SCRIPT_SLOT_INVALID");
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  return template.replace(scriptSlot, () => `<script>${safeScript}</script>`);
}

export async function buildNativePanel(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot);
  const outputPath = resolve(
    options.outputPath ?? resolve(sourceRoot, "dist/plugin/task-progress-panel.html"),
  );
  const bundle = await build({
    absWorkingDir: sourceRoot,
    bundle: true,
    charset: "utf8",
    entryPoints: ["packages/renderer/src/native-panel-entry.ts"],
    format: "iife",
    legalComments: "none",
    minify: true,
    nodePaths: options.nodePaths,
    platform: "browser",
    target: "chrome120",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  if (!script || Buffer.byteLength(script) === 0 || Buffer.byteLength(script) > maxBundleBytes) {
    throw new Error(`NATIVE_PANEL_BUNDLE_SIZE_INVALID: ${Buffer.byteLength(script ?? "")}`);
  }
  const template = await readFile(
    resolve(sourceRoot, "packages/renderer/src/native-panel.html"),
    "utf8",
  );
  const html = renderNativePanelHtml(template, script);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html);
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildNativePanel()
    .then((outputPath) => process.stdout.write(`${outputPath}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
