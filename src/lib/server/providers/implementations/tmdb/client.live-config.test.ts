// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression lock: the TMDB client must read its API key LIVE, never capture it.
 *
 * `config.TMDB_API_KEY` is a getter that resolves settings.json -> env -> default
 * at call time (config.ts). The singleton `tmdbApi` is constructed at module
 * import, i.e. at process boot. Capturing the key into a `readonly` field there
 * meant an operator who entered their key in the admin UI (settings.json) after
 * the process started got `isAvailable() === false` forever, until a restart.
 *
 * Observed in production as "series poster and episode thumbs render, season
 * posters do not": season posters are the only artwork slot that needs a LIVE
 * TMDB call, so they were the only visible casualty.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
    TMDB_API_KEY: '',
    TMDB_LANGUAGE: 'en-US',
}));

vi.mock('$lib/server/config', () => ({ config: cfg }));

// Imported AFTER the mock is registered. The singleton is constructed here,
// while TMDB_API_KEY is still '' — exactly the production boot ordering.
const { tmdbApi, createTMDBApi } = await import('./client.js');

describe('TMDBApiService — live config reads', () => {
    beforeEach(() => {
        cfg.TMDB_API_KEY = '';
    });

    it('is unavailable while no key is configured', () => {
        expect(tmdbApi.isAvailable()).toBe(false);
    });

    it('picks up a key configured AFTER the module was loaded, with no restart', () => {
        expect(tmdbApi.isAvailable()).toBe(false);

        // Operator pastes their key into the admin UI -> settings.json.
        cfg.TMDB_API_KEY = 'key-set-after-boot';

        expect(tmdbApi.isAvailable()).toBe(true);
    });

    it('goes unavailable again when the key is cleared', () => {
        cfg.TMDB_API_KEY = 'key-set-after-boot';
        expect(tmdbApi.isAvailable()).toBe(true);

        cfg.TMDB_API_KEY = '';
        expect(tmdbApi.isAvailable()).toBe(false);
    });

    it('applies to per-call instances too, not just the singleton', () => {
        const api = createTMDBApi('de-DE');
        expect(api.isAvailable()).toBe(false);

        cfg.TMDB_API_KEY = 'key-set-after-boot';
        expect(api.isAvailable()).toBe(true);
    });
});
