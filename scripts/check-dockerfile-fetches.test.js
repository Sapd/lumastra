// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the Dockerfile unverified-fetch / unpinned-install guard.
 *
 * The two "before" fixtures (curl-pipe-tar, npm install -g) are lifted almost
 * verbatim from what this repo's Dockerfile used to do (C9/C10 of the
 * 2026-09-13 security review) — the load-bearing property is that the guard
 * catches those exact shapes, not just contrived ones.
 *
 * Run: npx vitest run scripts/check-dockerfile-fetches.test.js
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, findViolations } from './check-dockerfile-fetches.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dir;

function dockerfile(content) {
    const p = join(dir, 'Dockerfile');
    writeFileSync(p, content);
    return p;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dockerfile-fetches-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('findViolations', () => {
    it('flags curl piped directly into tar with no checksum', () => {
        const content = [
            'FROM ubuntu:24.04',
            'RUN curl -fsSL https://example.com/thing.tar.gz \\',
            '    | tar xz -C /tmp',
        ].join('\n');
        const violations = findViolations(content);
        expect(violations).toHaveLength(1);
        expect(violations[0].kind).toBe('unverified-curl-pipe-tar');
        expect(violations[0].line).toBe(2);
    });

    it('flags curl piped directly into bash (the NodeSource installer shape)', () => {
        const content = 'RUN curl -fsSL https://deb.nodesource.com/setup_25.x | bash -\n';
        const violations = findViolations(content);
        expect(violations.map((v) => v.kind)).toEqual(['unverified-curl-pipe-bash']);
    });

    it('does not flag curl|tar when the same RUN block verifies a checksum first', () => {
        const content = [
            'RUN curl -fsSL -o /tmp/x.tar.gz https://example.com/x.tar.gz \\',
            '    && echo "deadbeef  /tmp/x.tar.gz" | sha256sum -c - \\',
            '    && tar xz -C /tmp -f /tmp/x.tar.gz',
        ].join('\n');
        expect(findViolations(content)).toEqual([]);
    });

    it('does not flag a download-to-file-then-verify RUN with no pipe into tar/bash at all', () => {
        // The actual fix shape: curl -o file, sha256sum -c, THEN a separate
        // (unpiped) tar invocation — no `curl ... | tar` construct exists to flag.
        const content = [
            'RUN curl -fsSL -o /tmp/essentia.tar.gz https://essentia.upf.edu/x.tar.gz; \\',
            '    echo "abc123  /tmp/essentia.tar.gz" | sha256sum -c -; \\',
            '    tar xz -C /tmp -f /tmp/essentia.tar.gz',
        ].join('\n');
        expect(findViolations(content)).toEqual([]);
    });

    it('flags an unpinned `npm install -g <pkg>`', () => {
        const content = 'RUN npm install -g tsx\n';
        const violations = findViolations(content);
        expect(violations).toEqual([
            { line: 1, kind: 'unpinned-npm-install-g', detail: "'tsx' has no @version pin" },
        ]);
    });

    it('does not flag a version-pinned `npm install -g <pkg>@x.y.z`', () => {
        expect(findViolations('RUN npm install -g tsx@4.23.13\n')).toEqual([]);
    });

    it('flags an unpinned `npx --yes <pkg>`', () => {
        const violations = findViolations('RUN npx --yes license-checker-rseidelsohn --json\n');
        expect(violations).toHaveLength(1);
        expect(violations[0].kind).toBe('unpinned-npx-yes');
    });

    it('does not flag a version-pinned `npx --yes <pkg>@x.y.z`', () => {
        expect(findViolations('RUN npx --yes license-checker-rseidelsohn@5.0.1 --json\n')).toEqual(
            [],
        );
    });

    it('does not mistake a scoped package with no version for pinned', () => {
        const violations = findViolations('RUN npx --yes @scope/cli --flag\n');
        expect(violations).toHaveLength(1);
        expect(violations[0].detail).toBe("'@scope/cli' has no @version pin");
    });

    it('accepts a pinned scoped package', () => {
        expect(findViolations('RUN npx --yes @scope/cli@2.0.0 --flag\n')).toEqual([]);
    });

    it('ignores a comment line that merely mentions curl | tar', () => {
        expect(findViolations('# example: curl x | tar xz\nRUN echo hi\n')).toEqual([]);
    });
});

describe('main', () => {
    it('returns 1 and reports the violation for a bad Dockerfile', () => {
        const path = dockerfile('RUN npm install -g tsx\n');
        const code = main(['node', 'check-dockerfile-fetches.mjs', path]);
        expect(code).toBe(1);
        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('unpinned-npm-install-g'),
        );
    });

    it('returns 0 for a clean Dockerfile', () => {
        const path = dockerfile('FROM ubuntu:24.04\nRUN apt-get update\n');
        const code = main(['node', 'check-dockerfile-fetches.mjs', path]);
        expect(code).toBe(0);
    });

    it('returns 1 with a clear message when the file does not exist', () => {
        const code = main(['node', 'check-dockerfile-fetches.mjs', join(dir, 'nope')]);
        expect(code).toBe(1);
        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('cannot read'));
    });
});

// ── Real Dockerfiles (C20/C21 shape) ─────────────────────────────────────────
// The two "before" fixtures above prove the guard catches the exact shapes
// C9/C10 fixed. This scans the ACTUAL Dockerfiles this repo ships (not
// mkdtempSync fixtures) so a future regression fails an actual test, the same
// shape as check-actions-pinned.test.js's "real workflow directories" block —
// neither Dockerfile's content is expected to be RED here (C20's gap is that
// npm run lint:dockerfile-fetches was never wired into CI, not that either
// Dockerfile currently violates it; see lint-gates-wired.test.ts for that).
describe('real Dockerfiles', () => {
    const REPO_ROOT = join(__dirname, '..');

    it('the main Dockerfile has no unverified fetches or unpinned installs', () => {
        const content = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8');
        expect(findViolations(content)).toEqual([]);
    });

    it('the sonic-embedder Dockerfile has no unverified fetches or unpinned installs', () => {
        const content = readFileSync(
            join(REPO_ROOT, 'workers', 'sonic-embedder', 'Dockerfile'),
            'utf8',
        );
        expect(findViolations(content)).toEqual([]);
    });
});
