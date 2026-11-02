// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the property the embedding-provider consolidation exists to guarantee:
 * a bare EMBEDDING_BASE_URL with no EMBEDDING_API_KEY must NOT read as "an
 * embedding provider is configured" — that combination cannot embed, a custom
 * endpoint never falls back to OPENAI_API_KEY.
 *
 * This case used to be answered inconsistently across four call sites (some
 * treated a bare base URL as sufficient, some required the key too). All four
 * now delegate to `hasEmbeddingProvider()` in ./config.ts, so this file only
 * needs to pin that single source of truth.
 *
 * Coverage note: of the four consumers this consolidation touched —
 * src/lib/server/api/defs/admin/settings/instance-profile.ts,
 * src/routes/admin/system/instance/+page.server.ts,
 * src/lib/server/database/queries/onboarding.queries.ts, and
 * src/routes/setup/+page.server.ts — none is unit-testable in isolation:
 * the two `+page.server.ts` load functions need a SvelteKit request event,
 * the API def needs the endpoint-mounting harness, and the query module
 * needs a live `sql: postgres.Sql`. Each now calls `hasEmbeddingProvider()`
 * directly (verified by reading the call sites), so exercising the shared
 * helper is what actually guarantees they agree.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const EMBEDDING_ENV_KEYS = [
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_API_KEY',
] as const;

// Snapshot so the deletions loadConfig() does on every call don't leak into
// other test files that share this process.
const ORIGINAL_ENV: Partial<Record<(typeof EMBEDDING_ENV_KEYS)[number], string>> = {};
for (const key of EMBEDDING_ENV_KEYS) ORIGINAL_ENV[key] = process.env[key];

async function loadConfig(
    envVars: Partial<Record<(typeof EMBEDDING_ENV_KEYS)[number], string>>,
): Promise<{ hasEmbeddingProvider: () => boolean }> {
    for (const key of EMBEDDING_ENV_KEYS) delete process.env[key];
    Object.assign(process.env, envVars);
    vi.resetModules();
    return (await import('./config.js')) as unknown as {
        hasEmbeddingProvider: () => boolean;
    };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    for (const key of EMBEDDING_ENV_KEYS) {
        if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
        else process.env[key] = ORIGINAL_ENV[key];
    }
});

describe('embedding-provider consumers agree on the case that used to differ', () => {
    it('a bare EMBEDDING_BASE_URL with no key is NOT a configured provider', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
        });
        expect(hasEmbeddingProvider()).toBe(false);
    });

    it('adding EMBEDDING_API_KEY to the same base URL makes it configured', async () => {
        const { hasEmbeddingProvider } = await loadConfig({
            EMBEDDING_BASE_URL: 'https://embed.example.com/v1',
            EMBEDDING_API_KEY: 'local-key',
        });
        expect(hasEmbeddingProvider()).toBe(true);
    });
});
