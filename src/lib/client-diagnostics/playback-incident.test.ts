// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
vi.mock('$app/environment', () => ({ version: '0.1.0' }));
import { playbackIncidentEvent } from './playback-incident.js';
import { diagnosticEventBatchSchema } from '$lib/schemas/client-diagnostics.js';
import { reportPlaybackIncident, resolvePlaybackIncident } from '$lib/api/playback.js';
const api = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiPost: api.post, apiPatch: api.patch }));
it('promotes envelope fields, removes nulls, and keeps an event id across delivery retries', async () => {
    const report = {
        attemptId: 'attempt',
        playSessionId: '',
        incidentAt: Date.now(),
        triggerType: 'terminal' as const,
        deviceId: null,
        mediaId: null,
        errorType: null,
        stage: null,
        clientInfo: null,
        timeline: [],
    };
    const event = playbackIncidentEvent(report);
    expect(diagnosticEventBatchSchema.safeParse({ events: [event] }).success).toBe(true);
    expect(playbackIncidentEvent(report).eventId).toBe(event.eventId);
    expect(playbackIncidentEvent({ ...report }).eventId).not.toBe(event.eventId);
    await reportPlaybackIncident(report);
    expect(api.post).toHaveBeenLastCalledWith('/api/diagnostics/events', expect.anything(), {
        events: [event],
    });
    await resolvePlaybackIncident({ attemptId: report.attemptId });
    expect(api.patch).toHaveBeenLastCalledWith(
        '/api/diagnostics/events/resolve',
        expect.anything(),
        { attemptId: 'attempt' },
    );
});
