// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { version } from '$app/environment';
import { safeRandomUUID } from '$lib/utils/safe-uuid.js';
import type { PlaybackIncidentReportInput } from '$lib/schemas/playback.js';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';

const eventIds = new WeakMap<PlaybackIncidentReportInput, string>();
/** Keep the idempotency key when the same report is retried. */
export function playbackIncidentEvent(body: PlaybackIncidentReportInput): DiagnosticEventInput {
    let eventId = eventIds.get(body);
    if (!eventId) {
        eventId = safeRandomUUID();
        eventIds.set(body, eventId);
    }
    return {
        kind: 'playback_incident',
        platform: 'web',
        eventId,
        occurredAt: body.incidentAt,
        attemptId: body.attemptId,
        playSessionId: body.playSessionId || undefined,
        deviceId: body.deviceId ?? undefined,
        mediaId: body.mediaId ?? undefined,
        appVersion: version?.slice(0, 32) || undefined,
        payload: {
            triggerType: body.triggerType,
            errorType: body.errorType ?? undefined,
            stage: body.stage ?? undefined,
            httpStatus: body.httpStatus,
            serverDiagnosticCode: body.serverDiagnosticCode ?? undefined,
            reconnectCause: body.reconnectCause ?? undefined,
            message: body.message ?? undefined,
            timeline: body.timeline,
            clientInfo: body.clientInfo ?? undefined,
        },
    };
}
