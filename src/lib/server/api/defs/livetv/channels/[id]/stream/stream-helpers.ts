// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared helpers for the LiveTV stream endpoints.
 *
 * Extracted to avoid duplicating the join-with-eviction pattern and the
 * stream-limit response builder across `index.ts` and `master.m3u8.ts`.
 * Both files were previously inline-implementing the same logic with
 * divergent error handling for the non-typed-throw case (500 vs 502).
 */

import { problem, liveTvFailureProblem } from '$lib/server/api/problem.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getLiveTvProvider } from '$lib/server/services/livetv/index.js';
import { getLiveTvPriorityService } from '$lib/server/services/livetv/livetv-priority.service.js';
import { getLiveTvSessionService } from '$lib/server/services/livetv/livetv-session.service.js';
import { getStreamProxyClient } from '$lib/server/services/livetv/stream-proxy-client.js';
import {
    CapUnavailableError,
    LiveTvFailureError,
    StreamLimitError,
    StreamFailureError,
} from '$lib/server/services/livetv/standalone-livetv-provider.js';
import {
    failureFacts,
    reasonForLegacyProxyError,
} from '$lib/server/services/livetv/livetv-failure-mapping.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { isLiveTvFailureReason } from '../../../../../../../../shared/livetv-failure-reason.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import type {
    LiveTvJoinCompat,
    LiveTvJoinOptions,
} from '$lib/server/services/livetv/livetv-provider.js';
import { canStreamLiveTvChannel } from '$lib/server/services/livetv/channel-access.js';
import type { AdminDecisionLocals } from '$lib/server/auth/locals-admin.js';
import type {
    CapReason,
    JoinAdaptiveRequest,
    JoinCapRequest,
} from '../../../../../../../../shared/livetv-proxy-types.js';

const logger = Logger.for('LiveTV:Stream');

/**
 * Build a stream-limit 503 problem+json response.
 * Uses the 'stream_limit' problem code: this is a capacity
 * constraint, not a per-client rate violation.  503+Retry-After tells HLS
 * players / tvOS to back off and retry rather than treating it as a client
 * error (429 would trigger aggressive per-client backoff instead).
 * retryAfter is set to 30 s as a sensible back-off hint.
 */
export function streamLimitResponse(err: StreamLimitError): Response {
    return problem('stream_limit', {
        error: 'Stream limit reached — no viewer slot available',
        reason: 'stream_limit',
        retryAfter: 30,
        failure: { retryable: true },
        details: JSON.stringify({
            limit: err.limit,
            active: err.activeChannels,
            showActiveStreams: config.LIVETV_SHOW_ACTIVE_STREAMS,
        }),
    });
}

/**
 * A failed join as the typed problem+json. A taxonomy failure keeps its reason as `code`;
 * a proxy that cannot be reached is `dependency_unavailable`; the legacy flat proxy errors
 * are mapped onto the taxonomy; anything else stays a generic 502.
 * `feedsTried` (feed ids and names) is for administrators only.
 */
export function streamFailureResponse(err: StreamFailureError, isAdmin: boolean): Response {
    if (err instanceof LiveTvFailureError) {
        return liveTvFailureProblem({
            reason: err.reason,
            retryable: err.retryable,
            retryAfterMs: err.retryAfterMs,
            feedsTried: err.feedsTried,
            isAdmin,
        });
    }
    if (err.errorCode === 'proxy_unreachable') {
        return problem('dependency_unavailable', {
            error: 'Stream proxy is unreachable',
            failure: { retryable: true },
            retryAfter: 5,
        });
    }
    // The proxy lost its state for the channel (or has no playlist yet): not a verdict on the
    // feed, so a plain retryable dependency answer rather than a non-retryable "offline".
    if (err.errorCode === 'channel_not_found' || err.errorCode === 'no_segments') {
        return problem('dependency_unavailable', {
            error: 'Live TV channel is not available right now',
            failure: { retryable: true },
            retryAfter: 5,
        });
    }
    const reason = reasonForLegacyProxyError(err.errorCode);
    if (reason) {
        const facts = failureFacts(reason, {}, []);
        return liveTvFailureProblem({ ...facts, isAdmin });
    }
    return ApiProblem.badGateway('Stream unavailable');
}

/**
 * A non-ok answer of the proxy to an HLS request. 410 `channel_failed` (the channel went
 * terminal) becomes a typed 410 problem with the failure `code`; players that only fetch media
 * read it. Never `feedsTried`, never a URL: this reaches every viewer. Anything else is a 502.
 */
