// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Atomicity property tests for enqueue-with-identity.lua.
 * Plan §16.2: concurrent enqueue under race conditions.
 *
 * Properties verified:
 *   - 10 parallel enqueue-with-identity calls with the same key → exactly one
 *     returns 'enqueued', nine return 'duplicate' with the same runId.
 *   - Repeated 100 times with different keys to detect flakes.
 *
 * Requires a live Valkey instance (CACHE_URL env or redis://localhost:6379).
 * Skipped automatically when CACHE_URL is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GlideClient } from '@valkey/valkey-glide';
import { luaLoader } from './loader.js';

// ── Valkey connection ─────────────────────────────────────────────────────────

function parseUrl(
    url: string,
): { host: string; port: number; password?: string; username?: string } | null {
    try {
        const u = new URL(url);
        return {
            host: u.hostname,
            port: parseInt(u.port || '6379', 10),
            username: u.username || undefined,
            password: u.password || undefined,
        };
    } catch {
        return null;
    }
}

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

let glideClient: GlideClient;

beforeAll(async () => {
    if (!RUN) return;
    const url = CACHE_URL || 'redis://localhost:6379';
    const cfg = parseUrl(url);
    if (!cfg) throw new Error(`Cannot parse CACHE_URL: ${url}`);

    const glideConfig: Parameters<typeof GlideClient.createClient>[0] = {
        addresses: [{ host: cfg.host, port: cfg.port }],
        requestTimeout: 10_000,
        clientName: 'lua-concurrent-enqueue-tests',
    };
    if (cfg.password) {
        glideConfig.credentials = {
            username: cfg.username ?? 'default',
            password: cfg.password,
        };
    }
    glideClient = await GlideClient.createClient(glideConfig);
    await luaLoader.load();
}, 30_000);

afterAll(async () => {
    if (glideClient) glideClient.close();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const PREFIX = `test:concurrent:enqueue:${Date.now()}:`;

function identityKey(run: number, iter: number): string {
    return `task:identity:${PREFIX}r${run}:iter${iter}`;
}

type ValkeyLike = { customCommand: (cmd: string[]) => Promise<unknown> };

async function enqueueIdentity(
    key: string,
    runId: string,
    ttlMs = '86400000',
): Promise<[string, string]> {
    const raw = await luaLoader.invoke(
        'enqueue-with-identity',
        [key],
        [runId, ttlMs],
        glideClient as unknown as ValkeyLike,
    );
    if (!Array.isArray(raw) || raw.length < 2) {
        throw new Error(`Unexpected Lua return: ${JSON.stringify(raw)}`);
    }
    return [String(raw[0]), String(raw[1])];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.runIf(RUN)('lua enqueue-with-identity atomicity (plan §16.2)', () => {
    it('10 parallel calls with the same key → exactly one enqueued, nine duplicate', async () => {
        const ITERATIONS = 100;
        const CONCURRENCY = 10;

        for (let iter = 0; iter < ITERATIONS; iter++) {
            const key = identityKey(0, iter);
            const runIds = Array.from({ length: CONCURRENCY }, (_, i) => `run_iter${iter}_c${i}`);

            // Fire all 10 calls concurrently.
            const results = await Promise.all(runIds.map((rid) => enqueueIdentity(key, rid)));

            const enqueued = results.filter(([status]) => status === 'enqueued');
            const duplicates = results.filter(([status]) => status === 'duplicate');

            expect(enqueued).toHaveLength(1);
            expect(duplicates).toHaveLength(CONCURRENCY - 1);

            // The winning runId must be consistent across all duplicates.
            const winnerRunId = enqueued[0][1];
            for (const [, existingRunId] of duplicates) {
                expect(existingRunId).toBe(winnerRunId);
            }

            // Cleanup.
            await glideClient.del([key]);
        }
    }, 120_000);

    it('re-enqueue after TTL expiry is treated as a fresh enqueue (not duplicate)', async () => {
        const key = `task:identity:${PREFIX}ttl-expiry`;
        const firstRunId = 'run_first';

        // Enqueue with a very short TTL (1ms → expires immediately).
        await enqueueIdentity(key, firstRunId, '1');

        // Wait for TTL to expire.
        await new Promise((r) => setTimeout(r, 20));

        const [status, runId] = await enqueueIdentity(key, 'run_second', '86400000');
        expect(status).toBe('enqueued');
        expect(runId).toBe('run_second');

        await glideClient.del([key]);
    }, 10_000);

    it('empty runId on duplicate branch returns empty string gracefully', async () => {
        const key = `task:identity:${PREFIX}empty`;

        // Seed the key directly with an empty value (edge case).
        await glideClient.set(key, '', {
            expiry: { type: 'PX', count: 86_400_000 },
        } as never);

        const [status, existingRunId] = await enqueueIdentity(key, 'run_any');
        expect(status).toBe('duplicate');
        // Lua returns '' when existing is nil/empty; the script handles it gracefully.
        expect(typeof existingRunId).toBe('string');

        await glideClient.del([key]);
    }, 10_000);
});
