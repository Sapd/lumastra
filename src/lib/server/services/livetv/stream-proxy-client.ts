// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stream Proxy HTTP Client
 *
 * Single module for all SvelteKit → stream proxy communication.
 * All methods include X-Proxy-Secret header for authentication.
 *
 * @module services/livetv/stream-proxy-client
 */

import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import type {
    JoinRequest,
    JoinResponse,
    ProxyErrorResponse,
    HeartbeatResponse,
    LeaveResponse,
    KillChannelResponse,
    LiveTvCompatVariant,
    ProxyStatus,
} from '../../../../shared/livetv-proxy-types.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
const logger = Logger.for('StreamProxyClient');

export interface StreamProxyClient {
    joinChannel(
        channelId: string,
        request: JoinRequest,
        signal?: AbortSignal,
    ): Promise<JoinResponse | ProxyErrorResponse>;
    leaveChannel(
        channelId: string,
        viewerId: string,
        signal?: AbortSignal,
        options?: { immediate?: boolean },
    ): Promise<LeaveResponse>;
    killChannel(channelId: string, signal?: AbortSignal): Promise<KillChannelResponse>;
    heartbeat(
        channelId: string,
        viewerId: string,
        signal?: AbortSignal,
    ): Promise<HeartbeatResponse>;
    getProxyStatus(signal?: AbortSignal): Promise<ProxyStatus>;
    proxyHlsPlaylist(channelId: string, signal?: AbortSignal): Promise<Response>;
    proxyHlsRungPlaylist(
        channelId: string,
        rungId: string,
        signal?: AbortSignal,
    ): Promise<Response>;
    proxyHlsRungSegment(
        channelId: string,
        rungId: string,
        segmentName: string,
        signal?: AbortSignal,
    ): Promise<Response>;
    /**
     * A compat variant's media playlist, init segment or media segment
     * (`playlist.m3u8`, `init.mp4`, `segment-N.ts|m4s`).
     */
    proxyHlsVariantFile(
        channelId: string,
        variant: LiveTvCompatVariant,
        fileName: string,
        signal?: AbortSignal,
    ): Promise<Response>;
    proxyHlsAdaptiveMaster(channelId: string, signal?: AbortSignal): Promise<Response>;
    proxyHlsAdaptivePlaylist(
        channelId: string,
        outputId: string,
        signal?: AbortSignal,
    ): Promise<Response>;
    proxyHlsAdaptiveSegment(
        channelId: string,
        outputId: string,
        segmentName: string,
        signal?: AbortSignal,
    ): Promise<Response>;
    proxyHlsSegment(
        channelId: string,
        segmentName: string,
        signal?: AbortSignal,
    ): Promise<Response>;
}

function getBaseUrl(): string {
    const url = config.STREAM_PROXY_URL;
    if (!url) {
        throw new Error(
            'STREAM_PROXY_URL is not configured. Set it to the stream proxy URL (e.g., http://lumastra-proxy:3000).',
        );
    }
    return url.replace(/\/$/, '');
}

function getHeaders(withJson: boolean = false): Record<string, string> {
    const headers: Record<string, string> = {
        'X-Proxy-Secret': config.STREAM_PROXY_SECRET,
    };
    if (withJson) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}

/**
 * Fetch against the stream proxy, bounded by a 45s WHOLE-EXCHANGE timeout
 * (headers AND body).
 *
 * `signal` — the inbound SvelteKit request's AbortSignal, when the caller has
 * one available. Combining it with the timeout means a client disconnect
 * (tab close, navigation away, HLS player abort) cancels the upstream call
 * immediately instead of riding out the full 45s — without it, join/leave/
 * heartbeat/playlist calls kept running server-side long after nobody was
 * listening for the response.
 *
 * C22 fix round 2: `fetchWithTimeout`'s own internal timer only bounds
 * time-to-headers — it is cleared (see its `finally`) the moment
 * `followRedirectsWithGuard` resolves a `Response`, leaving body streaming
 * unbounded by that timer. That is correct for the chat-SDK path (fix round
 * 1's whole point), but wrong here: `proxyHlsSegment`/`proxyHlsRungSegment`
 * bodies are piped straight through to the HLS client via
 * `new Response(proxyResponse.body, …)` in the `/j` Live TV routes, which
 * pass no `signal` of their own — so before this fix, switching to
 * `fetchWithTimeout` had silently made a stalled-mid-body upstream hang this
 * response forever (a regression from the previous manual
 * `AbortSignal.timeout(45_000)`, which bounded the WHOLE exchange). Compose
 * a second timeout signal here that outlives `fetchWithTimeout`'s own and
 * stays attached to the underlying connection for body reads too, restoring
 * the original whole-exchange guarantee.
 */
