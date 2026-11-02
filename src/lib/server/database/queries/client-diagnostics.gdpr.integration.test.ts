// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests: GDPR export/erasure coverage for client_diagnostics.
 *
 * 1. Export includes a `client_diagnostics` section, and each `log_bundle` row
 *    carries the FULL decompressed log text (`logText`).
 * 2. Erasure deletes `log_bundle` rows outright (blobs cascade) — including a
 *    device-scoped bundle uploaded by a DIFFERENT account whose
 *    `payload.accountIds` lists the erased user (spec §7) — and, for every
 *    other kind, nulls every linkability column (user_id, device_id,
 *    play_session_id, attempt_id, media_id, summary) and strips every
 *    user-derived payload key, while keeping the forensic shape (kind,
 *    platform, fingerprint, occurred/received_at, occurrences, and
 *    `api_failures.route`, which is a normalized operationId, not user data).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
    createAndInsertTestMovie,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    ingestDiagnosticEvents,
    ingestLogBundle,
} from '$lib/server/services/client-diagnostics/ingest.service.js';
import { eraseUserData } from './gdpr-erasure.queries.js';
import { collectUserExport, setExportLogTextCapOverrideForTests } from './gdpr-export.queries.js';
import { withBundleSlot } from '$lib/server/services/client-diagnostics/semaphore.js';

