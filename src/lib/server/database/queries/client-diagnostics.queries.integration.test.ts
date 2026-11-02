// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import {
    insertClientDiagnostics,
    insertLogBundle,
    listClientDiagnostics,
    getClientDiagnosticById,
    getLogBundleBlob,
    deleteClientDiagnostics,
    pruneClientDiagnostics,
    enforceClientDiagnosticRowCap,
    sumBytesLast24h,
    pruneJellyfinBundlesForDevice,
    type NewClientDiagnostic,
} from './client-diagnostics.queries.js';

let sql: postgres.Sql;
let userId: string;

function row(over: Partial<NewClientDiagnostic> = {}): NewClientDiagnostic {
    return {
        eventId: randomUUID(),
        kind: 'js_error',
        userId,
        deviceId: 'dev-1',
        platform: 'web',
        appVersion: '1.0',
        appBuild: null,
        osVersion: null,
        deviceModel: null,
        playSessionId: null,
        attemptId: null,
        mediaId: null,
        occurredAt: new Date(),
        fingerprint: 'fp-1',
        occurrences: 1,
        summary: 'TypeError: x',
        payload: { name: 'TypeError' },
        payloadBytes: 100,
        ...over,
    };
}

describe('client-diagnostics.queries', () => {
    beforeAll(async () => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE client_diagnostics CASCADE`;
        const user = await createTestUser(sql);
        userId = user.id;
    });

    it('is idempotent per (user, event_id)', async () => {
        const r = row();
        expect(await insertClientDiagnostics(sql, [r, row()])).toBe(2);
        expect(await insertClientDiagnostics(sql, [r])).toBe(0);
        const { total } = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(total).toBe(2);
    });

    it('filters by kind list, platform, user, fingerprint and short-id search', async () => {
        const target = row({
            eventId: '7f3a91c2-0000-4000-8000-000000000001',
            kind: 'crash',
            platform: 'ios',
            fingerprint: 'fp-crash',
        });
        await insertClientDiagnostics(sql, [target, row()]);
        expect(
            (await listClientDiagnostics(sql, { kinds: ['crash'], limit: 10, offset: 0 })).total,
        ).toBe(1);
        expect(
            (await listClientDiagnostics(sql, { platform: 'web', limit: 10, offset: 0 })).total,
        ).toBe(1);
        expect(
            (await listClientDiagnostics(sql, { fingerprint: 'fp-crash', limit: 10, offset: 0 }))
                .total,
        ).toBe(1);
        expect(
            (await listClientDiagnostics(sql, { q: '7F3A-91C2', limit: 10, offset: 0 })).total,
        ).toBe(1);
        expect((await listClientDiagnostics(sql, { userId, limit: 10, offset: 0 })).total).toBe(2);
    });

    it('stores a bundle blob and serves it back; delete cascades', async () => {
        const created = await insertLogBundle(sql, row({ kind: 'log_bundle', fingerprint: null }), {
            content: Buffer.from([0x1f, 0x8b, 1, 2]),
            uncompressedBytes: 10,
            sha256: 'a'.repeat(64),
        });
        expect(created).not.toBeNull();
        const detail = await getClientDiagnosticById(sql, created!.id);
        expect(detail?.has_blob).toBe(true);
        expect(detail?.blob_content_bytes).toBe(4);
        const blob = await getLogBundleBlob(sql, created!.id);
        expect(blob?.content.length).toBe(4);
        expect(await deleteClientDiagnostics(sql, { kinds: ['log_bundle'] })).toBe(1);
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostic_blobs`;
        expect(n).toBe(0);
    });

    it('prunes /j ClientLog bundles to the newest N per (user, device) only', async () => {
        const blob = {
            content: Buffer.from([0x1f, 0x8b]),
            uncompressedBytes: 2,
            sha256: 'b'.repeat(64),
        };
        const mk = (deviceId: string, source?: string) =>
            insertLogBundle(
                sql,
                row({
                    kind: 'log_bundle',
                    fingerprint: null,
                    deviceId,
                    payload: source ? { source } : {},
                }),
                blob,
            );
        for (let i = 0; i < 7; i++) await mk('d1', 'jellyfin');
        for (let i = 0; i < 2; i++) await mk('d2', 'jellyfin');
        await mk('d1');
        expect(await pruneJellyfinBundlesForDevice(sql, userId, 'd1', 5)).toBe(2);
        const count = async (d: string, jf: boolean) =>
            (
                await sql<{ n: number }[]>`
                    SELECT count(*)::int AS n FROM client_diagnostics
                    WHERE device_id = ${d} AND kind = 'log_bundle'
                      AND (payload->>'source' IS NOT DISTINCT FROM 'jellyfin') = ${jf}`
            )[0].n;
        expect(await count('d1', true)).toBe(5);
        expect(await count('d2', true)).toBe(2);
        expect(await count('d1', false)).toBe(1);
    });

    it('sums payload bytes of the last 24h per user', async () => {
        await insertClientDiagnostics(sql, [
            row({ payloadBytes: 300 }),
            row({ payloadBytes: 200 }),
        ]);
        expect(await sumBytesLast24h(sql, userId)).toBe(500);
    });

    it('prunes by received_at and caps rows per user within the given kinds only', async () => {
        await insertClientDiagnostics(sql, [
            row(),
            row(),
            row(),
            row({ kind: 'playback_incident', attemptId: 'a', fingerprint: null }),
        ]);
        await sql`UPDATE client_diagnostics SET received_at = now() - interval '40 days' WHERE kind = 'js_error'`;
        expect(
            await pruneClientDiagnostics(sql, ['js_error'], new Date(Date.now() - 30 * 86_400_000)),
        ).toBe(3);
        await insertClientDiagnostics(sql, [row(), row(), row()]);
        expect(await enforceClientDiagnosticRowCap(sql, ['js_error'], 1)).toBe(2);
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE kind = 'playback_incident'`;
        expect(n).toBe(1);
    });

    it('deleteClientDiagnostics refuses an unfiltered delete unless allowAll is passed', async () => {
        await insertClientDiagnostics(sql, [row(), row(), row()]);
        await expect(deleteClientDiagnostics(sql, {})).rejects.toThrow(/allowAll/);
        const before = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(before.total).toBe(3);

        // An empty `kinds` array is the same as "no kinds filter" — still unfiltered.
        await expect(deleteClientDiagnostics(sql, { kinds: [] })).rejects.toThrow(/allowAll/);
        expect((await listClientDiagnostics(sql, { limit: 10, offset: 0 })).total).toBe(3);

        expect(await deleteClientDiagnostics(sql, {}, { allowAll: true })).toBe(3);
        const after = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(after.total).toBe(0);
    });

    it('treats a blank/whitespace string filter as unset, so it cannot bypass the allowAll guard', async () => {
        await insertClientDiagnostics(sql, [row(), row(), row()]);

        await expect(deleteClientDiagnostics(sql, { appVersion: '' })).rejects.toThrow(/allowAll/);
        expect((await listClientDiagnostics(sql, { limit: 10, offset: 0 })).total).toBe(3);

        await expect(deleteClientDiagnostics(sql, { deviceId: '  ' })).rejects.toThrow(/allowAll/);
        expect((await listClientDiagnostics(sql, { limit: 10, offset: 0 })).total).toBe(3);

        // A blank appVersion filter must also behave like "no filter" for list/count.
        const blank = await listClientDiagnostics(sql, { appVersion: '', limit: 10, offset: 0 });
        const unfiltered = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(blank.total).toBe(unfiltered.total);
    });

    it('falls back to the play session media item when media_id points at a deleted media item', async () => {
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Session Movie', 'movie') RETURNING id
        `;
        const playSessionId = randomUUID();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${playSessionId}::uuid, ${media.id}::uuid, ${userId}::uuid, 'dev-1', '0.0.0.0'::inet, 'direct')
        `;
        const danglingMediaId = randomUUID();
        const created = await insertClientDiagnostics(sql, [
            row({ playSessionId, mediaId: danglingMediaId }),
        ]);
        expect(created).toBe(1);

        const { rows } = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(rows[0]?.media_id).toBe(media.id);
        expect(rows[0]?.media_title).toBe('Session Movie');

        const [listedRowRaw] = await sql<{ id: number }[]>`
            SELECT id FROM client_diagnostics WHERE play_session_id = ${playSessionId}
        `;
        const detail = await getClientDiagnosticById(sql, listedRowRaw.id);
        expect(detail?.media_id).toBe(media.id);
        expect(detail?.media_title).toBe('Session Movie');
    });

    it("does not resolve another user's play session (forged playSessionId leaks no media title)", async () => {
        const victim = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type) VALUES ('Victim Private Movie', 'movie') RETURNING id
        `;
        const victimSession = randomUUID();
        await sql`
            INSERT INTO play_sessions (id, media_id, user_id, device_id, ip_address, play_method)
            VALUES (${victimSession}::uuid, ${media.id}::uuid, ${victim.id}::uuid, 'dev-v', '0.0.0.0'::inet, 'direct')
        `;
        // The reporting user names the victim's session id (uppercased, as Apple sends).
        await insertClientDiagnostics(sql, [row({ playSessionId: victimSession.toUpperCase() })]);

        const { rows } = await listClientDiagnostics(sql, { limit: 10, offset: 0 });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.media_id).toBeNull();
        expect(rows[0]?.media_title).toBeNull();
        const detail = await getClientDiagnosticById(sql, rows[0]!.id);
        expect(detail?.media_id).toBeNull();
        expect(detail?.media_title).toBeNull();
    });

    it('treats a blank q as no filter, matches an appVersion prefix, and does not let % or _ act as a wildcard', async () => {
        await insertClientDiagnostics(sql, [
            row({ appVersion: '1.2.3' }),
            row({ appVersion: '1.2.9' }),
            row({ appVersion: '2.0.0' }),
            row({ summary: '50% failure_rate spike' }),
        ]);
        expect((await listClientDiagnostics(sql, { q: '', limit: 10, offset: 0 })).total).toBe(4);
        expect((await listClientDiagnostics(sql, { q: '   ', limit: 10, offset: 0 })).total).toBe(
            4,
        );

        expect(
            (await listClientDiagnostics(sql, { appVersion: '1.2', limit: 10, offset: 0 })).total,
        ).toBe(2);
        expect(
            (await listClientDiagnostics(sql, { appVersion: '2.0.0', limit: 10, offset: 0 })).total,
        ).toBe(1);

        // A literal '%' or '_' in q must be matched literally, not as a SQL LIKE wildcard.
        expect(
            (await listClientDiagnostics(sql, { q: '50% failure', limit: 10, offset: 0 })).total,
        ).toBe(1);
        expect(
            (await listClientDiagnostics(sql, { q: 'failure_rate', limit: 10, offset: 0 })).total,
        ).toBe(1);
        expect(
            (await listClientDiagnostics(sql, { q: 'failureXrate', limit: 10, offset: 0 })).total,
        ).toBe(0);
    });
});
