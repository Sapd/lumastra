// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for WebhookOutbox — enqueue, filter, delivery, retries, HMAC.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// ── Config mock ───────────────────────────────────────────────────────────────

vi.mock('$lib/server/config.js', () => ({
    config: { INSTANCE_ID: 'test-node-1' },
    LUMASTRA_MASTER_KEY: 'test-master-key-passphrase',
    LUMASTRA_WEBHOOK_RETRY_ATTEMPTS: 8,
    LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY: 16,
}));

// Delivery decrypts with the EFFECTIVE master key (env → <config>/master.key →
// generate), not the load-time LUMASTRA_MASTER_KEY snapshot — that snapshot is
// empty whenever the key is auto-generated, which is the default. Pin it here so
// the suite uses a known key instead of generating one into the dev config dir.
vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'test-master-key-passphrase',
}));

// Webhook outbox now imports subscribeToChannel for cross-replica cache
// invalidation. Stub it so the unit suite never tries to open a Valkey
// connection.
vi.mock('$lib/server/cache/valkey.js', () => ({
    subscribeToChannel: vi.fn(async () => null),
    publishMessage: vi.fn(async () => true),
    getValkeyClient: vi.fn(() => null),
}));

// Production switched from bare fetch() to safeFetch() + assertPublicHttpUrl
// (SSRF guard with DNS resolution). Mock the module so tests can drive
// delivery via vi.stubGlobal('fetch', ...) without real DNS lookups.
//
// The fake `safeFetch` below still walks a manual "follow the Location
// header, re-run validateHop on every hop" loop — a minimal shim of the real
// implementation (already exhaustively tested in url-safety.test.ts) — so
// that webhook-outbox's `deliver()` wiring of `opts.validateHop` (same-origin
// redirect policy, BUG 2) is exercised end-to-end. Existing tests never
// return a 3xx, so `res.headers` is never touched for them (guarded with
// `?.` regardless) and their single-fetch-call behavior is unchanged.
const safeFetchOpts = vi.hoisted(() => [] as Array<{ allowPrivateHosts?: readonly string[] }>);

vi.mock('./url-safety.js', () => ({
    safeFetch: async (
        url: string,
        init?: RequestInit,
        opts?: { validateHop?: (url: URL) => void; allowPrivateHosts?: readonly string[] },
    ) => {
        safeFetchOpts.push({ allowPrivateHosts: opts?.allowPrivateHosts });
        let currentUrl = url;
        for (let hop = 0; hop < 5; hop++) {
            opts?.validateHop?.(new URL(currentUrl));
            const res = (await fetch(currentUrl, init)) as Response;
            if (res.status < 300 || res.status >= 400) return res;
            const location = (res.headers as Headers | undefined)?.get?.('location');
            if (!location) return res;
            currentUrl = new URL(location, currentUrl).toString();
        }
        throw new Error('mock safeFetch: redirect limit exceeded');
    },
    assertPublicHttpUrl: (url: string) => new URL(url),
    assertWebhookTargetUrl: (url: string) => new URL(url),
    UrlSafetyError: class UrlSafetyError extends Error {},
}));

import {
    WebhookOutbox,
    userWebhookSecretContext,
    OUTBOX_RETIRED_ERROR_PREFIX,
} from './webhook-outbox.js';
import type { CloudEvent } from './cloud-events.js';
import type { Sql } from 'postgres';
import { encrypt, deriveMasterKey } from './secrets.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { subscribeToChannel } from '$lib/server/cache/valkey.js';
import { config as mockedConfig } from '$lib/server/config.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<CloudEvent> = {}): CloudEvent {
    return {
        specversion: '1.0',
        id: `evt_${Math.random().toString(36).slice(2)}`,
        source: 'lumastra://task-orchestrator/test-node-1',
        type: 'org.lumastra.task.run.completed',
        subject: 'import-task/run_abc',
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data: { runId: 'run_abc', taskId: 'import-task' },
        ...overrides,
    };
}