describe('client diagnostics GDPR', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'users']);
    });

    it('export contains diagnostics and the full log text of bundles', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const result = await ingestLogBundle(sql, userId, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('hello log')).toString('base64'),
        });
        expect(result.ok).toBe(true);

        const out = await collectUserExport(sql, username);
        expect(out).not.toBeNull();
        if (!out) throw new Error('export was null');
        const section = out.client_diagnostics as { rows: Record<string, unknown>[] };
        expect(section.rows).toHaveLength(1);
        expect(section.rows[0].logText).toBe('hello log');
    });

    it('export marks an undecodable bundle with logTextError instead of throwing', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // A well-formed gzip of garbage still decodes fine, so to exercise the
        // failure path we corrupt stored bytes directly after a normal ingest.
        const result = await ingestLogBundle(sql, userId, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('some log text')).toString('base64'),
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('ingest failed');

        await sql`
            UPDATE client_diagnostic_blobs SET content = '\\xdeadbeef'::bytea
            WHERE diagnostic_id = ${result.diagnosticId}
        `;

        const out = await collectUserExport(sql, username);
        expect(out).not.toBeNull();
        if (!out) throw new Error('export was null');
        const section = out.client_diagnostics as { rows: Record<string, unknown>[] };
        expect(section.rows).toHaveLength(1);
        expect(section.rows[0].logText).toBeNull();
        expect(section.rows[0].logTextError).toBe('bundle could not be decompressed');
    });

    it('export omits log text past the total byte ceiling (logTextOmitted: size)', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);
        const base = Date.now();
        // Three 10-byte bundles; exported newest first (occurred_at DESC).
        for (const [i, text] of ['newest-000', 'middle-000', 'oldest-000'].entries()) {
            const r = await ingestLogBundle(sql, userId, {
                eventId: crypto.randomUUID(),
                platform: 'ios',
                occurredAt: base - i * 60_000,
                trigger: 'user',
                scope: 'account',
                contentGzipBase64: gzipSync(Buffer.from(text)).toString('base64'),
            });
            expect(r.ok).toBe(true);
        }

        setExportLogTextCapOverrideForTests(25);
        try {
            const out = await collectUserExport(sql, username);
            if (!out) throw new Error('export was null');
            const rows = (out.client_diagnostics as { rows: Record<string, unknown>[] }).rows;
            expect(rows.map((r) => r.logText)).toEqual(['newest-000', 'middle-000', null]);
            expect(rows[2].logTextOmitted).toBe('size');
            expect(rows[0].logTextOmitted).toBeUndefined();
        } finally {
            setExportLogTextCapOverrideForTests(null);
        }
    });

    it("export marks a bundle 'busy' when no decode slot can be had, instead of failing the export", async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);
        const r = await ingestLogBundle(sql, userId, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('busy log')).toString('base64'),
        });
        expect(r.ok).toBe(true);

        // Saturate the semaphore: 2 held slots + a full waiter queue (8) makes the next
        // caller fail immediately rather than wait.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const holders = Array.from({ length: 10 }, () =>
            withBundleSlot(() => held, 30_000).catch(() => undefined),
        );
        try {
            const out = await collectUserExport(sql, username);
            if (!out) throw new Error('export was null');
            const rows = (out.client_diagnostics as { rows: Record<string, unknown>[] }).rows;
            expect(rows[0].logText).toBeNull();
            expect(rows[0].logTextError).toBe('busy');
        } finally {
            release();
            await Promise.all(holders);
        }
    });

    it('erasure deletes bundles and scrubs every linkability column and user-derived payload key across every kind', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 8_100_001 });

        // log_bundle — the user's own logs: must be hard-deleted, blob included.
        const bundleResult = await ingestLogBundle(sql, userId, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('x')).toString('base64'),
        });
        expect(bundleResult.ok).toBe(true);
        if (!bundleResult.ok) throw new Error('bundle ingest failed');

        // playback_incident — writes through recordPlaybackIncident; payload carries
        // message/timeline/clientInfo, all user-derived.
        await ingestDiagnosticEvents(sql, userId, [
            {
                eventId: crypto.randomUUID(),
                platform: 'ios',
                occurredAt: Date.now(),
                deviceId: 'device-incident',
                playSessionId: 'session-incident',
                attemptId: 'attempt-incident',
                mediaId,
                kind: 'playback_incident',
                payload: {
                    triggerType: 'error',
                    errorType: 'network',
                    message: 'playback stalled while watching Movie X',
                    timeline: [{ t: 1, event: 'stall' }],
                    clientInfo: { ua: 'LumastraTV/1.0' },
                },
            },
            // js_error — route IS user-derived free text here and must be scrubbed.
            {
                eventId: crypto.randomUUID(),
                platform: 'web',
                occurredAt: Date.now(),
                deviceId: 'device-js',
                playSessionId: 'session-js',
                attemptId: 'attempt-js',
                mediaId,
                kind: 'js_error',
                payload: {
                    name: 'TypeError',
                    message: 'x is not a function',
                    stack: 'at foo (bar.js:1:1)',
                    route: '/watch/:id',
                    origin: 'window_error',
                },
            },
            // crash — exceptionReason/terminationReason/exceptionName are user-derived
            // free text (can contain a process/URL/username) and must be scrubbed.
            {
                eventId: crypto.randomUUID(),
                platform: 'ios',
                occurredAt: Date.now(),
                deviceId: 'device-crash',
                playSessionId: 'session-crash',
                attemptId: 'attempt-crash',
                mediaId,
                kind: 'crash',
                payload: {
                    source: 'exception_handler',
                    confidence: 'high',
                    exceptionName: 'NSInvalidArgumentException',
                    exceptionReason: "-[NSNull length]: unrecognized selector for user 'alice'",
                    terminationReason: 'Namespace SIGNAL, Code 5',
                    callStacks: [],
                    logTail: {
                        lines: ['watching Movie X'],
                        truncated: false,
                        source: 'previous_run',
                    },
                },
            },
            // hang — same crash/hang payload shape.
            {
                eventId: crypto.randomUUID(),
                platform: 'ios',
                occurredAt: Date.now(),
                deviceId: 'device-hang',
                playSessionId: 'session-hang',
                attemptId: 'attempt-hang',
                mediaId,
                kind: 'hang',
                payload: {
                    source: 'metrickit',
                    confidence: 'low',
                    exceptionReason: 'main thread blocked in fetchProfile(for: "alice")',
                    terminationReason: 'hang watchdog',
                    hangDurationMs: 4000,
                    callStacks: [],
                    logTail: { lines: ['hang line'], truncated: false, source: 'current_run' },
                },
            },
            // api_failures — route is a normalized operationId/templated path, NOT
            // user data, and must be KEPT (only kind that keeps its route).
            {
                eventId: crypto.randomUUID(),
                platform: 'ios',
                occurredAt: Date.now(),
                deviceId: 'device-api',
                playSessionId: 'session-api',
                attemptId: 'attempt-api',
                mediaId,
                kind: 'api_failures',
                payload: {
                    windowStart: Date.now() - 1000,
                    windowEnd: Date.now(),
                    method: 'GET',
                    route: 'getV1Items',
                    outcome: 'status_5xx',
                    status: 500,
                },
            },
        ]);

        const ids = await sql<{ id: number; kind: string }[]>`
            SELECT id, kind FROM client_diagnostics WHERE user_id = ${userId}::uuid
        `;
        expect(ids).toHaveLength(6);
        const bundleId = ids.find((r) => r.kind === 'log_bundle')!.id;

        const report = await eraseUserData(sql, userId, username);
        expect(report).not.toBeNull();
        if (!report) throw new Error('erasure returned null');
        const entry = report.tables.find((t) => t.table === 'client_diagnostics');
        expect(entry?.deleted).toBe(1); // the log_bundle row
        expect(entry?.anonymized).toBe(5); // the other five kinds

        // The bundle row itself, and its blob, must be gone entirely.
        const bundleGone = await sql<{ id: number }[]>`
            SELECT id FROM client_diagnostics WHERE id = ${bundleId}
        `;
        expect(bundleGone).toHaveLength(0);
        const blobGone = await sql<{ id: number }[]>`
            SELECT id FROM client_diagnostic_blobs WHERE diagnostic_id = ${bundleId}
        `;
        expect(blobGone).toHaveLength(0);

        const left = await sql<
            {
                id: number;
                kind: string;
                user_id: string | null;
                device_id: string | null;
                play_session_id: string | null;
                attempt_id: string | null;
                media_id: string | null;
                summary: string | null;
                fingerprint: string | null;
                platform: string;
                payload: Record<string, unknown>;
            }[]
        >`
            SELECT id, kind, user_id, device_id, play_session_id, attempt_id, media_id,
                   summary, fingerprint, platform, payload
            FROM client_diagnostics
            WHERE id = ANY(${ids.filter((r) => r.kind !== 'log_bundle').map((r) => r.id)})
        `;
        expect(left).toHaveLength(5);
        for (const row of left) {
            // Linkability columns: nulled for every kind.
            expect(row.user_id).toBeNull();
            expect(row.device_id).toBeNull();
            expect(row.play_session_id).toBeNull();
            expect(row.attempt_id).toBeNull();
            expect(row.media_id).toBeNull();
            expect(row.summary).toBeNull();
            // Kept: forensic shape.
            expect(row.kind).toBeTruthy();
            expect(row.platform).toBeTruthy();

            // Universally-scrubbed payload keys.
            expect(row.payload.logTail).toBeUndefined();
            expect(row.payload.clientInfo).toBeUndefined();
            expect(row.payload.message).toBeUndefined();
            expect(row.payload.stack).toBeUndefined();
            expect(row.payload.timeline).toBeUndefined();
            expect(row.payload.exceptionReason).toBeUndefined();
            expect(row.payload.terminationReason).toBeUndefined();
            expect(row.payload.exceptionName).toBeUndefined();

            if (row.kind === 'js_error') {
                expect(row.payload.route).toBeUndefined();
            }
            if (row.kind === 'api_failures') {
                // Kept: a normalized operationId, not user data.
                expect(row.payload.route).toBe('getV1Items');
                expect(row.payload.status).toBe(500);
            }
        }
    });

    it('erasure anonymizes a server-written compat_incident row: misses and deviceName go, user_id is nulled', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);
        const payload = {
            source: 'jellyfin_compat',
            reason: 'silent_start',
            clientName: 'Findroid',
            clientVersion: '0.15.0',
            deviceName: "alice's Pixel",
            misses: [{ itemId: 'item-1', armedAt: 1, shape: 'x', violations: ['v'] }],
        };
        const [row] = await sql<{ id: number }[]>`
            INSERT INTO client_diagnostics (event_id, kind, user_id, platform, occurred_at, summary, payload)
            VALUES (gen_random_uuid(), 'compat_incident', ${userId}::uuid, 'other', now(),
                    'Jellyfin client: playback never started (Findroid 0.15.0)', ${sql.json(payload)})
            RETURNING id
        `;

        const report = await eraseUserData(sql, userId, username);
        expect(report).not.toBeNull();

        const [after] = await sql<
            { user_id: string | null; summary: string | null; payload: Record<string, unknown> }[]
        >`SELECT user_id, summary, payload FROM client_diagnostics WHERE id = ${row.id}`;
        expect(after.user_id).toBeNull();
        expect(after.summary).toBeNull();
        expect('misses' in after.payload).toBe(false);
        expect('deviceName' in after.payload).toBe(false);
        expect(after.payload.reason).toBe('silent_start');
    });

    it('stores accountIds lowercased + de-duplicated so an UPPERCASE id (Apple clients) still matches at erasure', async () => {
        const userA = generateTestUserId();
        const userB = generateTestUserId();
        await ensureTestUser(sql, userA);
        await ensureTestUser(sql, userB);

        const bundle = await ingestLogBundle(sql, userA, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'device',
            deviceId: 'shared-device-upper',
            accountIds: [userA.toUpperCase(), userB.toUpperCase(), userB],
            contentGzipBase64: gzipSync(Buffer.from('shared device log')).toString('base64'),
        });
        expect(bundle.ok).toBe(true);
        if (!bundle.ok) throw new Error('bundle ingest failed');

        const [stored] = await sql<{ ids: string[] }[]>`
            SELECT payload->'accountIds' AS ids FROM client_diagnostics WHERE id = ${bundle.diagnosticId}
        `;
        expect(stored.ids).toEqual([userA.toLowerCase(), userB.toLowerCase()]);

        const report = await eraseUserData(sql, userB, derivedUsername(userB));
        expect(report).not.toBeNull();
        const gone = await sql`SELECT id FROM client_diagnostics WHERE id = ${bundle.diagnosticId}`;
        expect(gone).toHaveLength(0);
    });

    it('deletes a device-scoped bundle uploaded by ANOTHER account when the erased user appears in its accountIds', async () => {
        const userA = generateTestUserId();
        const userB = generateTestUserId();
        await ensureTestUser(sql, userA);
        await ensureTestUser(sql, userB);
        const usernameB = derivedUsername(userB);

        // A device-scoped bundle A uploaded that also contains B's log segments.
        const sharedBundle = await ingestLogBundle(sql, userA, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'device',
            deviceId: 'shared-device',
            accountIds: [userA, userB],
            contentGzipBase64: gzipSync(Buffer.from('shared device log')).toString('base64'),
        });
        expect(sharedBundle.ok).toBe(true);
        if (!sharedBundle.ok) throw new Error('shared bundle ingest failed');

        // A's own account-scoped bundle (no B in accountIds) — must survive B's erasure.
        const ownBundle = await ingestLogBundle(sql, userA, {
            eventId: crypto.randomUUID(),
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('A only log')).toString('base64'),
        });
        expect(ownBundle.ok).toBe(true);
        if (!ownBundle.ok) throw new Error('own bundle ingest failed');

        const report = await eraseUserData(sql, userB, usernameB);
        expect(report).not.toBeNull();
        if (!report) throw new Error('erasure returned null');
        const entry = report.tables.find((t) => t.table === 'client_diagnostics');
        // The shared bundle is attributed to A (user_id = A), not B, so it is
        // matched and deleted purely via payload.accountIds ? B, not user_id = B.
        expect(entry?.deleted).toBe(1);

        const sharedGone = await sql<{ id: number }[]>`
            SELECT id FROM client_diagnostics WHERE id = ${sharedBundle.diagnosticId}
        `;
        expect(sharedGone).toHaveLength(0);

        const ownStillThere = await sql<{ id: number; user_id: string | null }[]>`
            SELECT id, user_id FROM client_diagnostics WHERE id = ${ownBundle.diagnosticId}
        `;
        expect(ownStillThere).toHaveLength(1);
        expect(ownStillThere[0].user_id).toBe(userA);
    });
});
