#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Refuse a commit that publishes SOME of the co-generated OpenAPI specs.
 *
 * `scripts/openapi/generate.ts` writes three files from one run:
 *
 *   docs/api/api-v1.yaml       ← what native clients FETCH and generate from
 *   docs/api/internal-api.yaml
 *   docs/api/openapi.yaml      ← what this repo's own `openapi:types` reads
 *
 * They are one artifact in three projections. If any spec is staged, every
 * spec that differs from HEAD must be staged too. Unrelated working-tree
 * changes do not trigger this check.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Resolve the repository being committed from Git's current context, including
// worktree hook environments, rather than from the hook script's location.
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
}).trim();

// The public application lives at the Git root; a containing repository can
// place it in a subdirectory. Git's diff output always uses root-relative paths.
const appPrefix = existsSync(join(repoRoot, 'docs', 'api')) ? '' : 'warp10-dashboard/';
const SPECS = ['api-v1.yaml', 'internal-api.yaml', 'openapi.yaml'].map(
    (name) => `${appPrefix}docs/api/${name}`,
);

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

/** Paths staged for this commit, repo-root-relative. */
function stagedPaths() {
    const out = git(['diff', '--cached', '--name-only']);
    return out ? out.split('\n') : [];
}

/**
 * Which of the specs differ from the tip? `git diff HEAD` covers staged AND
 * unstaged changes, which is the union we want: a spec that changed but is
 * neither staged nor committed is precisely the one that gets left behind.
 *
 * Compare root-relative lists so invocation from an application subdirectory
 * does not alter Git pathspec interpretation.
 */
function changedVsHead() {
    const out = git(['diff', 'HEAD', '--name-only']);
    const all = out ? out.split('\n') : [];
    return all.filter((p) => SPECS.includes(p));
}

const staged = new Set(stagedPaths());
const stagedSpecs = SPECS.filter((p) => staged.has(p));

// Not touching the specs → nothing to say. This is the common case and it must
// stay silent, or the check becomes noise on every commit in the repo.
if (stagedSpecs.length === 0) process.exit(0);

const changed = new Set(changedVsHead());
const leftBehind = SPECS.filter((p) => changed.has(p) && !staged.has(p));

if (leftBehind.length === 0) process.exit(0);

console.error('\nOpenAPI spec cohesion check FAILED.\n');
console.error('These specs are being committed:');
for (const p of stagedSpecs) console.error(`  + ${p}`);
console.error('\nbut these also changed and are NOT staged:');
for (const p of leftBehind) console.error(`  ! ${p}`);
console.error(
    '\nThe three specs are one artifact emitted by a single `npm run openapi:generate`\n' +
        'run, so publishing a subset ships a contract that disagrees with itself.\n' +
        'It is worse than it looks: native clients fetch api-v1.yaml, while this repo\n' +
        'reads openapi.yaml — so committing only the latter typechecks here and is\n' +
        'simply absent for them, with the symptom appearing in THEIR sync.\n\n' +
        'Stage the rest:\n' +
        `  git add ${leftBehind.join(' ')}\n\n` +
        'If they changed for an unrelated reason, regenerate first so the commit\n' +
        'carries a consistent set:\n' +
        '  npm run openapi:generate\n',
);
process.exit(1);
