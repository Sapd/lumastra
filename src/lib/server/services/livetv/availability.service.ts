// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import {
    getLiveTvFeedEvidence,
    getLiveTvPlaybackEvidence,
} from '$lib/server/database/queries/livetv-availability.queries.js';
import { getStreamProxyClient } from './stream-proxy-client.js';
import {
    classifyLiveTvAvailability,
    playbackFailureCause,
    isFresh,
    FAILURE_FRESH_MS,
} from '$lib/shared/livetv-availability.js';
import type { AvailabilityEvidence } from '$lib/shared/livetv-availability.js';
import type { LiveTvAvailability } from '$lib/schemas/livetv-availability.js';
import type { LiveTvChannel } from '$lib/schemas/livetv.js';

let cached: { at: number; evidence: Omit<AvailabilityEvidence, 'channels'> } | undefined;
let pending: Promise<Omit<AvailabilityEvidence, 'channels'>> | undefined;
/**
 * A single failed /status probe is often a proxy restart or one slow reply.
 * Reporting it straight away emptied the homepage Live TV row and showed the
 * "playback service" banner for a whole cache window, so the proxy has to stay
 * unreachable for this long (across consecutive reads) before it counts.
 */
const SERVICE_FAILURE_GRACE_MS = 30_000;
let proxyFailingSince: number | undefined;
function proxyFailurePersisted(failed: boolean): boolean {
    if (!failed) {
        proxyFailingSince = undefined;
        return false;
    }
    proxyFailingSince ??= Date.now();
    return Date.now() - proxyFailingSince >= SERVICE_FAILURE_GRACE_MS;
}
/** One short-lived evidence read reused by every surface; never probe streams. */
async function readEvidence(): Promise<Omit<AvailabilityEvidence, 'channels'>> {
    const sql = getDb();
    if (!sql)
        return {
            ...(cached?.evidence ?? { feeds: [], failures: [], progress: [] }),
            evidenceUnavailable: true,
        };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            (async (): Promise<Omit<AvailabilityEvidence, 'channels'>> => {
                const [feeds, failures, proxy] = await Promise.allSettled([
                    getLiveTvFeedEvidence(sql),
                    getLiveTvPlaybackEvidence(sql),
                    config.STREAM_PROXY_URL
                        ? getStreamProxyClient().getProxyStatus(AbortSignal.timeout(2000))
                        : Promise.resolve(undefined),
                ]);
                return {
                    feeds:
                        feeds.status === 'fulfilled'
                            ? feeds.value.map((r) => ({
                                  sourceId: r.source_id,
                                  feed: r.feed,
                                  state: r.state,
                                  at: r.at.toISOString(),
                              }))
                            : (cached?.evidence.feeds ?? []),
                    failures:
                        failures.status === 'fulfilled'
                            ? failures.value.map((r) => ({
                                  channelId: r.channel_id,
                                  at: r.occurred_at.toISOString(),
                                  cause: playbackFailureCause(
                                      r.source,
                                      r.outcome,
                                      r.stderr_tail ?? '',
                                      r.reason,
                                  ),
                              }))
                            : (cached?.evidence.failures ?? []),
                    progress:
                        proxy.status === 'fulfilled'
                            ? (proxy.value?.channels ?? []).flatMap((c) =>
                                  c.lastSegmentAt
                                      ? [{ channelId: c.channelId, at: c.lastSegmentAt }]
                                      : [],
                              )
                            : (cached?.evidence.progress ?? []),
                    serviceFailed: proxyFailurePersisted(
                        Boolean(config.STREAM_PROXY_URL) &&
                            (proxy.status === 'rejected' ||
                                (proxy.value !== undefined && !proxy.value.ffmpegAvailable)),
                    ),
                    evidenceUnavailable:
                        feeds.status === 'rejected' || failures.status === 'rejected',
                };
            })(),
            new Promise<Omit<AvailabilityEvidence, 'channels'>>((resolve) => {
                timer = setTimeout(
                    () =>
                        resolve({
                            feeds: cached?.evidence.feeds ?? [],
                            failures: cached?.evidence.failures ?? [],
                            progress: cached?.evidence.progress ?? [],
                            serviceFailed: cached?.evidence.serviceFailed,
                            evidenceUnavailable: true,
                        }),
                    2500,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}
export async function getLiveTvAvailability(
    channels: LiveTvChannel[],
    sourceIds?: string[],
): Promise<LiveTvAvailability> {
    if (!cached || Date.now() - cached.at >= 15_000) {
        pending ??= readEvidence()
            .then((evidence) => {
                // Recovery is a watermark, even once its current-health claim expires.
                const progress = new Map<string, AvailabilityEvidence['progress'][number]>();
                for (const p of [...(cached?.evidence.progress ?? []), ...evidence.progress]) {
                    if (
                        isFresh(p.at, Date.now(), FAILURE_FRESH_MS) &&
                        Date.parse(p.at) > Date.parse(progress.get(p.channelId)?.at ?? '1970-01-01')
                    )
                        progress.set(p.channelId, p);
                }
                evidence.progress = [...progress.values()];
                cached = { at: Date.now(), evidence };
                return evidence;
            })
            .finally(() => {
                pending = undefined;
            });
        await pending;
    }
    return classifyLiveTvAvailability({
        channels,
        sourceIds,
        ...(cached?.evidence ?? {
            feeds: [],
            failures: [],
            progress: [],
            evidenceUnavailable: true,
        }),
    });
}
export function resetLiveTvAvailabilityCache(): void {
    cached = undefined;
    pending = undefined;
    proxyFailingSince = undefined;
}
