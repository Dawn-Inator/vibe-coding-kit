import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { brandRolesFromStats, isIconFont } from "./tokens.mjs";
import { brandRolesFromStats as facelessBrandRolesFromStats } from "../../../faceless-explainer/scripts/lib/tokens.mjs";
import { brandRolesFromStats as prBrandRolesFromStats } from "../../../pr-to-video/scripts/lib/tokens.mjs";
import { iconClassifier } from "./build-frame-font-fixtures.mjs";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("recognizes brand-specific icon font names", () => {
  assert.equal(isIconFont("vidaXLfont"), true);
  assert.equal(isIconFont("BrandGlyphFont"), true);
  assert.equal(isIconFont("Poppins"), false);
  assert.equal(isIconFont("HelveticaFont"), false);
  assert.equal(isIconFont("Airbnb Cereal Font"), false);
  assert.equal(isIconFont("SF Pro Text Font"), false);
  assert.equal(isIconFont("Uber Move Font"), false);
  assert.equal(isIconFont("Circular Std font"), false);
  assert.equal(isIconFont("brand-font"), false);
});

test("sibling frame builders classify icon and text families by behavior", () => {
  const families = ["vidaXLfont", "BrandGlyphFont", "icomoon", "Material Icons", "Font Awesome",
    "Poppins", "HelveticaFont", "Airbnb Cereal Font", "SF Pro Text Font", "Uber Move Font", "brand-font"];
  for (const skill of ["faceless-explainer", "pr-to-video"]) {
    const source = readFileSync(join(scriptsDir, skill, "scripts", "build-frame.mjs"), "utf8");
    const classify = iconClassifier(source);
    for (const family of families) assert.equal(classify(family), isIconFont(family), `${skill}: ${family}`);
  }
  const equivalent = '/* classifier can be reformatted */ const ICON_FONT_PATTERN = /glyph/i; const isIconFont = name => ICON_FONT_PATTERN.test(String(name));';
  assert.equal(iconClassifier(equivalent)("BrandGlyphFont"), true);
  assert.equal(iconClassifier(equivalent)("Poppins"), false);
  assert.notEqual(iconClassifier(equivalent.replace('/glyph/i', '/^never$/'))("BrandGlyphFont"), isIconFont("BrandGlyphFont"));
});

test("preserves a prominent second accent used outside interactive backgrounds", () => {
  const colors = ["#FFFFFF", "#2D1238", "#F3E62B", "#111111"];
  const stats = [
    { hex: "#FFFFFF", areaBg: 1000, maxArea: 1000 },
    { hex: "#2D1238", textCount: 4, interactiveBg: 3 },
    { hex: "#F3E62B", textCount: 3, interactiveBg: 0 },
    { hex: "#111111", textCount: 20 },
  ];

  assert.deepEqual(brandRolesFromStats(stats, colors), {
    canvas: "#FFFFFF",
    ink: "#111111",
    accent: "#F3E62B",
    accent2: "#2D1238",
  });

  for (const sibling of [facelessBrandRolesFromStats, prBrandRolesFromStats]) {
    assert.deepEqual(sibling(stats, colors), brandRolesFromStats(stats, colors));
  }
});
