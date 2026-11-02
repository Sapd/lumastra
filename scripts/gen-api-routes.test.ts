// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

it('composed device/PAT implementations emit no orphan mounts and leave canonical routes unchanged', () => {
    const canonical = [
        'src/routes/api/v1/devices/[id]/+server.ts',
        'src/routes/api/v1/users/[id]/devices/revoke-all/+server.ts',
        'src/routes/api/v1/users/[id]/pats/+server.ts',
        'src/routes/api/admin/pats/+server.ts',
    ];
    const before = canonical.map((path) => readFileSync(resolve(path), 'utf8'));
    const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/gen-api-routes.ts', '--dry-run'],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
            timeout: 20_000,
        },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/changed:\s+0/);
    for (const path of [
        'src/routes/api/admin/devices/all/+server.ts',
        'src/routes/api/v1/admin/devices/all/+server.ts',
        'src/routes/api/v1/admin/pats/+server.ts',
        'src/routes/api/devices/revoke/+server.ts',
        'src/routes/api/v1/devices/revoke/+server.ts',
    ]) {
        expect(result.stdout).not.toContain(path);
        expect(existsSync(resolve(path))).toBe(false);
    }
    expect(canonical.map((path) => readFileSync(resolve(path), 'utf8'))).toEqual(before);
}, 30_000);
