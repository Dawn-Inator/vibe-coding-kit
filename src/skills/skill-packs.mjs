// Skill packs: the single source of truth for which `.vibe-coding/skills/<name>` directories are
// "pack members" instead of top-level skills.
//
// Why: Claude Code / Codex inject every `<root>/skills/*/SKILL.md` frontmatter (name + description)
// into a per-turn skill listing that has a small budget. A domain with a dozen-plus skills that are
// only used for one kind of task (a vendor CLI's skill set, a video toolchain, ...) eats that budget
// every turn and gets the core engineering skills' descriptions truncated. The canonical source stays
// flat (`.vibe-coding/skills/<name>/`), but `sync-skills.mjs sync` mirrors pack MEMBERS into
// `<root>/skill-packs/<name>/` (flat, same depth as `skills/<name>`) so they are never listed. Each
// pack has one ENTRY skill that stays in `skills/`; the AI enters the entry and then Reads a member's
// SKILL.md on demand (see skill-pack-mirror.mjs for the generated index / footer blocks).
//
// When to make a pack: the same domain, about ten or more skills, only needed for specific tasks and
// never the trigger of everyday engineering work. Everything else stays a plain top-level skill.
//
// How to register one: write the entry skill (`.vibe-coding/skills/<entry>/SKILL.md`, with a wide
// description that covers the whole domain) and add an object to SKILL_PACKS below:
//
//   freezePack({ id: 'lark', entry: 'lark', members: ['lark-doc', 'lark-im', ...], memberPrefix: 'lark-' }),
//
// `memberPrefix` is the fail-closed guard: once a pack declares one, a source skill whose name starts
// with that prefix but is not registered makes `check` fail, so a freshly installed upstream skill
// can never silently land in the per-turn listing. Leave it null for packs without a naming prefix.
//
// Test seam: fixtures cannot use real member names, so the CLI accepts
// `--skill-packs-config <json path>` (an array of pack objects shaped like SKILL_PACKS). It is only
// honored together with `--root`, so a real repository can never be re-configured by accident.
// The CLI applies it through overrideSkillPacks() before any mapping happens.

export const PACK_MIRROR_DIRNAME = 'skill-packs';

function freezePack(pack) {
  return Object.freeze({ ...pack, members: Object.freeze([...pack.members]) });
}

// Empty by default: a fresh project has no packs and `sync-skills.mjs` behaves exactly as before.
export const SKILL_PACKS = Object.freeze([]);

let activePacks = SKILL_PACKS;

/** Replace the active pack list (tests / `--skill-packs-config` only). Shape is checked loudly. */
export function overrideSkillPacks(packs) {
  if (!Array.isArray(packs)) throw new Error('skill packs config must be a JSON array');
  for (const pack of packs) {
    if (!pack || typeof pack.id !== 'string' || typeof pack.entry !== 'string' || !Array.isArray(pack.members)) {
      throw new Error('each skill pack needs string id, string entry and array members');
    }
  }
  activePacks = Object.freeze(packs.map((pack) => freezePack({ memberPrefix: null, ...pack })));
}

/** The pack that lists `skillName` as a member (the entry is NOT a member), or null. */
export function packOf(skillName) {
  return activePacks.find((pack) => pack.members.includes(skillName)) ?? null;
}

export function isPackMember(skillName) {
  return packOf(skillName) !== null;
}

/** The pack whose entry skill is `skillName`, or null. */
export function packOfEntry(skillName) {
  return activePacks.find((pack) => pack.entry === skillName) ?? null;
}

/** Returns error strings (empty array = valid). Fails closed on unregistered `<memberPrefix>*` dirs. */
export function validateSkillPacks(sourceSkillNames, packs = activePacks) {
  const errors = [];
  const sources = new Set(sourceSkillNames);
  const owner = new Map();
  const registered = new Set();

  for (const pack of packs) {
    registered.add(pack.entry);
    if (!sources.has(pack.entry)) {
      errors.push(`skill pack '${pack.id}': entry skill '${pack.entry}' is missing from .vibe-coding/skills`);
    }
    for (const member of pack.members) {
      registered.add(member);
      if (member === pack.entry) {
        errors.push(`skill pack '${pack.id}': entry '${pack.entry}' must not also be listed as a member`);
      }
      if (!sources.has(member)) {
        errors.push(`skill pack '${pack.id}': member '${member}' is missing from .vibe-coding/skills`);
      }
      if (owner.has(member) && owner.get(member) !== pack.id) {
        errors.push(`skill '${member}' is a member of two packs: '${owner.get(member)}' and '${pack.id}'`);
      }
      owner.set(member, pack.id);
    }
  }

  for (const pack of packs) {
    if (!pack.memberPrefix) continue;
    for (const name of sources) {
      if (name.startsWith(pack.memberPrefix) && !registered.has(name)) {
        errors.push(
          `skill '${name}' looks like a '${pack.id}' pack member (prefix '${pack.memberPrefix}') but is not registered in SKILL_PACKS; add it to engineering/automation/agent-skills/skill-packs.mjs`,
        );
      }
    }
  }

  return errors;
}