export async function proxyErrorResponse(response: Response): Promise<Response> {
    if (response.status === 410) {
        try {
            const body = (await response.json()) as {
                error?: unknown;
                reason?: unknown;
                retryable?: unknown;
                retryAfterMs?: unknown;
            };
            if (body.error === 'channel_failed' && isLiveTvFailureReason(body.reason)) {
                const facts = failureFacts(
                    body.reason,
                    {
                        retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
                        retryAfterMs:
                            typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
                    },
                    [],
                );
                return liveTvFailureProblem({
                    reason: facts.reason,
                    retryable: facts.retryable,
                    retryAfterMs: facts.retryAfterMs,
                    isAdmin: false,
                    status: 410,
                });
            }
        } catch {
            // Not JSON: fall through to the generic answer.
        }
    }
    return ApiProblem.badGateway(`Proxy returned ${response.status}`);
}

export interface StreamJoinResult {
    streamUrl: string;
    sourceId?: string;
    requiresProxy: boolean;
    maxStreams?: number;
    rungId: string | null;
    requestedMaxBitrateBps: number | null;
    appliedMaxBitrateBps: number | null;
    appliedMaxHeight: number | null;
    reason: CapReason | null;
    variant?: 'fmp4' | 'h264';
    adaptive?: {
        rungs: Array<{ id: string; height: number; maxBitrateBps: number; codec: 'h264' }>;
        includesOriginal: boolean;
    };
}

export function capUnavailableResponse(err: CapUnavailableError): Response {
    return problem('cap_unavailable', {
        error: 'Requested Live TV bitrate cap could not be honored',
        retryAfter: 10,
        details: err.refusal,
        reason: err.refusal,
    });
}

/**
 * Frees the slot this viewer's own previous channel holds on the full source, so a channel
 * switch on a provider with few slots does not run into the viewer's own old stream. The new
 * join reaches the proxy before the client's leave of the old channel (or instead of it: a
 * beacon can be lost), and a viewer is never another viewer's eviction victim, so without this
 * a one-slot provider refused every switch.
 *
 * Only when the proxy's refusal shows the old channel held by exactly one viewer (this one): a
 * channel someone else also watches keeps its slot, so leaving it would end the viewer's stream
 * and free nothing. Returns the channel the viewer left, or null.
 */
async function releaseOwnPreviousChannel(
    viewerId: string,
    channelId: string,
    err: StreamLimitError & { sourceId: string },
    logContext: string,
): Promise<string | null> {
    const sessions = getLiveTvSessionService();
    const own = await sessions.getSession(viewerId).catch(() => null);
    if (!own || own.channelId === channelId || own.sourceId !== err.sourceId) return null;
    const held = err.activeChannels.find((c) => c.channelId === own.channelId);
    if (held?.viewers !== 1) return null;
    try {
        const left = await getStreamProxyClient().leaveChannel(own.channelId, viewerId);
        if (!left?.success) return null;
    } catch (leaveErr) {
        logger.warn(`[${logContext}] Could not release the viewer's previous channel`, {
            channelId,
            previousChannelId: own.channelId,
            error: leaveErr instanceof Error ? leaveErr.message : String(leaveErr),
        });
        return null;
    }
    await sessions.removeSessionIfChannel(viewerId, err.sourceId, own.channelId).catch(() => false);
    logger.info(`[${logContext}] Released the viewer's previous channel for a switch`, {
        channelId,
        previousChannelId: own.channelId,
        sourceId: err.sourceId,
    });
    return own.channelId;
}

/**
 * Attempt to join the channel stream, with optional high-priority eviction.
 *
 * Every stream join goes through here, so the channel access gate lives here
 * too (canStreamLiveTvChannel): a viewer gets 404 for a channel the lineup
 * does not offer them, before any slot is taken or anyone evicted.
 *
 * Returns the stream join result on success.
 * Returns a Response (error) when the join fails in a way that the caller
 * should surface directly to the client.
 *
 * Error handling is consistent across both callers:
 *   StreamLimitError  → 503 stream_limit (or eviction attempt for high-priority)
 *   StreamFailureError → typed failure problem (see streamFailureResponse)
 *   unknown           → 502 bad_gateway  (not 500 — this is an upstream failure)
 */
