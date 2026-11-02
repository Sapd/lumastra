// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-replica revocation when the Valkey marker cannot be consulted
 * (admin/users review 2026-10-07, item 2).
 *
 * A revoke on replica A publishes a Valkey marker that replica B checks on
 * every LRU hit. With Valkey down, B used to trust its LRU entry for the rest
 * of the cache TTL (PAT 30 min, service token 5 min). Now a cache hit whose
 * marker is unavailable confirms the row itself; with Valkey up and clean,
 * the row is NOT re-read (the LRU still saves the DB round-trip).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSql = vi.fn();
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return mockSql;
        }
    },
}));
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/cache/auth-cache-bus.js', () => ({
    publishAuthCacheInvalidation: vi.fn(),
    onRemoteTokenNarrowedInvalidate: () => {},
    onAuthCacheBusResync: () => {},
}));

const valkey = vi.hoisted(() => ({
    ready: true,
    marker: null as string | null,
    // The GET fails while the client object still exists (isValkeyReady()
    // stays true): the real outage shape that cacheGet used to hide as null.
    getThrows: false,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheSet: vi.fn(),
    cacheGet: async () => (valkey.getThrows ? null : valkey.marker),
    cacheGetOrThrow: async () => {
        if (valkey.getThrows)
            throw Object.assign(new Error('connection reset'), { code: 'ECONNREFUSED' });
        return valkey.marker;
    },
    isCoordinationValkeyReady: () => valkey.ready,
    connectValkey: vi.fn(),
}));

import { ServiceTokenService } from './service-token.service.js';
import { PatService } from './pat.service.js';

interface Issued {
    text: string;
}

/** Fake `sql` that serves the token row while `live` is true. */
function fakeSql(
    state: { live: boolean; rowReadThrows?: boolean; rowReadError?: Error },
    table: 'service_tokens' | 'personal_access_tokens',
) {
    const issued: Issued[] = [];
    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
        const text = strings.join('?');
        issued.push({ text });
        if (text.includes(`FROM ${table}`) && text.includes('token_hash')) {
            if (state.rowReadError) throw state.rowReadError;
            if (state.rowReadThrows)
                throw Object.assign(new Error('statement timeout'), { code: 'ECONNREFUSED' });
            if (!state.live) return [];
            return table === 'service_tokens'
                ? [
                      {
                          id: 1,
                          token_hash: 'h',
                          token_prefix: 'svc_abcdefgh',
                          name: 'ci',
                          created_by: 'the-admin',
                          owner_user_id: '00000000-0000-4000-8000-0000000000ad',
                          act_as_user: null,
                          scopes: ['admin'],
                          allowed_ips: null,
                          allowed_path_prefixes: null,
                          allowed_methods: null,
                          force_non_admin: false,
                          expires_at: null,
                          revoked_at: null,
                      },
                  ]
                : [
                      {
                          id: 1,
                          token_hash: 'h',
                          token_prefix: 'pat_abcdefgh',
                          user_id: '00000000-0000-0000-0000-000000000042',
                          name: 'cli',
                          scopes: ['read'],
                          user_groups: [],
                          jellyfin_user_id: null,
                          allowed_ips: null,
                          expires_at: null,
                          revoked_at: null,
                          force_non_admin: false,
                      },
                  ];
        }
        if (text.includes('FROM users')) {
            return [{ username: 'the-admin', groups: [], disabled_at: null, deleted_at: null }];
        }
        return [];
    });
    return issued;
}

const tokenRowReads = (issued: Issued[], table: string): number =>
    issued.filter((q) => q.text.includes(`FROM ${table}`) && q.text.includes('token_hash')).length;

beforeEach(() => {
    mockSql.mockReset();
    valkey.ready = true;
    valkey.marker = null;
    valkey.getThrows = false;
});