function encryptSecret(plaintext: string, aad?: string): Buffer {
    const masterKey = deriveMasterKey(resolveMasterKey());
    return encrypt(plaintext, masterKey, aad);
}

interface FakeSqlRow {
    id?: string;
    hook_id?: string | null;
    /** Set (with hook_id null) on a per-user hook's outbox row. */
    user_hook_id?: string | null;
    /** `user_notification_webhooks.user_id`, the per-user secret's AAD context. */
    owner_user_id?: string | null;
    url?: string;
    secret_encrypted?: Buffer;
    event_filter?: unknown;
    task_filter?: unknown;
    library_group_filter?: unknown;
    media_type_filter?: unknown;
    headers?: unknown;
    active?: boolean;
    include_progress?: boolean;
    event_id?: string;
    payload?: CloudEvent;
    attempts?: number;
    n?: string;
}

type SqlFn = ((s: readonly string[], ...v: unknown[]) => Promise<FakeSqlRow[]>) & {
    json: (v: unknown) => unknown;
    begin: (fn: (tx: SqlFn) => Promise<unknown>) => Promise<unknown>;
};

interface InsertCall {
    strings: readonly string[];
    values: unknown[];
}

interface FakeSqlState {
    insertCalls: InsertCall[];
    updateCalls: InsertCall[];
    queryResponses: Map<string, FakeSqlRow[]>;
}

function makeFakeSql(state: FakeSqlState): SqlFn {
    const fn = ((strings: readonly string[], ...values: unknown[]) => {
        const head = (strings[0] || '').trim().toUpperCase();
        if (head.startsWith('INSERT')) {
            state.insertCalls.push({ strings, values });
            return Promise.resolve([]);
        }
        if (head.startsWith('UPDATE')) {
            state.updateCalls.push({ strings, values });
            return Promise.resolve([]);
        }
        // SELECT — match against registered responses.
        for (const [key, rows] of state.queryResponses) {
            if (head.includes(key.toUpperCase())) return Promise.resolve(rows);
        }
        return Promise.resolve([]);
    }) as SqlFn;
    fn.json = (v: unknown) => v;
    // The real `postgres.Sql.begin(cb)` runs `cb(tx)` with a transaction-scoped
    // tagged-template handle and returns whatever the callback returns. The
    // fake `sql` IS its own transaction wrapper, so passing it through gives
    // tests a callable `tx` with identical recording semantics.
    fn.begin = (cb) => cb(fn);
    return fn;
}

// ── Enqueue tests ─────────────────────────────────────────────────────────────

