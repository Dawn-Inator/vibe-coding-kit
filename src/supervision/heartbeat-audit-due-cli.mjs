#!/usr/bin/env node
// Read-only advisory CLI for the 20-minute heartbeat audit cadence.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitDrained } from '../lib/exit-drained.mjs';
import { heartbeatAuditDue, parseStrictIsoTimestamp } from './heartbeat-audit-due.mjs';

function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  try { return Boolean(argv1) && realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

function parseArgs(args) {
  let ledger = null;
  let now;
  let minutes = 20;
  let json = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--now' || arg === '--minutes' || arg === '--json') {
      if (seen.has(arg)) throw new TypeError(`${arg} may be specified only once`);
      seen.add(arg);
      if (arg === '--json') { json = true; continue; }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new TypeError(`${arg} requires a value`);
      index += 1;
      if (arg === '--now') {
        const timestamp = parseStrictIsoTimestamp(value, { requireTimezone: true });
        if (timestamp === null) {
          throw new TypeError('--now must be an ISO date with a timezone');
        }
        now = new Date(timestamp);
      } else {
        minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes <= 0) throw new TypeError('--minutes must be a finite number greater than 0');
      }
      continue;
    }
    if (arg.startsWith('--')) throw new TypeError(`unknown option ${arg}`);
    if (ledger !== null) throw new TypeError('exactly one ledger path is required');
    ledger = arg;
  }
  if (!ledger) throw new TypeError('exactly one ledger path is required');
  return { ledger, now, minutes, json };
}

export function main(args = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(args); }
  catch (error) {
    process.stderr.write(`heartbeat-audit-due: ${error.message}\nusage: heartbeat-audit-due-cli.mjs <ledger> [--now ISO] [--minutes N] [--json]\n`);
    exitDrained(2);
    return;
  }

  let text;
  try { text = readFileSync(resolve(process.cwd(), options.ledger), 'utf8'); }
  catch (error) {
    process.stderr.write(`heartbeat-audit-due: cannot read ${options.ledger}: ${error.message}\n`);
    exitDrained(2);
    return;
  }

  let result;
  try { result = heartbeatAuditDue(text, { now: options.now ?? new Date(), intervalMinutes: options.minutes }); }
  catch (error) {
    process.stderr.write(`heartbeat-audit-due: ${error.message}\n`);
    exitDrained(2);
    return;
  }
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`heartbeat-audit-due: ${result.due ? 'DUE' : 'NOT DUE'} (${result.reason})\n`);
  exitDrained(0);
}

if (isMainModule(import.meta.url)) main();
