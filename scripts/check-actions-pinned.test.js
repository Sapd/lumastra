// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the GitHub Actions SHA-pin guard.
 *
 * Run: npx vitest run scripts/check-actions-pinned.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, findUnpinnedActions } from './check-actions-pinned.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir;

function workflow(name, content) {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'actions-pinned-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('findUnpinnedActions', () => {
    it('flags a tag-pinned uses:', () => {
        workflow(
            'ci.yml',
            ['jobs:', '  build:', '    steps:', '      - uses: actions/checkout@v7.0.1', ''].join(
                '\n',
            ),
        );
        const violations = findUnpinnedActions(dir);
        expect(violations).toEqual([{ file: 'ci.yml', line: 4, uses: 'actions/checkout@v7.0.1' }]);
    });

    it('accepts a 40-hex SHA pin with a trailing version comment', () => {
        workflow(
            'ci.yml',
            [
                'jobs:',
                '  build:',
                '    steps:',
                '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1',
                '',
            ].join('\n'),
        );
        expect(findUnpinnedActions(dir)).toEqual([]);
    });

    it('rejects a SHA-shaped ref that is short of 40 hex chars', () => {
        workflow(
            'ci.yml',
            ['jobs:', '  build:', '    steps:', '      - uses: actions/checkout@abc1234', ''].join(
                '\n',
            ),
        );
        expect(findUnpinnedActions(dir)).toHaveLength(1);
    });

    it('ignores a local composite action and a docker:// reference', () => {
        workflow(
            'ci.yml',
            [
                'jobs:',
                '  build:',
                '    steps:',
                '      - uses: ./.github/actions/local-thing',
                '      - uses: docker://alpine:3.19',
                '',
            ].join('\n'),
        );
        expect(findUnpinnedActions(dir)).toEqual([]);
    });

    it('scans every workflow file in the directory, not just one', () => {
        workflow('a.yml', '      - uses: actions/checkout@v7.0.1\n');
        workflow('b.yaml', '      - uses: docker/login-action@v3.6.0\n');
        workflow('README.md', 'not a workflow, ignored');
        const violations = findUnpinnedActions(dir);
        expect(violations.map((v) => v.file).sort()).toEqual(['a.yml', 'b.yaml']);
    });

    it('throws a clear error when the directory does not exist', () => {
        expect(() => findUnpinnedActions(join(dir, 'does-not-exist'))).toThrow(/cannot read/);
    });
});

describe('main', () => {
    it('returns 1 and reports the file:line for an unpinned action', () => {
        workflow('ci.yml', '      - uses: actions/checkout@v7.0.1\n');
        const code = main(['node', 'check-actions-pinned.mjs', dir]);
        expect(code).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ci.yml:1'));
    });

    it('scans workflows at the public application root without a parent directory', () => {
        const app = join(dir, 'public');
        mkdirSync(join(app, '.github', 'workflows'), { recursive: true });
        writeFileSync(
            join(app, '.github', 'workflows', 'ci.yml'),
            'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n',
        );
        vi.spyOn(process, 'cwd').mockReturnValue(app);
        expect(main(['node', 'check-actions-pinned.mjs'])).toBe(0);
        expect(main(['node', 'check-actions-pinned.mjs', '--include-parent'])).toBe(0);
    });

    it('scans existing parent workflows when requested', () => {
        const app = join(dir, 'app');
        mkdirSync(join(app, '.github', 'workflows'), { recursive: true });
        mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
        writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'uses: actions/checkout@v7\n');
        vi.spyOn(process, 'cwd').mockReturnValue(app);
        expect(main(['node', 'check-actions-pinned.mjs', '--include-parent'])).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ci.yml:1'));
    });

    it('returns 1 for an explicitly requested missing directory', () => {
        expect(main(['node', 'check-actions-pinned.mjs', join(dir, 'missing')])).toBe(1);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('cannot read workflows dir'),
        );
    });

    it('returns 0 when every reference in the directory is pinned', () => {
        workflow(
            'ci.yml',
            '      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
        );
        const code = main(['node', 'check-actions-pinned.mjs', dir]);
        expect(code).toBe(0);
    });
});

describe('real workflow directories', () => {
    const ROOT_WORKFLOWS_DIR = join(__dirname, '..', '..', '.github', 'workflows');
    const NESTED_WORKFLOWS_DIR = join(__dirname, '..', '.github', 'workflows');

    // The root set exists only in the private repo layout; the public tree has the app at
    // its root, so there is no `../.github` there to scan.
    it.skipIf(!existsSync(ROOT_WORKFLOWS_DIR))(
        'the root .github/workflows set (../.github/workflows) is fully SHA-pinned',
        () => {
            expect(findUnpinnedActions(ROOT_WORKFLOWS_DIR)).toEqual([]);
        },
    );

    it('the application workflows are fully SHA-pinned', () => {
        expect(findUnpinnedActions(NESTED_WORKFLOWS_DIR)).toEqual([]);
    });

    it('lint:actions scans application workflows and optionally the parent workflows', () => {
        const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
        expect(packageJson.scripts['lint:actions']).toBe(
            'node scripts/check-actions-pinned.mjs --include-parent',
        );
    });
});
