import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const PRINT_WIDTH = 100;
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// js/prototype-pollution-utility: env/source keys come from parsed JSON, so a `__proto__` /
// `constructor` / `prototype` key must never be merged. Rejected (fail closed), not silently dropped.
const UNSAFE_MERGE_KEYS = Object.freeze(new Set(['__proto__', 'constructor', 'prototype']));

/** Deep merge: objects recurse, everything else (arrays, scalars, null) is replaced. */
export function deepMerge(base, overlay) {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return structuredClone(overlay);
  const out = {};
  for (const key of Object.keys(base)) {
    if (UNSAFE_MERGE_KEYS.has(key)) throw new Error(`deepMerge: refusing unsafe key ${JSON.stringify(key)}`);
    out[key] = structuredClone(base[key]);
  }
  for (const key of Object.keys(overlay)) {
    if (UNSAFE_MERGE_KEYS.has(key)) throw new Error(`deepMerge: refusing unsafe key ${JSON.stringify(key)}`);
    out[key] = Object.hasOwn(out, key) ? deepMerge(out[key], overlay[key]) : structuredClone(overlay[key]);
  }
  return out;
}

function isScalar(value) {
  return value === null || typeof value !== 'object';
}

function serialize(value, indent, prefixLen) {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
      if (pad.length + prefixLen + inline.length + 1 <= PRINT_WIDTH) return inline;
      return `[\n${value.map((item) => `${pad}  ${JSON.stringify(item)}`).join(',\n')}\n${pad}]`;
    }
    return `[\n${value.map((item) => `${pad}  ${serialize(item, indent + 1, 0)}`).join(',\n')}\n${pad}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const body = keys.map((key) => {
      const head = JSON.stringify(key);
      return `${pad}  ${head}: ${serialize(value[key], indent + 1, head.length + 4)}`;
    });
    return `{\n${body.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic text form shared by regen and the freshness check. */
export function serializeConfig(config) {
  return `${serialize(config, 0, 0)}\n`;
}


function validateKeys(value) {
  if (Array.isArray(value)) return value.forEach(validateKeys);
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_MERGE_KEYS.has(key)) throw new Error(`refusing unsafe key ${JSON.stringify(key)}`);
    validateKeys(child);
  }
}

/** Create a consumer-owned environment renderer. Paths and stage names belong to the consumer. */
export function createEnvironmentRenderer({ stages, paths, bannerKey, bannerFor }) {
  if (!Array.isArray(stages) || !stages.length || stages.some(s => typeof s !== 'string' || !s) || new Set(stages).size !== stages.length) {
    throw new Error('stages must be a nonempty list of unique names');
  }
  const configuredStages = [...stages];
  if (typeof paths !== 'function' || typeof bannerFor !== 'function' || typeof bannerKey !== 'string' || !bannerKey || UNSAFE_MERGE_KEYS.has(bannerKey)) {
    throw new Error('paths, bannerKey and bannerFor are required');
  }
  function render(stage, options = {}) {
    if (!configuredStages.includes(stage)) throw new Error(`unknown rendered stage: ${stage}`);
    const files = paths(stage, options.rootDir);
    const read = (file, label) => {
      if (!existsSync(file)) throw new Error(`${label} is missing: ${file}`);
      let value;
      try { value = JSON.parse(readFileSync(file, 'utf8')); }
      catch (error) { throw new Error(`invalid JSON in ${label}: ${error.message}`); }
      if (!isPlainObject(value)) throw new Error(`${label} for ${stage} must be a JSON object`);
      if (Object.hasOwn(value, bannerKey)) throw new Error(`${bannerKey} is generated; remove it from ${label}`);
      validateKeys(value);
      return value;
    };
    const base = read(files.base, 'base');
    const overlay = read(files.overlay, 'overlay');
    return { [bannerKey]: bannerFor(stage), ...deepMerge(base, overlay) };
  }
  const text = (stage, options) => serializeConfig(render(stage, options));
  function check(options = {}) {
    return configuredStages.filter(stage => {
      const file = paths(stage, options.rootDir).rendered;
      const expected = text(stage, options);
      return !existsSync(file) || readFileSync(file, 'utf8') !== expected;
    });
  }
  function regen(options = {}) {
    // Render every stage before writing so invalid input cannot leave partial results.
    const rendered = configuredStages.map(stage => ({ stage, file: paths(stage, options.rootDir).rendered, text: text(stage, options) }));
    const written = [];
    for (const item of rendered) {
      if (!existsSync(item.file) || readFileSync(item.file, 'utf8') !== item.text) {
        mkdirSync(dirname(item.file), { recursive: true });
        writeFileSync(item.file, item.text);
        written.push(item.stage);
      }
    }
    return written;
  }
  return { render, text, check, regen };
}

/** Branch mapping is a lookup only; it does not authorize a deployment. */
export function resolveBranchEnvironment({ branches, environments, branch, environment }) {
  if (!isPlainObject(branches) || !Array.isArray(environments) || !environments.length || new Set(environments).size !== environments.length || environments.some(x => typeof x !== 'string' || !x)) throw new Error('invalid environment mapping');
  for (const [name, stage] of Object.entries(branches)) {
    if (!name || UNSAFE_MERGE_KEYS.has(name) || !environments.includes(stage)) throw new Error(`invalid mapping for branch ${name}`);
  }
  const mapped = typeof branch === 'string' && Object.hasOwn(branches, branch) ? branches[branch] : undefined;
  if (branch && !mapped) throw new Error(`unknown branch: ${branch}`);
  if (environment && !environments.includes(environment)) throw new Error(`unknown environment: ${environment}`);
  if (mapped && environment && mapped !== environment) throw new Error('branch and environment conflict');
  if (!mapped && !environment) throw new Error('branch or environment is required');
  return mapped || environment;
}
