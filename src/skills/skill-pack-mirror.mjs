// Skill-pack mirroring: link rewriting between the skills/ and skill-packs/ mirror roots, generated
// pack index/footer blocks, and SKILL.md description parsing. Used by sync-skills.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';

import { isPackMember, packOf, packOfEntry, PACK_MIRROR_DIRNAME } from './skill-packs.mjs';

export function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------------------------
// Skill packs (see skill-packs.mjs). Pack members are mirrored to `<root>/skill-packs/<name>/`
// instead of `<root>/skills/<name>/`; the pack entry stays in `skills/` and gets a generated index,
// each member gets a generated footer pointing back at the entry.
// ---------------------------------------------------------------------------------------------
const INDEX_BEGIN = '<!-- BEGIN: generated skill-pack index -->';
const INDEX_END = '<!-- END: generated skill-pack index -->';
const FOOTER_BEGIN = '<!-- BEGIN: generated skill-pack footer -->';
const FOOTER_END = '<!-- END: generated skill-pack footer -->';
export const SKILLS_CLASS = 'skills';
const SUMMARY_MAX_CHARS = 80;

export function packMirrorRoot(output) {
  return join(dirname(output.root), PACK_MIRROR_DIRNAME);
}

export function mirrorClassOf(skillName) {
  return isPackMember(skillName) ? PACK_MIRROR_DIRNAME : SKILLS_CLASS;
}

export function mirrorRootFor(output, skillName) {
  return isPackMember(skillName) ? packMirrorRoot(output) : output.root;
}

/** Splits `<skill>/<rest>` (relative to .vibe-coding/skills) into its skill name and in-skill path. */
export function splitSkillRel(relPath, separator = sep) {
  const segments = relPath.split(separator);
  if (segments.length < 2) return { name: null, inner: relPath.split(separator).join('/') };
  return { name: segments[0], inner: segments.slice(1).join('/') };
}