describe('ServiceTokenService.validate — cache hit without a reachable marker', () => {
    const token = 'svc_' + 'a'.repeat(48);

    it('re-reads the row when Valkey is down and rejects a token revoked elsewhere', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull(); // DB path, now cached
        valkey.ready = false;
        state.live = false; // revoked on another replica; no marker reached us

        expect(await svc.validate(token)).toBeNull();
        expect(tokenRowReads(issued, 'service_tokens')).toBe(2);
    });

    it('keeps serving a live token from the LRU plus one row read while Valkey is down', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull();
        valkey.ready = false;
        expect(await svc.validate(token)).not.toBeNull();
        expect(tokenRowReads(issued, 'service_tokens')).toBe(2);
    });

    it('does not touch the row on a cache hit when Valkey answers "clean"', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull();
        expect(await svc.validate(token)).not.toBeNull();
        expect(tokenRowReads(issued, 'service_tokens')).toBe(1);
    });

    it('treats a failing GET on a connected client as unknown and re-reads the row', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull();
        valkey.getThrows = true;
        state.live = false;

        expect(await svc.validate(token)).toBeNull();
        expect(tokenRowReads(issued, 'service_tokens')).toBe(2);
    });

    it('rejects when Valkey is down and the row cannot be read either (fail closed)', async () => {
        const state = { live: true, rowReadThrows: false };
        fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull();
        valkey.ready = false;
        state.rowReadThrows = true;
        await expect(svc.validate(token)).rejects.toThrow('Authentication temporarily unavailable');
        state.rowReadThrows = false;
        expect(await svc.validate(token)).not.toBeNull();
    });

    it('still honours the marker when Valkey is up', async () => {
        const state = { live: true };
        fakeSql(state, 'service_tokens');
        const svc = new ServiceTokenService();

        expect(await svc.validate(token)).not.toBeNull();
        valkey.marker = '1';
        expect(await svc.validate(token)).toBeNull();
    });
});

describe('PatService.validate — cache hit without a reachable marker', () => {
    const token = 'pat_' + 'a'.repeat(48);

    // The first (cache-miss) validate records a real "clean" answer in the
    // 5-second negative cache; step past it so the second call asks Valkey.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('preserves a cached PAT when both dependencies fail and recovers with the same token', async () => {
        const state = { live: true, rowReadThrows: false };
        fakeSql(state, 'personal_access_tokens');
        const svc = new PatService();
        expect(await svc.validate(token)).not.toBeNull();
        vi.advanceTimersByTime(6_000);
        valkey.ready = false;
        state.rowReadThrows = true;
        await expect(svc.validate(token)).rejects.toThrow('Authentication temporarily unavailable');
        state.rowReadThrows = false;
        expect(await svc.validate(token)).not.toBeNull();
    });

    it('distinguishes a failed live owner check from an invalid PAT', async () => {
        fakeSql({ live: true }, 'personal_access_tokens');
        const svc = new PatService();
        expect(await svc.validate(token)).not.toBeNull();
        const real = mockSql.getMockImplementation()!;
        mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
            if (strings.join('').includes('FROM users'))
                throw Object.assign(new Error('connection closed'), { code: 'ECONNREFUSED' });
            return real(strings);
        });
        await expect(svc.validate(token)).rejects.toThrow('Authentication temporarily unavailable');
    });

    it('re-reads the row when Valkey is down and rejects a PAT revoked elsewhere', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'personal_access_tokens');
        const svc = new PatService();

        expect(await svc.validate(token)).not.toBeNull();
        vi.advanceTimersByTime(6_000);
        valkey.ready = false;
        state.live = false;

        expect(await svc.validate(token)).toBeNull();
        expect(tokenRowReads(issued, 'personal_access_tokens')).toBe(2);
    });

    it('does not touch the row on a cache hit when Valkey answers "clean"', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'personal_access_tokens');
        const svc = new PatService();

        expect(await svc.validate(token)).not.toBeNull();
        vi.advanceTimersByTime(6_000);
        expect(await svc.validate(token)).not.toBeNull();
        expect(tokenRowReads(issued, 'personal_access_tokens')).toBe(1);
    });

    it('treats a failing GET as unknown and does not record it as clean', async () => {
        const state = { live: true };
        const issued = fakeSql(state, 'personal_access_tokens');
        const svc = new PatService();

        expect(await svc.validate(token)).not.toBeNull();
        vi.advanceTimersByTime(6_000);
        valkey.getThrows = true;
        expect(await svc.validate(token)).not.toBeNull(); // live: served after a row read
        // Within the 5 s negative-cache window: a failed GET must not have
        // been cached as clean, so a revoke is still caught by the row read.
        vi.advanceTimersByTime(1_000);
        state.live = false;
        expect(await svc.validate(token)).toBeNull();
        expect(tokenRowReads(issued, 'personal_access_tokens')).toBe(3);
    });
});

it.each(['service_tokens', 'personal_access_tokens'] as const)(
    'keeps unrelated %s liveness errors invalid instead of unavailable',
    async (table) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const state: { live: boolean; rowReadError?: Error } = { live: true };
            fakeSql(state, table);
            const service =
                table === 'service_tokens' ? new ServiceTokenService() : new PatService();
            const token = (table === 'service_tokens' ? 'svc_' : 'pat_') + 'a'.repeat(48);
            expect(await service.validate(token)).not.toBeNull();
            vi.advanceTimersByTime(6_000);
            valkey.ready = false;
            state.rowReadError = new SyntaxError('malformed query');
            expect(await service.validate(token)).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    },
);
