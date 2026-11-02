// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Final fix wave (2026-09-13): EMBEDDING_ALLOW_PRIVATE_URLS must reach the
 * task-scoped ctx.dep('embeddings') path, not just the interactive path
 * (ai/voyage.ts's guardedDefaultFetch). EMBEDDINGS_DEP.allowPrivateUrls is
 * the wiring point RateLimiter.forDep() reads (see rate-limiter.test.ts's
 * "RateLimiter — allowPrivateUrls" suite for the fetch-level behavior); this
 * suite verifies the dep declaration itself reflects the live config value.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let allowPrivateUrls = false;
vi.mock('$lib/server/config.js', () => ({
    config: {
        get EMBEDDING_ALLOW_PRIVATE_URLS() {
            return allowPrivateUrls;
        },
        VOYAGE_API_KEY: '',
        EMBEDDING_BASE_URL: '',
        EMBEDDING_API_KEY: '',
        OPENAI_API_KEY: '',
    },
}));

import { EMBEDDINGS_DEP } from './embedding-dep.js';

describe('EMBEDDINGS_DEP.allowPrivateUrls', () => {
    beforeEach(() => {
        allowPrivateUrls = false;
    });

    it('is defined so RateLimiter.forDep() has an opt-in to read', () => {
        expect(typeof EMBEDDINGS_DEP.allowPrivateUrls).toBe('function');
    });

    it('returns false when EMBEDDING_ALLOW_PRIVATE_URLS is off (default — public-only guard)', () => {
        allowPrivateUrls = false;
        expect(EMBEDDINGS_DEP.allowPrivateUrls?.()).toBe(false);
    });

    it('returns true when EMBEDDING_ALLOW_PRIVATE_URLS is on', () => {
        allowPrivateUrls = true;
        expect(EMBEDDINGS_DEP.allowPrivateUrls?.()).toBe(true);
    });

    it('reads the config value LIVE on every call, not once at module load', () => {
        allowPrivateUrls = false;
        expect(EMBEDDINGS_DEP.allowPrivateUrls?.()).toBe(false);

        allowPrivateUrls = true;
        expect(EMBEDDINGS_DEP.allowPrivateUrls?.()).toBe(true);

        allowPrivateUrls = false;
        expect(EMBEDDINGS_DEP.allowPrivateUrls?.()).toBe(false);
    });
});
