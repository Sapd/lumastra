// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { config } from '$lib/server/config.js';
import {
    ingestDiagnosticEvents,
    ingestLogBundle,
    recordJsErrorFromLegacy,
    setBudgetOverrideForTests,
    setIncidentCapOverrideForTests,
    setStoredBundleCapOverrideForTests,
} from './ingest.service.js';
import { resolvePlaybackIncident } from '../playback-incident.service.js';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';

let sql: postgres.Sql;
let userId: string;
const now = (): number => Date.now();
const jsError = (over: Partial<DiagnosticEventInput> = {}): DiagnosticEventInput =>
    ({
        eventId: randomUUID(),
        platform: 'web',
        occurredAt: now(),
        kind: 'js_error',
        payload: { name: 'TypeError', message: 'x token=abc', origin: 'window_error' },
        ...over,
    }) as DiagnosticEventInput;

describe('client diagnostics ingest', () => {
    beforeAll(async () => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        vi.restoreAllMocks();
        setBudgetOverrideForTests(null);
        await sql`TRUNCATE client_diagnostics CASCADE`;
        const u = await createTestUser(sql);
        userId = u.id;
    });
    afterEach(() => {
        setBudgetOverrideForTests(null);
        setIncidentCapOverrideForTests(null);
        setStoredBundleCapOverrideForTests(null);
    });

    it('stores, redacts and fingerprints; a resent batch is a no-op', async () => {
        const batch = [jsError(), jsError()];
        expect(await ingestDiagnosticEvents(sql, userId, batch)).toEqual({
            accepted: 2,
            dropped: 0,
        });
        expect(await ingestDiagnosticEvents(sql, userId, batch)).toEqual({
            accepted: 0,
            dropped: 0,
        });
        const rows = await sql<
            { fingerprint: string; payload: Record<string, unknown> }[]
        >`SELECT fingerprint, payload FROM client_diagnostics`;
        expect(rows[0].fingerprint).toBeTruthy();
        expect(JSON.stringify(rows[0].payload)).not.toContain('abc');
    });

    it('deduplicates web incident retries and resolves every event for only the recovering user', async () => {
        const makeIncident = (): DiagnosticEventInput => ({
            kind: 'playback_incident',
            platform: 'web',
            eventId: randomUUID(),
            occurredAt: now(),
            attemptId: 'same-attempt',
            payload: { triggerType: 'terminal', timeline: [] },
        });
        const batch = [makeIncident(), makeIncident()];
        expect(await ingestDiagnosticEvents(sql, userId, batch)).toEqual({
            accepted: 2,
            dropped: 0,
        });
        expect(await ingestDiagnosticEvents(sql, userId, batch)).toEqual({
            accepted: 0,
            dropped: 0,
        });
        const other = await createTestUser(sql);
        await ingestDiagnosticEvents(sql, other.id, [makeIncident()]);
        await resolvePlaybackIncident(sql, userId, { attemptId: 'same-attempt' });
        await resolvePlaybackIncident(sql, userId, { attemptId: 'same-attempt' });
        const rows = await sql<
            { user_id: string; resolved_at: Date | null }[]
        >`SELECT user_id, resolved_at FROM client_diagnostics WHERE attempt_id = 'same-attempt'`;
        expect(rows.filter((r) => r.user_id === userId)).toHaveLength(2);
        expect(rows.filter((r) => r.user_id === userId).every((r) => r.resolved_at !== null)).toBe(
            true,
        );
        expect(rows.find((r) => r.user_id === other.id)?.resolved_at).toBeNull();
    });

    it('stores a web failure-shown report and an API failure with their new fields intact', async () => {
        const toast = jsError({
            payload: {
                name: 'AudiobookSessionError',
                message: 'Could not open the audiobook session',
                origin: 'error_toast',
                toastKey: 'audiobook_session_failed',
                route: '/(app)/+page',
                cause: {
                    method: 'POST',
                    route: '/api/v1/play-sessions',
                    outcome: 'status_5xx',
                    status: 502,
                    problemCode: 'bad_gateway',
                },
            },
        } as Partial<DiagnosticEventInput>);
        const api = {
            eventId: randomUUID(),
            platform: 'web',
            occurredAt: now(),
            occurrences: 4,
            kind: 'api_failures',
            payload: {
                windowStart: now(),
                windowEnd: now(),
                method: 'GET',
                route: '/api/media/:id',
                outcome: 'status_5xx',
                status: 500,
                problemCode: 'internal_error',
                requestId: 'req-42',
            },
        } as DiagnosticEventInput;
        expect(await ingestDiagnosticEvents(sql, userId, [toast, api])).toEqual({
            accepted: 2,
            dropped: 0,
        });
        const rows = await sql<
            {
                kind: string;
                summary: string;
                occurrences: number;
                payload: Record<string, unknown>;
            }[]
        >`SELECT kind, summary, occurrences, payload FROM client_diagnostics ORDER BY kind`;
        expect(rows.map((r) => r.kind)).toEqual(['api_failures', 'js_error']);
        expect(rows[0].payload).toMatchObject({
            problemCode: 'internal_error',
            requestId: 'req-42',
        });
        expect(rows[0].occurrences).toBe(4);
        expect(rows[0].summary).toBe('GET /api/media/:id → status_5xx 500 internal_error');
        expect(rows[1].payload).toMatchObject({
            origin: 'error_toast',
            toastKey: 'audiobook_session_failed',
            cause: { route: '/api/v1/play-sessions', problemCode: 'bad_gateway' },
        });
        expect(rows[1].summary).toBe(
            'Failure shown: audiobook_session_failed ← POST /api/v1/play-sessions 502',
        );
    });

    it('drops automatic kinds when the feature is off but keeps playback incidents', async () => {
        vi.spyOn(config, 'FEATURE_CLIENT_DIAGNOSTICS', 'get').mockReturnValue(false);
        const incident = {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'terminal', timeline: [] },
        } as DiagnosticEventInput;
        expect(await ingestDiagnosticEvents(sql, userId, [jsError(), incident])).toEqual({
            accepted: 1,
            dropped: 1,
        });
        const [{ kind }] = await sql<{ kind: string }[]>`SELECT kind FROM client_diagnostics`;
        expect(kind).toBe('playback_incident');
    });

    it('strips log tails when the log-tail feature is off', async () => {
        vi.spyOn(config, 'FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL', 'get').mockReturnValue(false);
        await ingestDiagnosticEvents(sql, userId, [
            jsError({
                payload: {
                    name: 'E',
                    message: 'm',
                    origin: 'window_error',
                    logTail: { lines: ['a'], truncated: false, source: 'current_run' },
                },
            } as Partial<DiagnosticEventInput>),
        ]);
        const [{ payload }] = await sql<
            { payload: Record<string, unknown> }[]
        >`SELECT payload FROM client_diagnostics`;
        expect(payload.logTail).toBeUndefined();
    });

    it('rejects a playback incident that fails the legacy cross-field rule', async () => {
        const bad = {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'error', timeline: [] },
        } as DiagnosticEventInput;
        await expect(ingestDiagnosticEvents(sql, userId, [bad])).rejects.toThrow(/errorType/);
    });

    it('validates the WHOLE batch before inserting anything (no partial batch on 422)', async () => {
        const good = jsError();
        const bad = {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'error', timeline: [] },
        } as DiagnosticEventInput;
        await expect(ingestDiagnosticEvents(sql, userId, [good, bad])).rejects.toThrow(/errorType/);
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics`;
        expect(n).toBe(0);
    });

    it('stores a bundle, returns a short id, and refuses a gzip bomb', async () => {
        const ok = await ingestLogBundle(sql, userId, {
            eventId: '7f3a91c2-1111-4000-8000-000000000000',
            platform: 'tvos',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            note: 'buffering on S2E4',
            contentGzipBase64: gzipSync(Buffer.from('line 1\nline 2\n')).toString('base64'),
        });
        expect(ok).toMatchObject({ ok: true, shortId: '7F3A-91C2' });
        const bomb = await ingestLogBundle(sql, userId, {
            eventId: randomUUID(),
            platform: 'tvos',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.alloc(40 * 1024 * 1024, 0)).toString('base64'),
        });
        expect(bomb).toEqual({ ok: false, reason: 'too_large' });
    });

    it('ignores a requestId that does not belong to this user (stored as a user trigger)', async () => {
        const res = await ingestLogBundle(sql, userId, {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            trigger: 'admin_request',
            requestId: randomUUID(),
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from('x')).toString('base64'),
        });
        expect(res.ok).toBe(true);
        const [{ payload }] = await sql<
            { payload: Record<string, unknown> }[]
        >`SELECT payload FROM client_diagnostics WHERE kind = 'log_bundle'`;
        expect(payload.trigger).toBe('user');
        expect(payload.requestId).toBeUndefined();
    });

    it('enforces the daily byte budget', async () => {
        setBudgetOverrideForTests(10);
        expect(await ingestDiagnosticEvents(sql, userId, [jsError()])).toEqual({
            accepted: 0,
            dropped: 1,
        });
    });

    it('records a legacy /client-errors report as js_error with its errorId', async () => {
        await recordJsErrorFromLegacy(sql, userId, {
            errorId: 'err-123',
            name: 'TypeError',
            message: 'boom',
            stack: 'at f (a.js:1:2)',
            path: '/browse',
            appVersion: '1.0.0-1790801234567',
        });
        const [row] = await sql<
            { kind: string; payload: Record<string, unknown>; app_version: string | null }[]
        >`SELECT kind, payload, app_version FROM client_diagnostics`;
        expect(row.kind).toBe('js_error');
        expect(row.app_version).toBe('1.0.0-1790801234567');
        expect(row.payload.errorId).toBe('err-123');
        expect(row.payload.route).toBe('/browse');
    });

    // --- Fix round 1 (2026-09-26 review) ------------------------------------------------

    it('strips log tails on a playback_incident too when the log-tail feature is off', async () => {
        vi.spyOn(config, 'FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL', 'get').mockReturnValue(false);
        const incident = {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: {
                triggerType: 'terminal',
                timeline: [],
                logTail: { lines: ['a'], truncated: false, source: 'current_run' },
            },
        } as DiagnosticEventInput;
        expect(await ingestDiagnosticEvents(sql, userId, [incident])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        const [{ payload }] = await sql<
            { payload: Record<string, unknown> }[]
        >`SELECT payload FROM client_diagnostics WHERE kind = 'playback_incident'`;
        expect(payload.logTail).toBeUndefined();
    });

    it("a server-written compat_incident row's payload_bytes does not reduce the budget for a later log bundle", async () => {
        const gz = gzipSync(Buffer.from('hello')).toString('base64');
        const bundleBytes = Buffer.from(gz, 'base64').length;
        setBudgetOverrideForTests(bundleBytes + 50);
        await sql`
            INSERT INTO client_diagnostics (event_id, kind, user_id, platform, occurred_at, payload, payload_bytes)
            VALUES (gen_random_uuid(), 'compat_incident', ${userId}::uuid, 'other', now(), '{}'::jsonb, 100000)
        `;
        const res = await ingestLogBundle(sql, userId, {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gz,
        });
        expect(res.ok).toBe(true);
    });

    it('exempts playback_incident from the daily byte budget — still accepted when exhausted', async () => {
        setBudgetOverrideForTests(0);
        const incident = {
            eventId: randomUUID(),
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'terminal', timeline: [] },
        } as DiagnosticEventInput;
        expect(await ingestDiagnosticEvents(sql, userId, [incident])).toEqual({
            accepted: 1,
            dropped: 0,
        });
    });

    it('caps new playback incidents per user per rolling 24 h (budget-exempt, so this is their bound)', async () => {
        setIncidentCapOverrideForTests(2);
        const incident = (): DiagnosticEventInput =>
            ({
                eventId: randomUUID(),
                platform: 'ios',
                occurredAt: now(),
                kind: 'playback_incident',
                attemptId: 'a',
                payload: { triggerType: 'terminal', timeline: [] },
            }) as DiagnosticEventInput;
        const first = [incident(), incident(), incident()];
        expect(await ingestDiagnosticEvents(sql, userId, first)).toEqual({
            accepted: 2,
            dropped: 1,
        });
        // The window is rolling across requests, not per batch.
        expect(await ingestDiagnosticEvents(sql, userId, [incident()])).toEqual({
            accepted: 0,
            dropped: 1,
        });
        // A resend of an already-stored incident is a silent no-op, not a drop.
        expect(await ingestDiagnosticEvents(sql, userId, [first[0]])).toEqual({
            accepted: 0,
            dropped: 0,
        });
        // Other kinds are unaffected by the incident cap.
        expect(await ingestDiagnosticEvents(sql, userId, [jsError()])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        // Rows older than 24 h (by server receipt) no longer count.
        await sql`UPDATE client_diagnostics SET received_at = now() - interval '2 days' WHERE kind = 'playback_incident'`;
        expect(await ingestDiagnosticEvents(sql, userId, [incident()])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        // Another user has their own window.
        const other = await createTestUser(sql);
        expect(await ingestDiagnosticEvents(sql, other.id, [incident(), incident()])).toEqual({
            accepted: 2,
            dropped: 0,
        });
    });

    it('lets a server caller add payload fields and override the trigger, but never the sizes', async () => {
        const eventId = randomUUID();
        const content = gzipSync(Buffer.from('some log\n'));
        const result = await ingestLogBundle(
            sql,
            userId,
            {
                eventId,
                platform: 'other',
                occurredAt: now(),
                trigger: 'user',
                scope: 'device',
                contentGzipBase64: content.toString('base64'),
            },
            { trigger: 'client_upload', extraPayload: { source: 'jellyfin', sha256: 'forged' } },
        );
        expect(result.ok).toBe(true);
        const [row] = await sql<{ payload: Record<string, unknown> }[]>`
            SELECT payload FROM client_diagnostics WHERE event_id = ${eventId}::uuid`;
        expect(row.payload).toMatchObject({ source: 'jellyfin', trigger: 'client_upload' });
        expect(row.payload.sha256).not.toBe('forged');
    });

    it('rejects a bundle whose STORED (scrubbed, re-gzipped) size exceeds the compressed cap', async () => {
        const eventId = randomUUID();
        const content = gzipSync(Buffer.from('line with some text\n'.repeat(50)));
        // Set the stored cap below the re-gzipped size of this (valid) upload.
        setStoredBundleCapOverrideForTests(10);
        const result = await ingestLogBundle(sql, userId, {
            eventId,
            platform: 'ios',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: content.toString('base64'),
        });
        expect(result).toEqual({ ok: false, reason: 'too_large' });
        const rows = await sql`SELECT id FROM client_diagnostics WHERE event_id = ${eventId}::uuid`;
        expect(rows).toHaveLength(0);

        setStoredBundleCapOverrideForTests(null);
        const retry = await ingestLogBundle(sql, userId, {
            eventId,
            platform: 'ios',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: content.toString('base64'),
        });
        expect(retry.ok).toBe(true);
    });

    it('does not charge or drop a resend of an already-stored event at the budget boundary', async () => {
        const event = jsError();
        expect(await ingestDiagnosticEvents(sql, userId, [event])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        // If the resend were re-charged against the budget it would be dropped here.
        setBudgetOverrideForTests(0);
        expect(await ingestDiagnosticEvents(sql, userId, [event])).toEqual({
            accepted: 0,
            dropped: 0,
        });
    });

    it('never lets concurrent event batches overshoot the daily budget', async () => {
        // Learn the real per-event payload size empirically, then size the budget to fit
        // exactly 2 of 6 concurrent, distinct-eventId sends.
        const probe = jsError();
        await ingestDiagnosticEvents(sql, userId, [probe]);
        const [{ payload_bytes: size }] = await sql<
            { payload_bytes: number }[]
        >`SELECT payload_bytes FROM client_diagnostics WHERE event_id = ${probe.eventId}::uuid`;
        await sql`DELETE FROM client_diagnostics WHERE event_id = ${probe.eventId}::uuid`;

        setBudgetOverrideForTests(size * 2);
        const events = Array.from({ length: 6 }, () => jsError());
        const results = await Promise.all(
            events.map((e) => ingestDiagnosticEvents(sql, userId, [e])),
        );
        const totalAccepted = results.reduce((sum, r) => sum + r.accepted, 0);
        expect(totalAccepted).toBe(2);

        const [{ total }] = await sql<
            { total: string }[]
        >`SELECT COALESCE(SUM(payload_bytes), 0)::text AS total FROM client_diagnostics WHERE user_id = ${userId}::uuid`;
        expect(Number(total)).toBeLessThanOrEqual(size * 2);
    });

    it('never lets concurrent bundle uploads overshoot the daily budget', async () => {
        // Every upload below shares this EXACT content, so each produces the same stored
        // (sanitized, re-gzipped) size deterministically — learn it once from a probe sent
        // and then removed, then size the budget to fit exactly one of the 4 concurrent
        // sends that follow (each with a distinct eventId, same content).
        const content = 'same size probe line\n';
        setBudgetOverrideForTests(null);
        const probeResult = await ingestLogBundle(sql, userId, {
            eventId: randomUUID(),
            platform: 'tvos',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from(content)).toString('base64'),
        });
        expect(probeResult.ok).toBe(true);
        const [{ payload_bytes: size }] = await sql<
            { payload_bytes: number }[]
        >`SELECT payload_bytes FROM client_diagnostics WHERE kind = 'log_bundle'`;
        await sql`TRUNCATE client_diagnostics CASCADE`;

        setBudgetOverrideForTests(size);
        const inputs = Array.from({ length: 4 }, () => ({
            eventId: randomUUID(),
            platform: 'tvos' as const,
            occurredAt: now(),
            trigger: 'user' as const,
            scope: 'account' as const,
            contentGzipBase64: gzipSync(Buffer.from(content)).toString('base64'),
        }));
        const results = await Promise.all(inputs.map((i) => ingestLogBundle(sql, userId, i)));
        const accepted = results.filter((r) => r.ok).length;
        expect(accepted).toBeLessThanOrEqual(1);

        const [{ total }] = await sql<
            { total: string }[]
        >`SELECT COALESCE(SUM(payload_bytes), 0)::text AS total FROM client_diagnostics WHERE user_id = ${userId}::uuid`;
        expect(Number(total)).toBeLessThanOrEqual(size);
    });

    it('bundle idempotency: the same eventId sent twice returns the same diagnosticId, one row, one blob', async () => {
        const eventId = randomUUID();
        const input = {
            eventId,
            platform: 'ios' as const,
            occurredAt: now(),
            trigger: 'user' as const,
            scope: 'account' as const,
            contentGzipBase64: gzipSync(Buffer.from('dup line\n')).toString('base64'),
        };
        const first = await ingestLogBundle(sql, userId, input);
        const second = await ingestLogBundle(sql, userId, input);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        if (first.ok && second.ok) {
            expect(second.diagnosticId).toBe(first.diagnosticId);
        }
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE event_id = ${eventId}::uuid`;
        expect(n).toBe(1);
        const [{ blobs }] = await sql<
            { blobs: number }[]
        >`SELECT count(*)::int AS blobs FROM client_diagnostic_blobs b JOIN client_diagnostics cd ON cd.id = b.diagnostic_id WHERE cd.event_id = ${eventId}::uuid`;
        expect(blobs).toBe(1);
    });

    it('scrubs secrets out of the STORED bundle content, not just structured fields', async () => {
        const raw = 'GET /x?api_key=SECRET HTTP/1.1\nAuthorization: Bearer abc.def\nnormal line\n';
        const eventId = randomUUID();
        const result = await ingestLogBundle(sql, userId, {
            eventId,
            platform: 'ios',
            occurredAt: now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: gzipSync(Buffer.from(raw)).toString('base64'),
        });
        expect(result.ok).toBe(true);

        const [{ content }] = await sql<
            { content: Buffer }[]
        >`SELECT b.content FROM client_diagnostic_blobs b JOIN client_diagnostics cd ON cd.id = b.diagnostic_id WHERE cd.event_id = ${eventId}::uuid`;
        const { gunzipSync } = await import('node:zlib');
        const storedText = gunzipSync(content).toString('utf8');
        expect(storedText).not.toContain('SECRET');
        expect(storedText).not.toContain('abc.def');
        expect(storedText).toContain('normal line');

        // sha256/uncompressedBytes/contentBytes describe the STORED (sanitized) content.
        const [{ payload, payload_bytes: payloadBytes }] = await sql<
            { payload: Record<string, unknown>; payload_bytes: number }[]
        >`SELECT payload, payload_bytes FROM client_diagnostics WHERE event_id = ${eventId}::uuid`;
        const { createHash } = await import('node:crypto');
        expect(payload.sha256).toBe(createHash('sha256').update(storedText, 'utf8').digest('hex'));
        expect(payload.uncompressedBytes).toBe(Buffer.byteLength(storedText, 'utf8'));
        const [{ blobBytes }] = await sql<
            { blobBytes: number }[]
        >`SELECT b.content_bytes AS "blobBytes" FROM client_diagnostic_blobs b JOIN client_diagnostics cd ON cd.id = b.diagnostic_id WHERE cd.event_id = ${eventId}::uuid`;
        expect(payloadBytes).toBe(blobBytes);
    });

    // --- Fix round: in-batch eventId dedup + deterministic legacy js_error id ------------

    it('charges the budget once for two events sharing an eventId in the same batch', async () => {
        const dupId = randomUUID();
        const one = jsError({ eventId: dupId });
        const two = jsError({ eventId: dupId });
        // Learn the real per-event payload size, then cap the budget so a SECOND charge
        // for the same eventId would drop the event — proving it was only charged once.
        const probe = jsError();
        await ingestDiagnosticEvents(sql, userId, [probe]);
        const [{ payload_bytes: size }] = await sql<
            { payload_bytes: number }[]
        >`SELECT payload_bytes FROM client_diagnostics WHERE event_id = ${probe.eventId}::uuid`;
        await sql`TRUNCATE client_diagnostics CASCADE`;

        setBudgetOverrideForTests(size); // room for exactly one charge, not two
        expect(await ingestDiagnosticEvents(sql, userId, [one, two])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE event_id = ${dupId}::uuid`;
        expect(n).toBe(1);
    });

    it('applies the same in-batch eventId dedup to playback_incident candidates', async () => {
        const dupId = randomUUID();
        const incident = (): DiagnosticEventInput =>
            ({
                eventId: dupId,
                platform: 'ios',
                occurredAt: now(),
                kind: 'playback_incident',
                attemptId: 'a',
                payload: { triggerType: 'terminal', timeline: [] },
            }) as DiagnosticEventInput;
        setIncidentCapOverrideForTests(1); // a second in-batch charge would exhaust this
        expect(await ingestDiagnosticEvents(sql, userId, [incident(), incident()])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE event_id = ${dupId}::uuid`;
        expect(n).toBe(1);
    });

    it('cross-kind dedup: incident first, js_error with the SAME eventId second — only the incident is stored, the js_error is neither charged nor dropped', async () => {
        const dupId = randomUUID();
        const incident: DiagnosticEventInput = {
            eventId: dupId,
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'terminal', timeline: [] },
        } as DiagnosticEventInput;
        const error = jsError({ eventId: dupId });
        // Budget = 0: if the js_error survived the (buggy) per-kind dedup and reached
        // budgeting, it would be DROPPED (not silently skipped) since it is not
        // budget-exempt. Getting accepted:1/dropped:0 here is only possible if the
        // js_error duplicate was removed before budgeting ever saw it.
        setBudgetOverrideForTests(0);
        expect(await ingestDiagnosticEvents(sql, userId, [incident, error])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        const rows = await sql<
            { kind: string }[]
        >`SELECT kind FROM client_diagnostics WHERE event_id = ${dupId}::uuid`;
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('playback_incident');
    });

    it('cross-kind dedup: js_error first, incident with the SAME eventId second — only the js_error is stored, the incident is neither charged nor dropped', async () => {
        const dupId = randomUUID();
        const error = jsError({ eventId: dupId });
        const incident: DiagnosticEventInput = {
            eventId: dupId,
            platform: 'ios',
            occurredAt: now(),
            kind: 'playback_incident',
            attemptId: 'a',
            payload: { triggerType: 'terminal', timeline: [] },
        } as DiagnosticEventInput;
        // Incident cap = 0: if the incident survived the (buggy) per-kind dedup and
        // reached the incident-cap check, it would be DROPPED (cap exhausted) rather
        // than silently skipped. Getting accepted:1/dropped:0 here is only possible if
        // the incident duplicate was removed before the cap check ever saw it.
        setIncidentCapOverrideForTests(0);
        expect(await ingestDiagnosticEvents(sql, userId, [error, incident])).toEqual({
            accepted: 1,
            dropped: 0,
        });
        const rows = await sql<
            { kind: string }[]
        >`SELECT kind FROM client_diagnostics WHERE event_id = ${dupId}::uuid`;
        expect(rows).toHaveLength(1);
        expect(rows[0].kind).toBe('js_error');
    });

    it('recordJsErrorFromLegacy: a resent errorId is a no-op; different errorIds each insert', async () => {
        await recordJsErrorFromLegacy(sql, userId, { errorId: 'dup-err', message: 'boom' });
        await recordJsErrorFromLegacy(sql, userId, { errorId: 'dup-err', message: 'boom again' });
        const [{ n: dupCount }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE kind = 'js_error'`;
        expect(dupCount).toBe(1);

        await recordJsErrorFromLegacy(sql, userId, { errorId: 'other-err', message: 'boom' });
        const [{ n: total }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM client_diagnostics WHERE kind = 'js_error'`;
        expect(total).toBe(2);
    });
});