export async function proxyFetch(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
    // Exported ONLY so the redirect-guard test can shrink this without
    // waiting out a real 45s — every production caller relies on the
    // default. Do not thread a custom value through from a route handler.
    wholeExchangeTimeoutMs = 45_000,
): Promise<Response> {
    try {
        // C22 fix round 1: STREAM_PROXY_URL is admin-configurable and every
        // call carries X-Proxy-Secret (added by callers via `init.headers`)
        // — same class as the twelve sites the C22 finding migrated.
        // Routed through the same-origin-only redirect guard.
        const wholeExchangeTimeout = AbortSignal.timeout(wholeExchangeTimeoutMs);
        const combinedSignal = signal
            ? AbortSignal.any([signal, wholeExchangeTimeout])
            : wholeExchangeTimeout;
        return await fetchWithTimeout(
            url,
            { ...init, signal: combinedSignal },
            wholeExchangeTimeoutMs,
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Stream proxy request failed: ${message}`, {
            cause: error,
        });
    }
}

async function proxyFetchJson<T>(url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const response = await proxyFetch(url, init, signal);

    if (!response.ok && response.status < 500) {
        throw new Error(`Proxy ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    if (!response.ok && response.status >= 500) {
        let body: string;
        try {
            body = await response.text();
        } catch {
            body = '(unreadable)';
        }
        // Try to parse as JSON anyway — proxy may return structured 503 (stream_limit_reached)
        try {
            return JSON.parse(body) as T;
        } catch {
            throw new Error(`Stream proxy returned ${response.status}: ${body.slice(0, 200)}`);
        }
    }

    try {
        return (await response.json()) as T;
    } catch {
        throw new Error(`Stream proxy returned non-JSON response (status ${response.status})`);
    }
}

/**
 * Create a StreamProxyClient instance.
 * Uses a factory function for testability (fresh config reads per instance).
 */
export function createStreamProxyClient(): StreamProxyClient {
    return {
        async joinChannel(
            channelId: string,
            request: JoinRequest,
            signal?: AbortSignal,
        ): Promise<JoinResponse | ProxyErrorResponse> {
            const baseUrl = getBaseUrl();
            logger.info(`Joining channel ${channelId} for viewer ${request.viewerId}`);

            const result = await proxyFetchJson<JoinResponse | ProxyErrorResponse>(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/join`,
                {
                    method: 'POST',
                    headers: getHeaders(true),
                    body: JSON.stringify(request),
                },
                signal,
            );

            if ('error' in result) {
                logger.warn(`Proxy error for channel ${channelId}: ${result.error}`);
            } else {
                logger.info(`Joined channel ${channelId} successfully`);
            }

            return result;
        },

        async leaveChannel(
            channelId: string,
            viewerId: string,
            signal?: AbortSignal,
            options?: { immediate?: boolean },
        ): Promise<LeaveResponse> {
            const baseUrl = getBaseUrl();
            logger.info(`Leaving channel ${channelId} for viewer ${viewerId}`);

            return proxyFetchJson<LeaveResponse>(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/leave?viewerId=${encodeURIComponent(viewerId)}${options?.immediate ? '&immediate=true' : ''}`,
                {
                    method: 'DELETE',
                    headers: getHeaders(),
                },
                signal,
            );
        },

        async killChannel(channelId: string, signal?: AbortSignal): Promise<KillChannelResponse> {
            const baseUrl = getBaseUrl();
            logger.info(`Admin killing channel ${channelId}`);

            return proxyFetchJson<KillChannelResponse>(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/kill`,
                {
                    method: 'DELETE',
                    headers: getHeaders(),
                },
                signal,
            );
        },

        async heartbeat(
            channelId: string,
            viewerId: string,
            signal?: AbortSignal,
        ): Promise<HeartbeatResponse> {
            const baseUrl = getBaseUrl();

            return proxyFetchJson<HeartbeatResponse>(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/heartbeat?viewerId=${encodeURIComponent(viewerId)}`,
                {
                    method: 'POST',
                    headers: getHeaders(),
                },
                signal,
            );
        },

        async getProxyStatus(signal?: AbortSignal): Promise<ProxyStatus> {
            const baseUrl = getBaseUrl();

            return proxyFetchJson<ProxyStatus>(
                `${baseUrl}/status`,
                {
                    method: 'GET',
                    headers: getHeaders(),
                },
                signal,
            );
        },

        async proxyHlsPlaylist(channelId: string, signal?: AbortSignal): Promise<Response> {
            const baseUrl = getBaseUrl();

            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/master.m3u8`,
                {
                    method: 'GET',
                    headers: getHeaders(),
                },
                signal,
            );
        },

        async proxyHlsRungPlaylist(
            channelId: string,
            rungId: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/r/${encodePathSegment(rungId)}/playlist.m3u8`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsRungSegment(
            channelId: string,
            rungId: string,
            segmentName: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/r/${encodePathSegment(rungId)}/${encodePathSegment(segmentName)}`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsVariantFile(
            channelId: string,
            variant: LiveTvCompatVariant,
            fileName: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/v/${encodePathSegment(variant)}/${encodePathSegment(fileName)}`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsAdaptiveMaster(channelId: string, signal?: AbortSignal): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/a/master.m3u8`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsAdaptivePlaylist(
            channelId: string,
            outputId: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/a/${encodePathSegment(outputId)}/playlist.m3u8`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsAdaptiveSegment(
            channelId: string,
            outputId: string,
            segmentName: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();
            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/a/${encodePathSegment(outputId)}/${encodePathSegment(segmentName)}`,
                { method: 'GET', headers: getHeaders() },
                signal,
            );
        },

        async proxyHlsSegment(
            channelId: string,
            segmentName: string,
            signal?: AbortSignal,
        ): Promise<Response> {
            const baseUrl = getBaseUrl();

            return proxyFetch(
                `${baseUrl}/streams/${encodePathSegment(channelId)}/${encodePathSegment(segmentName)}`,
                {
                    method: 'GET',
                    headers: getHeaders(),
                },
                signal,
            );
        },
    };
}

/** Lazy singleton instance */
let instance: StreamProxyClient | null = null;

/**
 * Get the singleton StreamProxyClient instance.
 */
export function getStreamProxyClient(): StreamProxyClient {
    if (!instance) {
        instance = createStreamProxyClient();
    }
    return instance;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetStreamProxyClient(): void {
    instance = null;
}
