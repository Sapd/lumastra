// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { recordPlaybackIncident, resolvePlaybackIncident } from './playback-incident.service.js';
import * as queries from '$lib/server/database/queries/playback-incident-events.queries.js';

describe('recordPlaybackIncident', () => {
    it('nulls an unrecognized serverDiagnosticCode rather than storing it verbatim', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            serverDiagnosticCode: 'totally-made-up-code',
            timeline: [],
        });

        expect(insertSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ serverDiagnosticCode: null }),
        );
        insertSpy.mockRestore();
    });

    it('preserves a recognized serverDiagnosticCode', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            serverDiagnosticCode: 'source-unavailable',
            timeline: [],
        });

        expect(insertSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ serverDiagnosticCode: 'source-unavailable' }),
        );
        insertSpy.mockRestore();
    });

    it('truncates an oversized timeline to the tail instead of rejecting', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        const timeline = Array.from({ length: 150 }, (_, i) => ({ t: i, kind: 'seek' }));
        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline,
        });

        const call = insertSpy.mock.calls[0][1];
        expect(call.timeline.length).toBeLessThanOrEqual(120);
        // Kept the TAIL — most recent events, not the earliest.
        expect((call.timeline.at(-1) as { t: number }).t).toBe(149);
        insertSpy.mockRestore();
    });

    it('truncates by serialized SIZE even when the entry count is well under the cap', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        // 10 entries — nowhere near the 120-entry cap — but ~8KiB each, so the
        // array serializes to ~80KiB. Entry-count truncation alone would let
        // the whole thing through; only the byte bound catches it.
        const timeline = Array.from({ length: 10 }, (_, i) => ({
            t: i,
            kind: 'seek',
            detail: 'x'.repeat(8 * 1024),
        }));
        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline,
        });

        const call = insertSpy.mock.calls[0][1];
        expect(call.timeline.length).toBeLessThan(10);
        expect(JSON.stringify(call.timeline).length).toBeLessThanOrEqual(32 * 1024);
        // Kept the TAIL — the events closest to the incident, same policy as
        // the entry-count truncation.
        expect((call.timeline.at(-1) as { t: number }).t).toBe(9);
        insertSpy.mockRestore();
    });

    it('leaves a normally-sized timeline untouched by the byte bound', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        const timeline = Array.from({ length: 20 }, (_, i) => ({ t: i, kind: 'seek' }));
        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline,
        });

        expect(insertSpy.mock.calls[0][1].timeline).toHaveLength(20);
        insertSpy.mockRestore();
    });

    it('redacts a credential-shaped key inside a timeline entry before insert', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline: [{ t: 0, kind: 'seek', url: 'https://x/y?token=SECRETVALUE' }],
        });

        const call = insertSpy.mock.calls[0][1];
        const entry = call.timeline[0] as { url: string };
        expect(entry.url).not.toContain('SECRETVALUE');
        insertSpy.mockRestore();
    });

    it('redacts a credential embedded in a NESTED timeline entry value, not just top-level', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline: [
                {
                    t: 0,
                    kind: 'seek',
                    request: { headers: { authorization: 'Bearer SECRETVALUE' } },
                    urls: ['https://x/y?token=OTHERSECRET'],
                },
            ],
        });

        const call = insertSpy.mock.calls[0][1];
        const serialized = JSON.stringify(call.timeline);
        expect(serialized).not.toContain('SECRETVALUE');
        expect(serialized).not.toContain('OTHERSECRET');
        insertSpy.mockRestore();
    });

    it('redacts a credential embedded in a clientInfo value (not just a credential-shaped key)', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            timeline: [],
            clientInfo: { manifestUrl: 'https://x/y?token=CLIENTSECRET' },
        });

        const call = insertSpy.mock.calls[0][1];
        expect(JSON.stringify(call.clientInfo)).not.toContain('CLIENTSECRET');
        insertSpy.mockRestore();
    });

    it('runs the full deepRedact pass over message, timeline and clientInfo (emails, Authorization, home paths)', async () => {
        const insertSpy = vi
            .spyOn(queries, 'insertPlaybackIncidentEvent')
            .mockResolvedValue({ id: 1, inserted: true });

        await recordPlaybackIncident({} as never, 'user-1', {
            attemptId: 'a1',
            playSessionId: 's1',
            incidentAt: Date.now(),
            triggerType: 'error',
            message: 'failed for jo@example.com reading /Users/alice/Movies/x.mkv',
            timeline: [
                { t: 0, kind: 'log', text: 'Authorization: Bearer TLTOKEN mail bo@example.org' },
            ],
            clientInfo: { note: 'contact ci@example.net', path: '/home/carol/app' },
        });

        const call = insertSpy.mock.calls[0][1];
        const serialized = JSON.stringify([call.message, call.timeline, call.clientInfo]);
        for (const leaked of [
            'jo@example.com',
            'alice',
            'TLTOKEN',
            'bo@example.org',
            'ci@example.net',
            'carol',
        ]) {
            expect(serialized).not.toContain(leaked);
        }
        insertSpy.mockRestore();
    });
});

describe('resolvePlaybackIncident', () => {
    it('is a no-op when no unresolved row exists for the attempt', async () => {
        const resolveSpy = vi
            .spyOn(queries, 'resolveUnresolvedIncidentsByAttempt')
            .mockResolvedValue(0);

        await expect(
            resolvePlaybackIncident({} as never, 'user-1', { attemptId: 'a1' }),
        ).resolves.toBeUndefined();
        expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), 'user-1', 'a1');
        resolveSpy.mockRestore();
    });

    it('resolves every unresolved row for the attempt via a single call', async () => {
        const resolveSpy = vi
            .spyOn(queries, 'resolveUnresolvedIncidentsByAttempt')
            .mockResolvedValue(3);

        await resolvePlaybackIncident({} as never, 'user-1', { attemptId: 'a1' });
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        resolveSpy.mockRestore();
    });
});
