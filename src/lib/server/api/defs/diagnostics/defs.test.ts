// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for defs/diagnostics/{events,resolve,bundles}.ts.
 *
 * Handlers are called directly (`def.handlers.METHOD`) with a minimal fake
 * RequestEvent + ApiContext, mirroring defs/playback/incidents.test.ts. Every
 * export the defs import is mocked — an incomplete `vi.mock` factory surfaces
 * as a 500, not as the missing export (see common-context.md's repo traps).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dbConn from '$lib/server/database/connection.js';
import * as ingestService from '$lib/server/services/client-diagnostics/ingest.service.js';
import * as incidentService from '$lib/server/services/playback-incident.service.js';
import { def as eventsDef } from './events.js';
import { def as resolveDef } from './resolve.js';
import { def as bundlesDef } from './bundles.js';

function makeEvent(userId: string | undefined) {
    return {
        locals: { user: userId ? { userId } : undefined },
    } as never;
}

const CTX = { surface: 'internal' as const };

describe('defs/diagnostics', () => {
    beforeEach(() => {
        vi.spyOn(dbConn, 'getDb').mockReturnValue({} as never);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('events.ts POST', () => {
        it('returns 401 when unauthenticated', async () => {
            const res = await eventsDef.handlers.POST!(makeEvent(undefined), {
                ...CTX,
                input: { body: { events: [] } },
            } as never);
            expect(res.status).toBe(401);
        });

        it('returns 202 with {accepted, dropped} for a valid batch', async () => {
            const ingestSpy = vi
                .spyOn(ingestService, 'ingestDiagnosticEvents')
                .mockResolvedValue({ accepted: 2, dropped: 0 });

            const res = await eventsDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { events: [{ kind: 'js_error' }] } },
            } as never);

            expect(res.status).toBe(202);
            const body = await res.json();
            expect(body).toEqual({ accepted: 2, dropped: 0 });
            expect(ingestSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', [
                { kind: 'js_error' },
            ]);
        });

        it('returns 422 when the service throws InvalidIncidentError', async () => {
            vi.spyOn(ingestService, 'ingestDiagnosticEvents').mockRejectedValue(
                new ingestService.InvalidIncidentError('errorType: is required'),
            );

            const res = await eventsDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { events: [{ kind: 'playback_incident' }] } },
            } as never);

            expect(res.status).toBe(422);
        });

        it('returns 500 on an unexpected service error', async () => {
            vi.spyOn(ingestService, 'ingestDiagnosticEvents').mockRejectedValue(new Error('boom'));

            const res = await eventsDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { events: [{ kind: 'js_error' }] } },
            } as never);

            expect(res.status).toBe(500);
        });

        it('returns 503 when the database is unavailable', async () => {
            vi.spyOn(dbConn, 'getDb').mockReturnValue(null as never);

            const res = await eventsDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { events: [] } },
            } as never);

            expect(res.status).toBe(503);
        });
    });

    describe('resolve.ts PATCH', () => {
        it('returns 401 when unauthenticated', async () => {
            const res = await resolveDef.handlers.PATCH!(makeEvent(undefined), {
                ...CTX,
                input: { body: { attemptId: 'a1' } },
            } as never);
            expect(res.status).toBe(401);
        });

        it('returns 204 on success (including the no-op case)', async () => {
            const resolveSpy = vi
                .spyOn(incidentService, 'resolvePlaybackIncident')
                .mockResolvedValue();

            const res = await resolveDef.handlers.PATCH!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { attemptId: 'a1' } },
            } as never);

            expect(res.status).toBe(204);
            expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', {
                attemptId: 'a1',
            });
        });

        it('returns 500 on an unexpected service error', async () => {
            vi.spyOn(incidentService, 'resolvePlaybackIncident').mockRejectedValue(
                new Error('boom'),
            );

            const res = await resolveDef.handlers.PATCH!(makeEvent('user-1'), {
                ...CTX,
                input: { body: { attemptId: 'a1' } },
            } as never);

            expect(res.status).toBe(500);
        });
    });

    describe('bundles.ts POST', () => {
        const validBody = {
            eventId: '7f3a91c2-1111-4000-8000-000000000000',
            platform: 'ios',
            occurredAt: Date.now(),
            trigger: 'user',
            scope: 'account',
            contentGzipBase64: 'AAAA',
        };

        it('returns 401 when unauthenticated', async () => {
            const res = await bundlesDef.handlers.POST!(makeEvent(undefined), {
                ...CTX,
                input: { body: validBody },
            } as never);
            expect(res.status).toBe(401);
        });

        it('returns 202 with {diagnosticId, eventId, shortId} on success', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: true,
                diagnosticId: 42,
                eventId: validBody.eventId,
                shortId: '7F3A-91C2',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(202);
            const body = await res.json();
            expect(body).toEqual({
                diagnosticId: 42,
                eventId: validBody.eventId,
                shortId: '7F3A-91C2',
            });
        });

        it('returns 403 when log bundles are disabled', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: false,
                reason: 'disabled',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(403);
        });

        it('returns 413 when the bundle is too large', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: false,
                reason: 'too_large',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(413);
        });

        it('returns 503 when the decode semaphore is busy', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: false,
                reason: 'busy',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(503);
        });

        it('returns 429 when the byte budget is exceeded', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: false,
                reason: 'budget',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(429);
        });

        it('returns 422 for bad gzip', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockResolvedValue({
                ok: false,
                reason: 'bad_gzip',
            });

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(422);
        });

        it('returns 503 when the database is unavailable', async () => {
            vi.spyOn(dbConn, 'getDb').mockReturnValue(null as never);

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(503);
        });

        it('returns 500 on an unexpected service error', async () => {
            vi.spyOn(ingestService, 'ingestLogBundle').mockRejectedValue(new Error('boom'));

            const res = await bundlesDef.handlers.POST!(makeEvent('user-1'), {
                ...CTX,
                input: { body: validBody },
            } as never);

            expect(res.status).toBe(500);
        });
    });
});
