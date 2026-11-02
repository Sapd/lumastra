// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Installs the git hooks in .husky/ for whichever layout this package sits in: at the
// repository root (the public repo) or as a subdirectory of a larger checkout. Git wants
// core.hooksPath relative to the repository root, so compute the prefix instead of
// hard-coding one. Skips quietly where there is no git checkout or no husky (Docker
// builds with --omit=dev, tarball installs).
//
// Then pins core.hooksPath to the MAIN checkout's absolute .husky/_. husky writes it
// relative, and a relative hooksPath resolves inside each `git worktree`, where .husky/_
// is gitignored and absent: git finds no hooks there and commits pass unchecked, with no
// warning. The hooks resolve the tree they check from the working directory
// (.husky/resolve-app-dir.sh), so one shared copy serves every worktree.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

try {
    const opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const git = (...args) => execFileSync('git', args, opt).trim();
    const top = git('rev-parse', '--show-toplevel');
    const prefix = git('rev-parse', '--show-prefix');
    execFileSync('husky', [`${prefix}.husky`], { cwd: top, stdio: 'inherit' });

    // The main checkout is the parent of the common .git directory, even when this
    // install runs in a linked worktree. Pinning a linked worktree's own copy would
    // break every checkout's hooks once that worktree is removed.
    const commonDir = git('rev-parse', '--path-format=absolute', '--git-common-dir');
    const shared = join(dirname(commonDir), prefix, '.husky', '_');
    if (existsSync(join(shared, 'h'))) git('config', 'core.hooksPath', shared);
} catch {
    console.log('prepare-husky: no git checkout or husky not installed — skipping hook setup');
}
