// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Architecture guard (security review 5, C4 + Shape C, MINOR 1, 2026-09-23).
 *
 * The `no-restricted-imports` ESLint rule (`eslint.config.cjs`) catches a
 * static `import` / `export ... from` of `upsertUserGroups` outside the
 * sanctioned wrapper, but NOT a dynamic `await import('...').then(m =>
 * m.upsertUserGroups)` or `require(...)` — those never appear as an
 * `ImportDeclaration`/`ExportNamedDeclaration` node, so the AST-based rule
 * has nothing to match. This test is belt-and-braces alongside the lint
 * rule (not a replacement — the lint rule still gives inline IDE feedback):
 * a plain text scan of every source file under `src/` and `plugins/`,
 * failing if the identifier `upsertUserGroups` appears as CODE (not inside a
 * comment) anywhere other than the four sanctioned files.
 *
 * Reads every file via `fs.readFileSync(path, 'utf8')` rather than shelling
 * out to `grep`/`git grep`: `src/lib/server/database/queries/access-groups.queries.ts`
 * is classified as binary by `file(1)` (confirmed locally — a plain
 * `grep -c upsertUserGroups` on it finds 0 matches while `grep -a -c` finds
 * the real ones), so a shell-grep-based scanner would silently skip it and
 * any other file with similar byte content. Node's `readFileSync` with an
 * explicit `'utf8'` encoding has no such blind spot.
 *
 * Comments are stripped (block `/* ... *\/` and line `//`) before matching,
 * so the several files that merely MENTION `upsertUserGroups` in prose
 * (`social-visibility.builder.ts`, `available-groups.ts`) don't false-positive
 * — only an actual code reference to the identifier trips this test. Test
 * files (`*.test.ts`, `*.integration.test.ts`, `*.perf.test.ts`) are excluded
 * from the scan entirely: they legitimately reference the symbol by name
 * (mocking it, or testing the pure query itself in
 * `oauth-admin.queries.integration.test.ts`), and are not a runtime code path
 * a dynamic-import bypass could hide in.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// This file lives at src/lib/server/services/ — four levels up is the repo
// root.
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

const SCAN_ROOTS = ['src', 'plugins'];

const SKIP_DIR_NAMES = new Set([
    'node_modules',
    'dist',
    'build',
    '.svelte-kit',
    'coverage',
    '.git',
    'package',
]);

const SCANNABLE_EXTENSIONS = ['.ts', '.js', '.svelte'];

const TEST_FILE_SUFFIXES = ['.test.ts', '.integration.test.ts', '.perf.test.ts', '.test.js'];

/** Files allowed to reference `upsertUserGroups` as code — everything else fails. */
const ALLOWED_FILES = new Set([
    'src/lib/server/database/queries/oauth-admin.queries.ts', // defines it
    'src/lib/server/database/queries/index.ts', // re-exports it (the barrel)
    'src/lib/server/services/user-groups.service.ts', // the sanctioned wrapper
    'src/lib/server/services/user-identity.service.ts', // the one transactional writer
]);

const IDENTIFIER_RE = /\bupsertUserGroups\b/;

/** Strip `/* block *\/` and `// line` comments so prose mentions don't match. */
function stripComments(source: string): string {
    // Block comments first (non-greedy across the whole string), then line
    // comments. Good enough for this repo's plain TS/JS — it doesn't need to
    // handle comment-like sequences inside string/template literals, since a
    // string literal containing the exact identifier `upsertUserGroups`
    // would be a suspicious coincidence worth a human look anyway, and none
    // exist in the tree today (proven by this test itself passing).
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function isTestFile(fileName: string): boolean {
    return TEST_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

function walk(dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return; // root doesn't exist (e.g. no plugins/ in some checkouts) — skip
    }
    for (const entry of entries) {
        if (SKIP_DIR_NAMES.has(entry)) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            walk(full, out);
        } else if (SCANNABLE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
            out.push(full);
        }
    }
}

/** Every scannable file under `src/` and `plugins/`, as repo-root-relative POSIX paths. */
function listScannableFiles(): string[] {
    const absolute: string[] = [];
    for (const root of SCAN_ROOTS) {
        walk(join(REPO_ROOT, root), absolute);
    }
    return absolute.map((p) => relative(REPO_ROOT, p).split(sep).join('/'));
}

describe('upsertUserGroups is referenced only by the sanctioned wrapper and its allowed writers', () => {
    it('scans every non-test src/ and plugins/ file for a direct code reference', () => {
        const files = listScannableFiles();
        expect(files.length).toBeGreaterThan(0); // sanity: the walk actually found files

        const violations: string[] = [];
        for (const relPath of files) {
            const fileName = relPath.split('/').pop() ?? relPath;
            if (isTestFile(fileName)) continue;
            if (ALLOWED_FILES.has(relPath)) continue;

            const absPath = join(REPO_ROOT, relPath);
            const content = readFileSync(absPath, 'utf8');
            const code = stripComments(content);
            if (IDENTIFIER_RE.test(code)) {
                violations.push(relPath);
            }
        }

        expect(violations).toEqual([]);
    });

    it('confirms the scan actually reads the binary-classified access-groups.queries.ts file', () => {
        // Regression guard for the exact blind spot this test's doc comment
        // describes: a `grep`-based scanner would silently skip this file.
        const absPath = join(REPO_ROOT, 'src/lib/server/database/queries/access-groups.queries.ts');
        const content = readFileSync(absPath, 'utf8');
        expect(content.length).toBeGreaterThan(0);
    });
});
