// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LiveTvAvailability, SourceAvailability } from '$lib/schemas/livetv-availability.js';

export const FEED_FRESH_MS = 24 * 60 * 60_000;
export const FAILURE_FRESH_MS = 2 * 60 * 60_000;
export const PROGRESS_FRESH_MS = 45_000;
export interface FeedEvidence {
    sourceId: string;
    feed: 'channels' | 'guide';
    state: 'completed' | 'failed';
    at: string;
}
export interface PlaybackEvidence {
    channelId: string;
    at: string;
    cause: 'upstream' | 'service';
}
export interface ProgressEvidence {
    channelId: string;
    at: string;
}
export interface AvailabilityEvidence {
    channels: Array<{ id: string; sourceId?: string; isVisible: boolean }>;
    feeds: FeedEvidence[];
    failures: PlaybackEvidence[];
    progress: ProgressEvidence[];
    sourceIds?: string[];
    serviceFailed?: boolean;
    evidenceUnavailable?: boolean;
}
export function isFresh(at: string, now: number, ttl: number): boolean {
    const time = Date.parse(at);
    return Number.isFinite(time) && time <= now && now - time <= ttl;
}
/**
 * Only network-related ingest crashes are provider evidence. Spawn/encoder faults are local.
 * A typed `reason` (livetv-failure-reason.ts) decides when the event has one: our own encoder
 * failing is the service, every other reason is the channel or its provider. Older rows have
 * no reason and keep the stderr match.
 */
export function playbackFailureCause(
    source: string,
    outcome: string,
    error: string,
    reason?: string | null,
): 'upstream' | 'service' {
    if (reason) return reason === 'encoder_failed' ? 'service' : 'upstream';
    return source === 'ingest' &&
        outcome === 'crashed' &&
        /connection (refused|timed out|reset)|network is unreachable|no route to host|failed to resolve|server returned [45]\d\d|http error [45]\d\d|connection closed/i.test(
            error,
        )
        ? 'upstream'
        : 'service';
}
export function classifyLiveTvAvailability(
    evidence: AvailabilityEvidence,
    now = Date.now(),
): LiveTvAvailability {
    const visible = evidence.channels.filter((c) => c.isVisible);
    const channels: LiveTvAvailability['channels'] = {};
    const sources: SourceAvailability[] = [];
    const suppressed = new Set<string>();
    for (const sourceId of new Set([
        ...visible.flatMap((c) => (c.sourceId ? [c.sourceId] : [])),
        ...(evidence.sourceIds ?? []),
    ])) {
        const lineup = visible.filter((c) => c.sourceId === sourceId);
        const feed = (kind: FeedEvidence['feed']): SourceAvailability['channelFeed'] => {
            const latest = evidence.feeds
                .filter((f) => f.sourceId === sourceId && f.feed === kind)
                .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
            return latest && isFresh(latest.at, now, FEED_FRESH_MS)
                ? {
                      state: latest.state === 'completed' ? 'healthy' : 'failed',
                      observedAt: latest.at,
                  }
                : { state: 'unknown' };
        };
        const times: string[] = [];
        const upstream: string[] = [];
        const failed: string[] = [];
        for (const channel of lineup) {
            const failure = evidence.failures
                .filter((f) => f.channelId === channel.id && isFresh(f.at, now, FAILURE_FRESH_MS))
                .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
            const progress = evidence.progress
                .filter((p) => p.channelId === channel.id && isFresh(p.at, now, FAILURE_FRESH_MS))
                .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
            if (progress && (!failure || Date.parse(progress.at) > Date.parse(failure.at))) {
                channels[channel.id] = isFresh(progress.at, now, PROGRESS_FRESH_MS)
                    ? 'healthy'
                    : 'unknown';
                if (channels[channel.id] === 'healthy') times.push(progress.at);
            } else if (failure) {
                channels[channel.id] = failure.cause;
                failed.push(channel.id);
                times.push(failure.at);
                if (failure.cause === 'upstream') upstream.push(channel.id);
                suppressed.add(channel.id);
            } else channels[channel.id] = evidence.serviceFailed ? 'service' : 'unknown';
        }
        const channelFeed = feed('channels');
        const broad = channelFeed.state === 'failed' && upstream.length >= 2;
        if (broad || evidence.serviceFailed) {
            for (const channel of lineup)
                if (channels[channel.id] !== 'healthy') suppressed.add(channel.id);
        }
        const playback: SourceAvailability['playback'] = evidence.serviceFailed
            ? 'service'
            : broad
              ? 'upstream'
              : failed.length
                ? failed.some((id) => channels[id] === 'service') && !upstream.length
                    ? 'service'
                    : 'partial'
                : lineup.some((c) => channels[c.id] === 'healthy')
                  ? 'healthy'
                  : 'unknown';
        sources.push({
            sourceId,
            channelFeed,
            guideFeed: feed('guide'),
            playback,
            playbackObservedAt: times.sort((a, b) => Date.parse(b) - Date.parse(a))[0],
            failedChannelIds: failed,
        });
    }
    return {
        observedAt: new Date(now).toISOString(),
        evidenceUnavailable: evidence.evidenceUnavailable ?? false,
        sources,
        channels,
        suppressedChannelIds: [...suppressed],
    };
}
export function isPromotedLiveTvChannel(
    channelId: string,
    availability: LiveTvAvailability,
): boolean {
    return !availability.suppressedChannelIds.includes(channelId);
}
