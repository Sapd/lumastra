// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User-facing text for the server's playback refusals.
 *
 * One place that turns each "you can't play this right now" answer into a
 * short, localized sentence saying what happened and what the user can do.
 *
 * Pure functions: no stores, no DOM — so the mapping is unit-testable and the
 * reporter / playback manager stay thin.
 */

import * as m from '$lib/paraglide/messages.js';
import { isRecord, toNumber } from '$lib/utils/data-extraction.js';
import type { StreamDiagnosticCode } from '$lib/utils/playback-diagnostics.js';

/** VOD refusals carry a typed details object next to the stable problem code. */
export function parseRefusalDetails(details: unknown): Record<string, unknown> | undefined {
    return isRecord(details) && !Array.isArray(details) ? details : undefined;
}

/** Message for a 422 policy refusal from `POST /play-sessions`, by `kind`. */
export function describePolicyRefusal(kind: string, details: unknown): string {
    const d = parseRefusalDetails(details);
    switch (kind) {
        case 'stream_limit': {
            const active = d ? toNumber(d.active) : undefined;
            const limit = d ? toNumber(d.limit) : undefined;
            return active !== undefined && limit !== undefined
                ? m.playback_refusal_stream_limit({ active, limit })
                : m.playback_refusal_stream_limit_generic();
        }
        case 'transcode_not_allowed':
            return m.playback_refusal_transcode_not_allowed();
        case 'ip_restricted': {
            const seconds = d ? toNumber(d.graceRemainingSeconds) : undefined;
            return seconds !== undefined && seconds > 0
                ? m.playback_refusal_ip_restriction({
                      minutes: Math.max(1, Math.ceil(seconds / 60)),
                  })
                : m.playback_refusal_ip_restriction_generic();
        }
        case 'source_incompatible':
            return m.playback_refusal_source_incompatible();
        case 'plugin_denied': {
            // The plugin's `reason` is its own explanation, meant for the user.
            const reason = d && typeof d.reason === 'string' ? d.reason.trim() : '';
            return reason
                ? m.playback_refusal_blocked_reason({ reason })
                : m.playback_refusal_not_allowed();
        }
        default:
            // An unknown future kind still blocks playback — say so plainly,
            // never echo the raw identifier.
            return m.playback_refusal_not_allowed();
    }
}

/**
 * Message for a terminal HTTP status on the HLS manifest fetch. hls.js does not
 * hand over the body, so the status plus the `X-Lumastra-Diagnostic-Code`
 * header (already parsed by the caller) is all there is.
 *
 * 429 = the per-user stream count or the per-user transcode-job cap; both mean
 * "too many streams at once" to the user.
 *
 * 403 is ambiguous: plain 403 is "not authorized", but with the
 * `playback-method-not-allowed` code it is the stream policy refusing the play
 * method (a transcode), which the user can only fix through the admin.
 */
export function describeManifestRefusal(
    status: number | undefined,
    diagnosticCode?: StreamDiagnosticCode,
): string {
    if (diagnosticCode === 'playback-method-not-allowed') {
        return m.playback_refusal_transcode_not_allowed();
    }
    switch (status) {
        case 404:
            return m.playback_refusal_file_missing();
        case 429:
            return m.playback_refusal_stream_limit_generic();
        case 401:
        case 403:
            return m.playback_refusal_not_authorized();
        default:
            return m.playback_refusal_unavailable();
    }
}

/**
 * Message for a failed `POST /media/:id/playability`. 404 also covers library-group
 * and parental-rating denials (access-denied is a 404 by design), so it never
 * hints at a reason. 403 is a plugin veto whose `error` is the plugin's reason.
 */
export function describeInfoRefusal(status: number | undefined, error: string | undefined): string {
    if (status === 404) return m.playback_refusal_not_available();
    if (status === 403) {
        const reason = error?.trim();
        return reason
            ? m.playback_refusal_blocked_reason({ reason })
            : m.playback_refusal_not_allowed();
    }
    return m.playback_refusal_unavailable();
}