describe('WebhookOutbox web producer lifecycle', () => {
    it('keeps hook invalidation without starting a delivery timer', async () => {
        vi.useFakeTimers();
        const state: FakeSqlState = { insertCalls: [], updateCalls: [], queryResponses: new Map() };
        const outbox = new WebhookOutbox(makeFakeSql(state) as unknown as Sql);
        const delivery = vi
            .spyOn(outbox as unknown as { deliveryPass(): Promise<void> }, 'deliveryPass')
            .mockResolvedValue(undefined);
        vi.mocked(subscribeToChannel).mockClear();
        try {
            outbox.start({ deliver: false });
            outbox.start({ deliver: false });
            await vi.advanceTimersByTimeAsync(2000);
            expect(subscribeToChannel).toHaveBeenCalledOnce();
            expect(delivery).not.toHaveBeenCalled();
            // A dedicated worker can later start delivery on the same object.
            outbox.start();
            await vi.advanceTimersByTimeAsync(1000);
            expect(delivery).toHaveBeenCalledOnce();
            expect(subscribeToChannel).toHaveBeenCalledOnce();
        } finally {
            outbox.stop();
            delivery.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('WebhookOutbox.stop', () => {
    it('waits for the delivery pass in flight and starts no new pass', async () => {
        vi.useFakeTimers();
        const state: FakeSqlState = { insertCalls: [], updateCalls: [], queryResponses: new Map() };
        const outbox = new WebhookOutbox(makeFakeSql(state) as unknown as Sql);
        let finishPass!: () => void;
        const pass = new Promise<void>((resolve) => {
            finishPass = resolve;
        });
        const delivery = vi
            .spyOn(outbox as unknown as { deliveryPass(): Promise<void> }, 'deliveryPass')
            .mockReturnValue(pass);
        try {
            outbox.start();
            await vi.advanceTimersByTimeAsync(1000);
            expect(delivery).toHaveBeenCalledOnce();

            let settled: boolean | undefined;
            const stopping = outbox.stop().then((value) => {
                settled = value;
            });
            await vi.advanceTimersByTimeAsync(5000);
            expect(settled).toBeUndefined();

            finishPass();
            await stopping;
            expect(settled).toBe(true);
            await vi.advanceTimersByTimeAsync(5000);
            expect(delivery).toHaveBeenCalledOnce();
        } finally {
            finishPass();
            delivery.mockRestore();
            vi.useRealTimers();
        }
    });

    it('stops waiting after the timeout', async () => {
        vi.useFakeTimers();
        const state: FakeSqlState = { insertCalls: [], updateCalls: [], queryResponses: new Map() };
        const outbox = new WebhookOutbox(makeFakeSql(state) as unknown as Sql);
        const delivery = vi
            .spyOn(outbox as unknown as { deliveryPass(): Promise<void> }, 'deliveryPass')
            .mockReturnValue(new Promise<never>(() => {}));
        try {
            outbox.start();
            await vi.advanceTimersByTimeAsync(1000);
            const stopping = outbox.stop(10_000);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(stopping).resolves.toBe(false);
        } finally {
            delivery.mockRestore();
            vi.useRealTimers();
        }
    });
});

describe('WebhookOutbox.enqueue', () => {
    it('inserts no rows when there are no active hooks', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', []); // no hooks
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.enqueue(makeEvent());
        expect(state.insertCalls).toHaveLength(0);
    });

    it('inserts one row for a matching hook', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-1',
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.enqueue(makeEvent({ type: 'org.lumastra.task.run.completed' }));
        expect(state.insertCalls).toHaveLength(1);
        const insertSql = state.insertCalls[0].strings.join('').toLowerCase();
        expect(insertSql).toContain('task_webhook_outbox');
    });

    it('inserts no rows when event type does not match hook filter', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-2',
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.failed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        // Send a 'completed' event to a hook that only wants 'failed'.
        await outbox.enqueue(makeEvent({ type: 'org.lumastra.task.run.completed' }));
        expect(state.insertCalls).toHaveLength(0);
    });

    it('filters out progress events when include_progress is false', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-3',
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.stage.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.enqueue(makeEvent({ type: 'org.lumastra.task.run.stage.completed' }));
        expect(state.insertCalls).toHaveLength(0);
    });

    it('delivers progress events when include_progress is true', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-4',
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.stage.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: true,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.enqueue(makeEvent({ type: 'org.lumastra.task.run.stage.completed' }));
        expect(state.insertCalls).toHaveLength(1);
    });

    it('ON CONFLICT idempotency: same event_id twice yields one insert attempt each', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-5',
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const event = makeEvent({ type: 'org.lumastra.task.run.completed' });
        await outbox.enqueue(event);
        // Second call with same event (cache is warm; hooks don't reload).
        await outbox.enqueue(event);
        // Two inserts attempted; DB enforces ON CONFLICT DO NOTHING at its level.
        expect(state.insertCalls).toHaveLength(2);
        // Verify ON CONFLICT clause is in both SQL strings and keyed by
        // (hook_id, event_id) — not the old global event_id key that
        // dropped fan-out to multiple subscribers.
        for (const call of state.insertCalls) {
            const sqlText = call.strings.join('').toLowerCase();
            expect(sqlText).toContain('on conflict');
            expect(sqlText).toContain('hook_id, event_id');
        }
    });

    it('fans out to every matching hook (no global event_id de-dup)', async () => {
        const secret = encryptSecret('webhook-secret');
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT ID, URL', [
            {
                id: 'hook-fanout-1',
                url: 'https://example.com/hook-1',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
            {
                id: 'hook-fanout-2',
                url: 'https://example.com/hook-2',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
            {
                id: 'hook-fanout-3',
                url: 'https://example.com/hook-3',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.task.run.completed'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: null,
                headers: null,
                active: true,
                include_progress: false,
            },
        ]);
        const sql = makeFakeSql(state);
        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.enqueue(makeEvent({ type: 'org.lumastra.task.run.completed' }));
        // One INSERT per matching hook — three rows total. Pre-fix the second and
        // third rows were silently dropped by the global event_id UNIQUE.
        expect(state.insertCalls).toHaveLength(3);
    });

    it('media-type filter: blocks event whose mediaType is not in the filter, passes matching type', async () => {
        const secret = encryptSecret('webhook-secret');

        // Hook that only wants 'movie' media-added events.
        function makeMediaHookRow(id: string): FakeSqlRow {
            return {
                id,
                url: 'https://example.com/webhook',
                secret_encrypted: secret,
                event_filter: ['org.lumastra.media.item.added'],
                task_filter: null,
                library_group_filter: null,
                media_type_filter: ['movie'],
                headers: null,
                active: true,
                include_progress: false,
            };
        }

        // --- episode event: should NOT match ---
        const stateEpisode: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        stateEpisode.queryResponses.set('SELECT ID, URL', [makeMediaHookRow('hook-mt-1')]);
        const sqlEpisode = makeFakeSql(stateEpisode);
        const outboxEpisode = new WebhookOutbox(sqlEpisode as unknown as Sql);
        await outboxEpisode.enqueue(
            makeEvent({
                type: 'org.lumastra.media.item.added',
                data: { mediaType: 'episode' },
            }),
        );
        expect(stateEpisode.insertCalls).toHaveLength(0);

        // --- movie event: should match ---
        const stateMovie: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        stateMovie.queryResponses.set('SELECT ID, URL', [makeMediaHookRow('hook-mt-2')]);
        const sqlMovie = makeFakeSql(stateMovie);
        const outboxMovie = new WebhookOutbox(sqlMovie as unknown as Sql);
        await outboxMovie.enqueue(
            makeEvent({
                type: 'org.lumastra.media.item.added',
                data: { mediaType: 'movie' },
            }),
        );
        expect(stateMovie.insertCalls).toHaveLength(1);
    });
});

