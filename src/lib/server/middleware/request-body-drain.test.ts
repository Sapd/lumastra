// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * requestBodyDrainHandle only keeps a keep-alive socket usable after an early
 * answer from a handle it wraps. The seam test
 * (request-body-drain.integration.test.ts) calls the handle directly, so it
 * stays green if the handle moves inward in hooks.server.ts and csrfHandle's
 * 403 or resolveAuth's 401 poison the socket again. This pins its position.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('hooks.server.ts handle order', () => {
    it('runs requestBodyDrainHandle outermost', () => {
        const source = readFileSync(new URL('../../../hooks.server.ts', import.meta.url), 'utf8');
        const chain = source.slice(source.indexOf('export const handle = sequence('));
        const names = [...chain.slice(0, chain.indexOf(');')).matchAll(/^\s*(\w+),$/gm)].map(
            (m) => m[1],
        );
        expect(names[0]).toBe('requestBodyDrainHandle');
        expect(names).toContain('csrfHandle');
    });
});
