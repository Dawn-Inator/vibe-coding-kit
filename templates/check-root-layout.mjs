#!/usr/bin/env node
// Project-owned policy. Keep in sync with docs/repository-layout.md.
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { checkRepositoryLayout } from '../../../.vibe-coding/kit/src/layout/check-root-layout.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const allowedRootDirectories = new Set(['.vibe-coding', 'docs', 'engineering']);
const retiredRootDirectories = new Map();

try {
  checkRepositoryLayout({ projectRoot, allowedRootDirectories, retiredRootDirectories });
  console.log('Repository root layout is valid.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