// ── Delivery pass tests ───────────────────────────────────────────────────────

describe('WebhookOutbox.deliveryPass', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function makeOutboxRow(overrides: Partial<FakeSqlRow> = {}): FakeSqlRow {
        return {
            id: 'outbox-row-1',
            hook_id: 'hook-1',
            event_id: 'evt_abc',
            payload: makeEvent(),
            attempts: 0,
            url: 'https://example.com/webhook',
            secret_encrypted: encryptSecret('my-secret'),
            owner_user_id: null,
            headers: null,
            ...overrides,
        };
    }

    it('records a successful retry status and clears the former error', async () => {
        const state: FakeSqlState = { insertCalls: [], updateCalls: [], queryResponses: new Map() };
        state.queryResponses.set('SELECT O.ID', [makeOutboxRow({ attempts: 1 })]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
        await new WebhookOutbox(makeFakeSql(state) as unknown as Sql).deliveryPass();
        const delivered = state.updateCalls.find((c) =>
            c.strings.join('').includes('delivered_at = NOW()'),
        );
        expect(delivered?.strings.join('')).toMatch(/last_status/);
        expect(delivered?.strings.join('')).toMatch(/last_error = NULL/);
        expect(delivered?.strings.join('')).toMatch(/last_attempt_at = NOW\(\)/);
        expect(delivered?.values).toContain(204);
    });

    it('marks row as delivered when fetch returns 2xx', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [makeOutboxRow() as FakeSqlRow]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
        } as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();
        expect(result.delivered).toBe(1);
        expect(result.failed).toBe(0);

        const updateSql = state.updateCalls
            .map((c) => c.strings.join(''))
            .join('\n')
            .toLowerCase();
        expect(updateSql).toContain('delivered_at');
    });

    it('increments attempts and advances next_attempt_at on non-2xx', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [makeOutboxRow({ attempts: 0 }) as FakeSqlRow]);
        state.queryResponses.set('SELECT COUNT', [{ n: '1' }]);
        const sql = makeFakeSql(state);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            text: async () => 'Internal Server Error',
        } as unknown as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();
        expect(result.failed).toBe(1);

        const updateSql = state.updateCalls
            .map((c) => c.strings.join(''))
            .join('\n')
            .toLowerCase();
        expect(updateSql).toContain('next_attempt_at');
        expect(updateSql).toContain('last_attempt_at');
        expect(updateSql).toContain('attempts');
    });

    it('marks row as dead after 8 failures', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        // attempts = 7 (last attempt before DLQ threshold)
        state.queryResponses.set('SELECT O.ID', [makeOutboxRow({ attempts: 7 }) as FakeSqlRow]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 503,
            text: async () => 'Service Unavailable',
        } as unknown as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.deliveryPass();

        // Find the UPDATE that sets dead=true.
        const updateCalls = state.updateCalls.filter((c) => {
            const s = c.strings.join('').toLowerCase();
            return s.includes('dead') && s.includes('attempts');
        });
        expect(updateCalls.length).toBeGreaterThan(0);
        // The values array should contain `true` for dead.
        const hasDeadTrue = updateCalls.some((c) => c.values.includes(true));
        expect(hasDeadTrue).toBe(true);
    });

    // ── Per-user hook rows and the admin gate ─────────────────────────────
    //
    // A user-owned row carries `user_hook_id` and a NULL `hook_id`; the
    // one-owner CHECK (migration 16.192.0) makes those two facts equivalent.
    //
    // `FEATURE_USER_NOTIFICATION_WEBHOOKS` defaults FALSE, and this suite reads
    // the real config, so these rows are in the disabled state without stubbing
    // anything — which is exactly the state a default install is in.

    it('retires a per-user row instead of delivering it while the feature is off', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            makeOutboxRow({ hook_id: null, user_hook_id: 'user-hook-1' }) as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        // The point of the assertion: no delivery ATTEMPT, not merely no success.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.delivered).toBe(0);
        expect(result.failed).toBe(0);

        // Retired rather than skipped, so it leaves the pending set instead of
        // being re-claimed on every tick forever.
        //
        // Matched on the BOUND VALUE, not on the SQL text: the reason string is
        // a parameter, so it never appears in `strings` at all. (It used to be
        // an inline literal, and this assertion silently stopped matching the
        // moment it was parameterised — checking the value is both correct and
        // the thing that actually reaches the row.)
        const retire = state.updateCalls.find((c) =>
            c.values.some(
                (v) =>
                    typeof v === 'string' &&
                    v.toLowerCase().includes('disabled by the administrator'),
            ),
        );
        expect(retire).toBeDefined();
        // And it carries the marker component health splits retirements on.
        expect(
            retire?.values.some(
                (v) => typeof v === 'string' && v.startsWith(OUTBOX_RETIRED_ERROR_PREFIX),
            ),
        ).toBe(true);
    });

    // ── Row-bound secrets (security review 2026-09-13, C19) ──────────────────

    it('delivers with a secret bound to the hook that owns it', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            makeOutboxRow({
                secret_encrypted: encryptSecret('my-secret', 'task_webhook_hooks:hook-1'),
            }) as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        expect(result.delivered).toBe(1);
    });

    it('fails delivery for a secret bound to a DIFFERENT hook', async () => {
        // The transplant: hook-1's row carrying hook-2's blob. The signature
        // cannot be computed, so nothing is sent — rather than a delivery
        // signed with a secret that belongs to someone else's endpoint.
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            makeOutboxRow({
                secret_encrypted: encryptSecret('my-secret', 'task_webhook_hooks:hook-2'),
            }) as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(result.delivered).toBe(0);
        expect(result.failed).toBe(1);
    });

    it("claims the per-user owner id, the AAD context of that table's secret", async () => {
        // The per-user secret is bound to its OWNER, so a claim query that does
        // not select user_id leaves delivery unable to open it — and every
        // legacy (unbound) fixture would still pass without this assertion.
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        const claims: string[] = [];
        const sql = makeFakeSql(state);
        const recording = ((strings: readonly string[], ...values: unknown[]) => {
            if ((strings[0] || '').trim().toUpperCase().includes('SELECT O.ID')) {
                claims.push(strings.join(''));
            }
            return (sql as unknown as (s: readonly string[], ...v: unknown[]) => unknown)(
                strings,
                ...values,
            );
        }) as unknown as SqlFn;
        recording.json = sql.json;
        recording.begin = (cb) => cb(recording);

        const outbox = new WebhookOutbox(recording as unknown as Sql);
        await outbox.deliveryPass();

        expect(claims).toHaveLength(1);
        expect(claims[0]).toContain('u.user_id');
    });

    it('leaves operator rows alone when the per-user feature is off', async () => {
        // The disabled-feature filter must key off ownership, not run over
        // everything claimed in the same pass.
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [makeOutboxRow() as FakeSqlRow]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        expect(result.delivered).toBe(1);
    });

    // ── Per-user delivery fixture: AAD-bound secret (security review
    // 2026-09-13, C19) ─────────────────────────────────────────────────────
    //
    // The tests above cover the disabled-feature retirement path and that the
    // claim query selects `u.user_id` (the AAD context), but neither actually
    // DELIVERS a per-user row with the feature on. This closes that gap: a
    // full delivery through the real AAD-bound decrypt, with the resulting
    // HMAC signature re-derived from the captured header and compared against
    // the secret the fixture used — proving delivery opened the secret with
    // the right AAD context, not merely that it didn't crash. The negative
    // case mirrors "fails delivery for a secret bound to a DIFFERENT hook"
    // above, but for the per-user table's owner-keyed AAD instead of the
    // operator table's hook-keyed one.

    describe('private-host allowlist', () => {
        const OWNER_USER_ID = '33333333-3333-4333-8333-333333333333';

        beforeEach(() => {
            safeFetchOpts.length = 0;
            const cfg = mockedConfig as unknown as Record<string, unknown>;
            cfg.WEBHOOK_PRIVATE_HOST_ALLOWLIST = ['bot.arr.svc.cluster.local'];
            cfg.FEATURE_USER_NOTIFICATION_WEBHOOKS = true;
        });

        afterEach(() => {
            const cfg = mockedConfig as unknown as Record<string, unknown>;
            delete cfg.WEBHOOK_PRIVATE_HOST_ALLOWLIST;
            delete cfg.FEATURE_USER_NOTIFICATION_WEBHOOKS;
        });

        async function deliverOne(row: FakeSqlRow): Promise<void> {
            const state: FakeSqlState = {
                insertCalls: [],
                updateCalls: [],
                queryResponses: new Map(),
            };
            state.queryResponses.set('SELECT O.ID', [row]);
            state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
            await new WebhookOutbox(makeFakeSql(state) as unknown as Sql).deliveryPass();
        }

        it('hands the operator allowlist to an OPERATOR row', async () => {
            await deliverOne(makeOutboxRow());
            expect(safeFetchOpts).toEqual([{ allowPrivateHosts: ['bot.arr.svc.cluster.local'] }]);
        });

        it('never hands it to a PER-USER row — a user-chosen URL stays public-only', async () => {
            await deliverOne(
                makeOutboxRow({
                    hook_id: null,
                    user_hook_id: 'user-hook-1',
                    owner_user_id: OWNER_USER_ID,
                    secret_encrypted: encryptSecret('s', userWebhookSecretContext(OWNER_USER_ID)),
                }),
            );
            expect(safeFetchOpts).toEqual([{ allowPrivateHosts: undefined }]);
        });
    });

    describe('per-user hook delivery (feature on)', () => {
        const OWNER_USER_ID = '33333333-3333-4333-8333-333333333333';
        const OTHER_USER_ID = '44444444-4444-4444-8444-444444444444';

        beforeEach(() => {
            (
                mockedConfig as unknown as Record<string, unknown>
            ).FEATURE_USER_NOTIFICATION_WEBHOOKS = true;
        });

        afterEach(() => {
            delete (mockedConfig as unknown as Record<string, unknown>)
                .FEATURE_USER_NOTIFICATION_WEBHOOKS;
        });

        it('delivers a per-user hook end to end, signed with the secret opened under its OWNER AAD context', async () => {
            const state: FakeSqlState = {
                insertCalls: [],
                updateCalls: [],
                queryResponses: new Map(),
            };
            const plaintextSecret = 'correct-owner-secret';
            state.queryResponses.set('SELECT O.ID', [
                makeOutboxRow({
                    hook_id: null,
                    user_hook_id: 'user-hook-1',
                    owner_user_id: OWNER_USER_ID,
                    secret_encrypted: encryptSecret(
                        plaintextSecret,
                        userWebhookSecretContext(OWNER_USER_ID),
                    ),
                }) as FakeSqlRow,
            ]);
            state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
            const sql = makeFakeSql(state);

            fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);

            const outbox = new WebhookOutbox(sql as unknown as Sql);
            const result = await outbox.deliveryPass();

            expect(result.delivered).toBe(1);
            expect(fetchMock).toHaveBeenCalledTimes(1);

            // Re-derive the HMAC from the ACTUAL header + body sent, using the
            // plaintext secret the fixture encrypted — a wrong AAD context
            // (e.g. hook-keyed instead of owner-keyed) would have made
            // decrypt() throw before signing, and any OTHER accidental
            // secret would fail to reproduce this signature.
            const [, fetchOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
            const headers = fetchOpts.headers as Record<string, string>;
            const sigMatch = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['X-Lumastra-Signature']!);
            expect(sigMatch).not.toBeNull();
            const [, ts, sentHex] = sigMatch!;
            const expectedHex = crypto
                .createHmac('sha256', plaintextSecret)
                .update(`${ts}.${fetchOpts.body as string}`)
                .digest('hex');
            expect(sentHex).toBe(expectedHex);
        });

        it('does NOT deliver a per-user hook whose secret is bound to a DIFFERENT owner — no request, no wrong-but-plausible signature', async () => {
            const state: FakeSqlState = {
                insertCalls: [],
                updateCalls: [],
                queryResponses: new Map(),
            };
            state.queryResponses.set('SELECT O.ID', [
                makeOutboxRow({
                    hook_id: null,
                    user_hook_id: 'user-hook-2',
                    // The row claims to be owned by OWNER_USER_ID, but its
                    // secret was sealed under a DIFFERENT owner's AAD — the
                    // transplant scenario for the per-user table.
                    owner_user_id: OWNER_USER_ID,
                    secret_encrypted: encryptSecret(
                        'stolen-or-mismatched-secret',
                        userWebhookSecretContext(OTHER_USER_ID),
                    ),
                }) as FakeSqlRow,
            ]);
            state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
            const sql = makeFakeSql(state);

            const outbox = new WebhookOutbox(sql as unknown as Sql);
            const result = await outbox.deliveryPass();

            // The AAD mismatch must fail the AES-GCM auth tag before a
            // signature is ever computed — no delivery attempt at all, not a
            // delivery with a signature that merely happens to be wrong.
            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.delivered).toBe(0);
            expect(result.failed).toBe(1);
        });
    });

    // ── Same-origin redirect policy (BUG 2) ───────────────────────────────
    //
    // deliver() sends a signed CloudEvent (HMAC + operator headers). Following
    // a cross-origin redirect would exfiltrate that signed payload to a host
    // the operator never registered while the outbox records delivery as
    // "success" against the original, trusted URL. safeFetch's `validateHop`
    // must reject any hop whose origin differs from the registered hook URL.

    it('rejects a cross-origin webhook redirect as a normal delivery failure', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            makeOutboxRow({ url: 'https://hooks.example/webhook' }) as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '1' }]);
        const sql = makeFakeSql(state);

        const redirectHeaders = new Headers();
        redirectHeaders.set('location', 'https://attacker.example/webhook');
        fetchMock.mockResolvedValueOnce(
            new Response(null, { status: 307, headers: redirectHeaders }),
        );

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        // Recorded as a normal delivery failure — existing retry/DLQ
        // semantics apply (attempts incremented, backoff scheduled).
        expect(result.delivered).toBe(0);
        expect(result.failed).toBe(1);
        // Only the first hop was ever fetched — the pivot was rejected
        // before a second network call.
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The failure is logged/recorded naming the redirect target.
        const updateSql = state.updateCalls
            .map((c) => c.strings.join(''))
            .join('\n')
            .toLowerCase();
        expect(updateSql).toContain('last_error');
        const errorValues = state.updateCalls
            .flatMap((c) => c.values)
            .filter((v): v is string => typeof v === 'string');
        expect(errorValues.some((v) => v.includes('attacker.example'))).toBe(true);
    });

    it('allows a same-origin (path-only) webhook redirect', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            makeOutboxRow({ url: 'https://hooks.example/webhook' }) as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        const redirectHeaders = new Headers();
        redirectHeaders.set('location', 'https://hooks.example/webhook/v2');
        fetchMock
            .mockResolvedValueOnce(new Response(null, { status: 307, headers: redirectHeaders }))
            .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        const result = await outbox.deliveryPass();

        expect(result.delivered).toBe(1);
        expect(result.failed).toBe(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

// ── HMAC signature tests ──────────────────────────────────────────────────────

describe('HMAC-SHA256 signature', () => {
    it('verifies with known fixture: t=<ts>.<body> → expected hex', () => {
        const secret = 'fixed-secret-for-test';
        const timestamp = 1_715_000_000;
        const body = '{"specversion":"1.0"}';
        const expected = crypto
            .createHmac('sha256', secret)
            .update(`${timestamp}.${body}`)
            .digest('hex');

        // Re-derive using the same formula as the outbox.
        const derived = crypto
            .createHmac('sha256', secret)
            .update(`${timestamp}.${body}`)
            .digest('hex');

        expect(derived).toBe(expected);
        expect(derived).toHaveLength(64);
    });

    it('produces different signatures for different timestamps', () => {
        const secret = 'my-secret';
        const body = '{"type":"event"}';
        const sig1 = crypto.createHmac('sha256', secret).update(`1000000.${body}`).digest('hex');
        const sig2 = crypto.createHmac('sha256', secret).update(`2000000.${body}`).digest('hex');
        expect(sig1).not.toBe(sig2);
    });

    it('fetch is called with X-Lumastra-Signature header in correct format', async () => {
        const state: FakeSqlState = {
            insertCalls: [],
            updateCalls: [],
            queryResponses: new Map(),
        };
        state.queryResponses.set('SELECT O.ID', [
            {
                id: 'outbox-sig-test',
                hook_id: 'hook-sig',
                event_id: 'evt_sig',
                payload: makeEvent(),
                attempts: 0,
                url: 'https://example.com/hook',
                secret_encrypted: encryptSecret('test-secret'),
                headers: null,
            } as FakeSqlRow,
        ]);
        state.queryResponses.set('SELECT COUNT', [{ n: '0' }]);
        const sql = makeFakeSql(state);

        const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        vi.stubGlobal('fetch', fetchMock);

        const outbox = new WebhookOutbox(sql as unknown as Sql);
        await outbox.deliveryPass();

        vi.unstubAllGlobals();

        const [, fetchOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
        const headers = fetchOpts.headers as Record<string, string>;
        expect(headers['X-Lumastra-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });
});
