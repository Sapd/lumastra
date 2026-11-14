// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JELLYFIN_EMULATED_VERSION } from './constants';

const parse = (v: string): number[] => v.split('.').map((n) => parseInt(n, 10));

function compare(a: string, b: string): number {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
}

describe('JELLYFIN_EMULATED_VERSION', () => {
    it('is a major.minor.patch version', () => {
        expect(JELLYFIN_EMULATED_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('is not older than the newest Jellyfin spec in the contract digest', () => {
        const digest = JSON.parse(
            readFileSync(resolve('tests/jellyfin-contract/jellyfin-contract.json'), 'utf8'),
        ) as { versions: { sdk: string; spec: string }[] };
        const newest = digest.versions
            .map((v) => v.spec)
            .reduce((a, b) => (compare(a, b) >= 0 ? a : b));
        expect(
            compare(JELLYFIN_EMULATED_VERSION, newest),
            `JELLYFIN_EMULATED_VERSION (${JELLYFIN_EMULATED_VERSION}) is older than the newest contract spec ${newest}. ` +
                `Bump it in jellyfin-compat/constants.ts together with re-running \`npx tsx tests/jellyfin-contract/extract.ts\`.`,
        ).toBeGreaterThanOrEqual(0);
    });
});
