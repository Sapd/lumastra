// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guards the integration harness: a test file's `vi.mock('$lib/server/...')` must
 * reach server modules the file imports.
 *
 * Until 2026-10-14 the per-file setup (vitest.setup.ts) statically imported the
 * migration runner, which loaded ~120 server modules (logger, config, connection,
 * normalize, media-upsert, ...) before this file's hoisted mocks registered. Those
 * modules kept their real bindings, so a mock silently did nothing for code
 * reached through them. Migrations now run in globalSetup; this test fails if
 * the per-file setup starts preloading server code again.
 *
 * providers/normalize.ts was in that preloaded graph and binds its logger at
 * module load, so it is a direct probe: with the mock applied, its warning lands
 * on the mocked logger.
 */

import { describe, it, expect, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('$lib/server/utils/logger.js', async (importOriginal) => {
    const log = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    return {
        ...(await importOriginal<typeof import('$lib/server/utils/logger.js')>()),
        Logger: { for: () => log },
    };
});

import { normalizeSearchResult } from '$lib/server/providers/normalize.js';

describe('integration harness: vi.mock reach', () => {
    it('a mocked module reaches code that the old setup graph preloaded', () => {
        expect(normalizeSearchResult('mock-reach-probe', {}, 'movie')).toBeNull();
        expect(warn).toHaveBeenCalledWith(
            'no normalizer registered for provider — returning null',
            expect.objectContaining({ providerId: 'mock-reach-probe' }),
        );
    });
});