export async function joinWithEviction(
    locals: AdminDecisionLocals,
    channelId: string,
    viewerId: string,
    priority: 'high' | 'low',
    logContext: string,
    cap?: JoinCapRequest,
    adaptive?: JoinAdaptiveRequest,
    compat?: LiveTvJoinCompat,
    options?: LiveTvJoinOptions,
): Promise<StreamJoinResult | Response> {
    if (!(await canStreamLiveTvChannel(locals, channelId))) {
        return ApiProblem.notFound(`Channel ${channelId} not found`);
    }
    const provider = await getLiveTvProvider();
    // `compat` / `options` only when given, so a join without them is the exact call it always was.
    // The post-eviction retry never passes `options`: it must answer at once, not wait again.
    const joinOnce = (joinOptions?: LiveTvJoinOptions) =>
        joinOptions
            ? provider.getStreamInfo(channelId, viewerId, cap, adaptive, compat, joinOptions)
            : compat
              ? provider.getStreamInfo(channelId, viewerId, cap, adaptive, compat)
              : provider.getStreamInfo(channelId, viewerId, cap, adaptive);

    let streamInfo: StreamJoinResult;
    try {
        streamInfo = await joinOnce(options);
    } catch (firstErr) {
        let err = firstErr;
        // A switch: the slot may be the viewer's own previous channel. Free it and join again,
        // as the first join (with its options), before anyone else is considered for eviction.
        // If that join fails the old stream stays ended: the client is leaving it anyway.
        const previousChannelId =
            err instanceof StreamLimitError && err.sourceId
                ? await releaseOwnPreviousChannel(
                      viewerId,
                      channelId,
                      err as StreamLimitError & { sourceId: string },
                      logContext,
                  )
                : null;
        if (previousChannelId) {
            try {
                const switched = await joinOnce(options);
                // POST /playback-sessions supersedes it on its own; the stream routes do not.
                await getLiveTvSessionService()
                    .endViewerPlaybackSession(viewerId, previousChannelId, 'superseded')
                    .catch(() => {});
                return switched;
            } catch (switchErr) {
                err = switchErr;
            }
        }
        if (err instanceof StreamLimitError) {
            if (priority === 'high') {
                // Eviction counts the source's slots, so it needs the source. A channel id
                // stands in for nothing: it would look at an empty set and call the slot free.
                if (!err.sourceId) {
                    logger.warn(`[${logContext}] Stream limit without a source id: no eviction`, {
                        channelId,
                    });
                    return streamLimitResponse(err);
                }
                const priorityService = getLiveTvPriorityService();
                const enforcement = await priorityService.checkAndEnforcePriority(
                    viewerId,
                    priority,
                    channelId,
                    err.sourceId,
                    err.limit,
                );
                if (!enforcement.allowed) {
                    return streamLimitResponse(err);
                }
                // Slot freed — retry once
                try {
                    streamInfo = await joinOnce();
                } catch (retryErr) {
                    if (retryErr instanceof StreamLimitError) {
                        return streamLimitResponse(retryErr);
                    }
                    if (retryErr instanceof StreamFailureError) {
                        return streamFailureResponse(retryErr, localsIsAdmin(locals));
                    }
                    if (retryErr instanceof CapUnavailableError) {
                        return capUnavailableResponse(retryErr);
                    }
                    logger.error(
                        `[${logContext}] Failed to join stream after eviction`,
                        retryErr instanceof Error ? retryErr : new Error(String(retryErr)),
                        { channelId },
                    );
                    return ApiProblem.badGateway('Could not start or join stream');
                }
                // The newcomer holds the slot: only now are the evicted viewers locked out.
                if (enforcement.evicted?.length) {
                    await priorityService.confirmEviction(enforcement.evicted);
                }
            } else {
                return streamLimitResponse(err);
            }
        } else if (err instanceof CapUnavailableError) {
            return capUnavailableResponse(err);
        } else if (err instanceof StreamFailureError) {
            return streamFailureResponse(err, localsIsAdmin(locals));
        } else {
            logger.error(
                `[${logContext}] Failed to get stream info`,
                err instanceof Error ? err : new Error(String(err)),
                { channelId },
            );
            // Unknown upstream failure — 502, not 500: this is not a server bug,
            // it is an unexpected response from the upstream stream provider.
            return ApiProblem.badGateway('Stream unavailable');
        }
    }

    return streamInfo;
}