function mapMarkdownLinkTargets(text, mapTarget) {
  let fence = null;
  return text
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^\s*(```+|~~~+)/);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1][0];
        else if (fenceMatch[1][0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      const swap = (_whole, head, target) => `${head}${mapTarget(target)}`;
      return line
        .replace(/(\]\(<?)([^)\s>]+)/g, swap)
        .replace(/^(\s*\[[^\]]+\]:\s*<?)(\S+?)(?=>?\s*$)/, swap);
    })
    .join('\n');
}

function splitLinkTarget(target) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return null;
  const cut = target.search(/[#?]/);
  const pathPart = cut === -1 ? target : target.slice(0, cut);
  if (!pathPart) return null;
  return { pathPart, suffix: cut === -1 ? '' : target.slice(cut) };
}

function relativeFrom(fromFile, toPath, trailingSlash) {
  let rel = posix.relative(posix.dirname(fromFile), toPath) || '.';
  if (trailingSlash && !rel.endsWith('/')) rel += '/';
  return rel;
}

// Source -> mirror. A relative link is resolved in SOURCE coordinates; only links into another
// skill whose mirror root (skills vs skill-packs) differs from this file's are recomputed between
// the two mirror locations. Everything else stays byte-identical.
export function rewriteLinksToMirror(text, skillName, innerPath) {
  const srcFile = posix.join('.vibe-coding/skills', skillName, innerPath);
  const ownClass = mirrorClassOf(skillName);
  return mapMarkdownLinkTargets(text, (target) => {
    const parts = splitLinkTarget(target);
    if (!parts) return target;
    const resolved = posix.normalize(posix.join(posix.dirname(srcFile), parts.pathPart));
    if (!resolved.startsWith('.vibe-coding/skills/')) return target;
    const rest = resolved.slice('.vibe-coding/skills/'.length);
    const targetSkill = rest.split('/')[0];
    if (!targetSkill || targetSkill === '..' || mirrorClassOf(targetSkill) === ownClass)
      return target;
    const curMirror = posix.join('m', ownClass, skillName, innerPath);
    const tgtMirror = posix.join('m', mirrorClassOf(targetSkill), rest);
    return relativeFrom(curMirror, tgtMirror, parts.pathPart.endsWith('/')) + parts.suffix;
  });
}

// Mirror -> source (vendor). `actualClass` is the mirror root the file was found in. A link that
// resolves into the OTHER mirror root can only have come from the forward rewrite, so it is turned
// back into a source-relative path; same-root links are left untouched.
export function rewriteLinksFromMirror(text, skillName, innerPath, actualClass) {
  const curMirror = posix.join('m', actualClass, skillName, innerPath);
  const srcFile = posix.join('.vibe-coding/skills', skillName, innerPath);
  return mapMarkdownLinkTargets(text, (target) => {
    const parts = splitLinkTarget(target);
    if (!parts) return target;
    const resolved = posix.normalize(posix.join(posix.dirname(curMirror), parts.pathPart));
    const match = resolved.match(/^m\/(skills|skill-packs)\/(.+)$/);
    if (!match || match[1] === actualClass) return target;
    const srcTarget = posix.join('.vibe-coding/skills', match[2]);
    return relativeFrom(srcFile, srcTarget, parts.pathPart.endsWith('/')) + parts.suffix;
  });
}

function stripBlock(text, begin, end) {
  const start = text.indexOf(`\n\n${begin}`);
  if (start === -1) return text;
  const stop = text.indexOf(end, start);
  if (stop === -1) return text;
  const after = text.slice(stop + end.length).replace(/^\n/, '');
  return `${text.slice(0, start)}\n${after}`;
}

export function stripGeneratedPackBlocks(text) {
  return stripBlock(stripBlock(text, INDEX_BEGIN, INDEX_END), FOOTER_BEGIN, FOOTER_END);
}

function appendBlock(text, block) {
  return `${text.replace(/\n+$/, '')}\n\n${block}\n`;
}

// Reads `description:` from SKILL.md frontmatter: plain, quoted, or `>` / `|` block scalars.
export function parseSkillDescription(text) {
  const fm = normalizeText(text).match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return '';
  const lines = fm[1].split('\n');
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index === -1) return '';
  const head = lines[index].replace(/^description:\s*/, '');
  const continuation = [];
  for (const line of lines.slice(index + 1)) {
    if (line.trim() !== '' && !/^\s/.test(line)) break;
    continuation.push(line.trim());
  }
  while (continuation.length > 0 && continuation[continuation.length - 1] === '')
    continuation.pop();
  if (/^[>|][+-]?\s*$/.test(head)) {
    return continuation.join(head.startsWith('|') ? '\n' : ' ').trim();
  }
  const joined = [head, ...continuation].join(' ').trim();
  if (/^".*"$/.test(joined)) {
    try {
      return JSON.parse(joined);
    } catch {
      return joined.slice(1, -1);
    }
  }
  if (/^'.*'$/.test(joined)) return joined.slice(1, -1).replaceAll("''", "'");
  return joined;
}

function summarizeDescription(description) {
  const flat = description.replace(/\s+/g, ' ').replaceAll('"', '').trim();
  const sentence = flat.match(/^(.*?)(?:[。！？；]|\. |$)/)?.[1] ?? flat;
  const chars = [...sentence];
  const clipped =
    chars.length > SUMMARY_MAX_CHARS
      ? `${chars.slice(0, SUMMARY_MAX_CHARS - 1).join('')}…`
      : sentence;
  return clipped.replaceAll('|', '\\|');
}

function buildPackIndexBlock(pack, sourceSkillsDir) {
  const rows = [...pack.members]
    .sort((a, b) => a.localeCompare(b))
    .filter((member) => existsSync(join(sourceSkillsDir, member, 'SKILL.md')))
    .map((member) => {
      const text = readFileSync(join(sourceSkillsDir, member, 'SKILL.md'), 'utf8');
      const summary = summarizeDescription(parseSkillDescription(text));
      return `| \`${member}\` | ${summary} | [${member}](../../${PACK_MIRROR_DIRNAME}/${member}/SKILL.md) |`;
    });
  return [
    INDEX_BEGIN,
    '## 本包子 skill（按需读取）',
    '',
    '这些子 skill 不在 Skill 工具清单里。按当前任务挑需要的那一个，用 Read 读它的 SKILL.md；正文里提到的 `xxx` skill 或 `/xxx` 同样指这里的路径。不要一次全读。',
    '',
    '| skill | 用途 | 路径 |',
    '| --- | --- | --- |',
    ...rows,
    INDEX_END,
  ].join('\n');
}

function buildPackFooterBlock(pack) {
  return [
    FOOTER_BEGIN,
    `> 本 skill 属于 \`${pack.entry}\` 包，不在 Skill 工具清单里，经入口 [\`${pack.entry}\`](../../skills/${pack.entry}/SKILL.md) 按需读取。正文提到同包其它 skill（如 \`xxx\` 或 \`/xxx\`）时，用 Read 读 \`../<xxx>/SKILL.md\`，不要调用 Skill 工具。`,
    FOOTER_END,
  ].join('\n');
}

export function injectPackBlocks(text, skillName, innerPath, sourceSkillsDir) {
  if (innerPath !== 'SKILL.md') return text;
  const memberPack = packOf(skillName);
  if (memberPack) return appendBlock(text, buildPackFooterBlock(memberPack));
  const entryPack = packOfEntry(skillName);
  if (entryPack) return appendBlock(text, buildPackIndexBlock(entryPack, sourceSkillsDir));
  return text;
}
