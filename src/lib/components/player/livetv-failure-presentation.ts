// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Copy for the terminal Live TV overlay.
 *
 * Several unrelated causes end a Live TV stream, and every one of them used to
 * render the priority-eviction wording ("stopped to allow a higher-priority
 * user to watch"). That claim is only true for an actual eviction by
 * LiveTvPriorityService (410 `viewer_kicked`). A viewer refused admission by
 * their OWN concurrent-stream limit (422 `stream_limit`) was told a
 * competing viewer took their slot — sending them looking for a conflict that
 * does not exist instead of stopping their other stream.
 */

import * as m from '$lib/paraglide/messages.js';
import type {
    LiveTvFailureCode,
    LiveTvFailureReason,
    LiveTvFeedTried,
} from '$lib/api/livetv-failure-problem.js';

export type LiveTvBlockCause =
    /** LiveTvPriorityService evicted this viewer for a higher-priority one. */
    | { kind: 'priority' }
    /** A running session was killed by the stream-limit reconciler. */
    | { kind: 'stream_limit_kill' }
    /** Admission refused: the viewer is already at their concurrent-stream limit. */
    | { kind: 'stream_limit_blocked' }
    /** The Live TV source itself has no free viewer slot (503 stream_limit). */
    | { kind: 'source_capacity'; limit: number }
    /** Any other policy refusal (IP restriction, play method, …). */
    | { kind: 'policy'; message: string }
    /** Session ended for us (admin kill, takeover, server-side stop). */
    | { kind: 'session_ended' };

export interface LiveTvBlockPresentation {
    title: string;
    message: string;
}

export function liveTvBlockPresentation(cause: LiveTvBlockCause): LiveTvBlockPresentation {
    switch (cause.kind) {
        case 'priority':
            return {
                title: m.livetv_stream_kicked_title(),
                message: m.livetv_stream_kicked_message(),
            };
        case 'stream_limit_kill':
            return {
                title: m.livetv_stream_kicked_title(),
                message: m.player_stream_limit_reached(),
            };
        case 'stream_limit_blocked':
            return {
                title: m.livetv_stream_blocked_title(),
                message: m.livetv_stream_limit_blocked_message(),
            };
        case 'source_capacity':
            return {
                title: m.livetv_stream_limit_title(),
                message:
                    cause.limit === 1
                        ? m.livetv_stream_limit_subtitle_one()
                        : m.livetv_stream_limit_subtitle({ limit: String(cause.limit) }),
            };
        case 'policy':
            return {
                title: m.livetv_stream_blocked_title(),
                message: cause.message,
            };
        case 'session_ended':
            return {
                title: m.livetv_stream_kicked_title(),
                message: m.livetv_stream_session_ended_message(),
            };
    }
}

/** Map a 422 policy-block kind from the play-session reporter to a cause. */
export function liveTvBlockCauseForPolicy(kind: string, message: string): LiveTvBlockCause {
    return kind === 'stream_limit' ? { kind: 'stream_limit_blocked' } : { kind: 'policy', message };
}

/** Map a server-side session kill reason to a cause. */
export function liveTvBlockCauseForKill(reason: string): LiveTvBlockCause {
    return reason === 'stream_limit' ? { kind: 'stream_limit_kill' } : { kind: 'session_ended' };
}

// ---------------------------------------------------------------------------
// Typed failure reasons (docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md)
// ---------------------------------------------------------------------------

export type LiveTvFailureViewCode = LiveTvFailureCode | 'unknown';
export type LiveTvFailureAction = 'retry' | 'another_channel' | 'back';

export interface LiveTvFailurePresentation {
    title: string;
    message: string;
    actions: LiveTvFailureAction[];
    /** Retry on its own (with a countdown) while the server says the failure is retryable. */
    autoRetry: boolean;
    /** Admins only: one line per feed that was tried. */
    feeds: { name: string; reason: string }[];
}

/** Failures where another channel is the useful next step (retrying the same one will not help). */
const ANOTHER_CHANNEL_CODES: ReadonlySet<LiveTvFailureViewCode> = new Set<LiveTvFailureViewCode>([
    'channel_offline',
    'no_video',
    'geo_blocked',
    'provider_auth_failed',
    'all_feeds_failed',
]);

const MESSAGES: Record<LiveTvFailureViewCode, () => string> = {
    channel_offline: () => m.livetv_failure_msg_channel_offline(),
    provider_auth_failed: () => m.livetv_failure_msg_provider_auth_failed(),
    provider_connection_limit: () => m.livetv_failure_msg_provider_connection_limit(),
    provider_unreachable: () => m.livetv_failure_msg_provider_unreachable(),
    geo_blocked: () => m.livetv_failure_msg_geo_blocked(),
    no_video: () => m.livetv_failure_msg_no_video(),
    encoder_failed: () => m.livetv_failure_msg_encoder_failed(),
    all_feeds_failed: () => m.livetv_failure_msg_all_feeds_failed(),
    upstream_stalled: () => m.livetv_failure_msg_upstream_stalled(),
    dependency_unavailable: () => m.livetv_failure_msg_dependency_unavailable(),
    unknown: () => m.livetv_failure_msg_unknown(),
};

const SIMPLE_MESSAGES: Record<LiveTvFailureViewCode, () => string> = {
    channel_offline: () => m.livetv_failure_msg_simple_channel_offline(),
    provider_auth_failed: () => m.livetv_failure_msg_simple_provider_auth_failed(),
    provider_connection_limit: () => m.livetv_failure_msg_simple_provider_connection_limit(),
    provider_unreachable: () => m.livetv_failure_msg_simple_provider_unreachable(),
    geo_blocked: () => m.livetv_failure_msg_simple_geo_blocked(),
    no_video: () => m.livetv_failure_msg_simple_no_video(),
    encoder_failed: () => m.livetv_failure_msg_simple_encoder_failed(),
    all_feeds_failed: () => m.livetv_failure_msg_simple_all_feeds_failed(),
    upstream_stalled: () => m.livetv_failure_msg_simple_upstream_stalled(),
    dependency_unavailable: () => m.livetv_failure_msg_simple_dependency_unavailable(),
    unknown: () => m.livetv_failure_msg_simple_unknown(),
};

const REASON_LABELS: Record<LiveTvFailureReason, () => string> = {
    channel_offline: () => m.livetv_failure_reason_channel_offline(),
    provider_auth_failed: () => m.livetv_failure_reason_provider_auth_failed(),
    provider_connection_limit: () => m.livetv_failure_reason_provider_connection_limit(),
    provider_unreachable: () => m.livetv_failure_reason_provider_unreachable(),
    geo_blocked: () => m.livetv_failure_reason_geo_blocked(),
    no_video: () => m.livetv_failure_reason_no_video(),
    encoder_failed: () => m.livetv_failure_reason_encoder_failed(),
    all_feeds_failed: () => m.livetv_failure_reason_all_feeds_failed(),
    upstream_stalled: () => m.livetv_failure_reason_upstream_stalled(),
};

export function liveTvFailureReasonLabel(reason: LiveTvFailureReason): string {
    return REASON_LABELS[reason]();
}

/**
 * Copy and actions for a typed Live TV failure.
 *
 * `retryable` (from the server) decides whether the player retries on its own and whether
 * "Try again" is offered; without it the code is treated as not retryable except for
 * `unknown`, which always offers a manual retry. Simple mode uses the plainest wording
 * (no provider, stream or encoder talk) and never shows feed details.
 */
export function liveTvFailurePresentation(
    code: LiveTvFailureViewCode,
    options: {
        simple: boolean;
        isAdmin: boolean;
        retryable?: boolean;
        feedsTried?: readonly LiveTvFeedTried[];
    },
): LiveTvFailurePresentation {
    const retryable = options.retryable ?? false;
    const actions: LiveTvFailureAction[] = [];
    if (retryable || code === 'unknown') actions.push('retry');
    if (ANOTHER_CHANNEL_CODES.has(code)) actions.push('another_channel');
    actions.push('back');
    const feeds =
        options.isAdmin && !options.simple
            ? (options.feedsTried ?? []).map((feed, index) => ({
                  name:
                      feed.feedName ?? m.livetv_failure_feed_unnamed({ number: String(index + 1) }),
                  reason: REASON_LABELS[feed.reason](),
              }))
            : [];
    return {
        title: options.simple ? m.livetv_failure_title_simple() : m.livetv_failure_title(),
        message: (options.simple ? SIMPLE_MESSAGES : MESSAGES)[code](),
        actions,
        autoRetry: retryable,
        feeds,
    };
}
