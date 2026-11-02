// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-openapi-spec-cohesion.mjs');
const names = ['api-v1.yaml', 'internal-api.yaml', 'openapi.yaml'];
let repo;

function git(args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'openapi-cohesion-'));
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.invalid']);
});

afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
});

describe.each(['', 'warp10-dashboard/'])('OpenAPI cohesion in layout %s', (prefix) => {
    it('rejects a partial spec commit and accepts all changed specs staged', () => {
        const app = join(repo, prefix);
        const specs = join(app, 'docs', 'api');
        mkdirSync(specs, { recursive: true });
        for (const name of names) writeFileSync(join(specs, name), 'initial\n');
        git(['add', '--', ...names.map((name) => `${prefix}docs/api/${name}`)]);
        git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture']);
        writeFileSync(join(specs, 'api-v1.yaml'), 'changed\n');
        writeFileSync(join(specs, 'openapi.yaml'), 'changed\n');
        // Working-tree spec changes alone do not trigger the staged-commit check.
        expect(spawnSync(process.execPath, [script], { cwd: app }).status).toBe(0);
        git(['add', '--', `${prefix}docs/api/openapi.yaml`]);
        for (const cwd of new Set([repo, app])) {
            const partial = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
            expect(partial.status).toBe(1);
            expect(partial.stderr).toContain(`! ${prefix}docs/api/api-v1.yaml`);
        }
        git(['add', '--', `${prefix}docs/api/api-v1.yaml`]);
        expect(spawnSync(process.execPath, [script], { cwd: app }).status).toBe(0);
    });
});
