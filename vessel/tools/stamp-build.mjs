#!/usr/bin/env node
/**
 * Stamp a build id into assets/version.json.
 *
 * The main version (`v`) is the release number and is edited by hand. `build` is
 * the commit the files actually came from, plus when it was stamped — that is
 * the thing you need when a change is on screen in one place and not another,
 * and the question is whether the browser is even running the code you just
 * wrote. Shown under the version badge in Dev mode only.
 *
 * Usage:  node vessel/tools/stamp-build.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'assets', 'version.json');

const git = (cmd, fallback) => {
  try { return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch (_) { return fallback; }
};

const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const hash = git('git rev-parse --short HEAD', 'nogit');
// A dirty tree means what is on disk is NOT that commit — say so, or the stamp
// lies exactly when it matters most (mid-session, testing an uncommitted fix).
const dirty = git('git status --porcelain', '') ? '+' : '';

doc.build = hash + dirty;
doc.builtAt = new Date().toISOString().replace('T', ' ').slice(0, 16);

fs.writeFileSync(FILE, JSON.stringify(doc, null, 0) + '\n');
console.log(`version.json -> v${doc.v}  build ${doc.build}  ${doc.builtAt}`);
