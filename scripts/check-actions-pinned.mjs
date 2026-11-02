// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GitHub Actions supply-chain pin guard.
 *
 * A `uses: owner/repo@vX.Y.Z` in a workflow resolves the *tag*, not a fixed
 * commit — the tag owner can repoint it at any time (or lose control of their
 * account) and the next run silently executes different code with whatever
 * secrets that job has in scope. Every action reference must instead pin the
 * 40-hex commit SHA it resolves to, with the human-readable version kept as a
 * trailing `# vX.Y.Z` comment so it's still reviewable at a glance:
 *
 *   uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
 *
 * Scans `.github/workflows` in the current application directory by default.
 * `--include-parent` also scans `../.github/workflows` when it exists, for
 * repositories with application code in a subdirectory. An explicit directory
 * argument must exist. Local and Docker-image action references are exempt.
 *
 * Run: `node scripts/check-actions-pinned.mjs [dir | --include-parent]`.
 * Exits 1 for unpinned references or an unreadable requested directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// `uses: owner/repo@ref` (optionally quoted), capturing the ref. Composite
// `uses: ./local-action` and `uses: docker://image` forms never match this
// (no `@`), so they're implicitly exempt.
const USES_RE = /^(\s*(?:-\s+)?uses:\s*)['"]?([^'"\s#]+)@([^'"\s#]+)['"]?\s*(#.*)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Find every `uses:` reference in a workflow YAML file that is not pinned to
 * a 40-hex commit SHA. Returns [{ line, uses, ref }].
 */
function findUnpinnedInFile(content) {
    const violations = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(USES_RE);
        if (!match) continue;
        const [, , action, ref] = match;
        if (action.startsWith('./') || action.startsWith('docker://')) continue;
        if (!SHA_RE.test(ref)) {
            violations.push({ line: i + 1, uses: `${action}@${ref}` });
        }
    }
    return violations;
}

/**
 * Scan every *.yml / *.yaml in `dir` (non-recursive — workflow files are
 * flat) for unpinned `uses:` references. Returns [{ file, line, uses }].
 */
function findUnpinnedActions(dir) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch (err) {
        // `cause` keeps the original readdir failure (ENOENT vs EACCES) attached
        // rather than flattening it into a string — the repo's
        // preserve-caught-error rule.
        throw new Error(`cannot read workflows dir '${dir}'`, { cause: err });
    }
    const violations = [];
    for (const entry of entries.sort()) {
        if (!/\.ya?ml$/.test(entry)) continue;
        const full = join(dir, entry);
        if (!statSync(full).isFile()) continue;
        const content = readFileSync(full, 'utf8');
        for (const v of findUnpinnedInFile(content)) {
            violations.push({ file: entry, ...v });
        }
    }
    return violations;
}

function main(argv) {
    const includeParent = argv[2] === '--include-parent';
    const dir = includeParent || !argv[2] ? join(process.cwd(), '.github', 'workflows') : argv[2];
    const parentDir = join(process.cwd(), '..', '.github', 'workflows');
    const directories = [dir];
    if (includeParent && existsSync(parentDir)) directories.push(parentDir);
    return directories.reduce((code, directory) => scanDirectory(directory) || code, 0);
}

function scanDirectory(dir) {
    let violations;
    try {
        violations = findUnpinnedActions(dir);
    } catch (err) {
        console.error(`check-actions-pinned: ${err.message}`);
        return 1;
    }
    if (violations.length === 0) {
        console.log(
            `check-actions-pinned: all 'uses:' references in ${relative(process.cwd(), dir) || dir} are SHA-pinned.`,
        );
        return 0;
    }
    console.error(`check-actions-pinned: ${violations.length} unpinned action reference(s):`);
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  uses: ${v.uses}`);
    }
    console.error(
        '\nPin each to its commit SHA: gh api repos/<owner>/<repo>/commits/<tag> --jq .sha, ' +
            'then `uses: owner/repo@<40-hex> # <tag>`.',
    );
    return 1;
}

// Only run when invoked directly, so the tests can import the helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    process.exit(main(process.argv));
}

export { main, findUnpinnedActions, findUnpinnedInFile };
