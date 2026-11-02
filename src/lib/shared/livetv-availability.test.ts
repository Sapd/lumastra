// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    classifyLiveTvAvailability,
    isPromotedLiveTvChannel,
    playbackFailureCause,
    FAILURE_FRESH_MS,
} from './livetv-availability.js';
import type { AvailabilityEvidence } from './livetv-availability.js';
const now = Date.parse('2026-10-04T21:05:00Z');
const at = (minutes = 0): string => new Date(now - minutes * 60_000).toISOString();
const channels = [
    { id: 'musa', sourceId: 'a', isVisible: true },
    { id: 'grd', sourceId: 'a', isVisible: true },
    { id: 'other', sourceId: 'a', isVisible: true },
    { id: 'healthy', sourceId: 'b', isVisible: true },
];
function summary(
    extra: Partial<AvailabilityEvidence> = {},
): ReturnType<typeof classifyLiveTvAvailability> {
    return classifyLiveTvAvailability(
        { channels, feeds: [], failures: [], progress: [], ...extra },
        now,
    );
}
const feed = { sourceId: 'a', feed: 'channels' as const, state: 'failed' as const, at: at(20) };
const failures = [
    { channelId: 'musa', cause: 'upstream' as const, at: at(5) },
    { channelId: 'grd', cause: 'upstream' as const, at: at(57) },
];
describe('Live TV observed availability matrix', () => {
    it('healthy observations keep recommendations; absent evidence never claims verified health', () => {
        expect(summary().sources[0].playback).toBe('unknown');
        expect(summary({ progress: [{ channelId: 'musa', at: at() }] }).channels.musa).toBe(
            'healthy',
        );
        expect(summary().suppressedChannelIds).toEqual([]);
    });
    it('guide-only failure retains playable channels and does not declare a playback outage', () => {
        const result = summary({
            feeds: [{ ...feed, feed: 'guide' }],
            progress: [{ channelId: 'musa', at: at() }],
        });
        expect(result.sources[0].guideFeed.state).toBe('failed');
        expect(result.sources[0].playback).toBe('healthy');
        expect(isPromotedLiveTvChannel('musa', result)).toBe(true);
    });
    it('feed-only failure is advisory and never suppresses an entire source', () => {
        const result = summary({ feeds: [feed] });
        expect(result.sources[0].channelFeed.state).toBe('failed');
        expect(result.sources[0].playback).toBe('unknown');
        expect(result.suppressedChannelIds).toEqual([]);
    });
    it('production staggered upstream failures and failed feeds suppress the affected source, retaining healthy providers', () => {
        const result = summary({ feeds: [feed, { ...feed, feed: 'guide' }], failures });
        expect(result.sources[0].playback).toBe('upstream');
        expect(result.suppressedChannelIds).toEqual(['musa', 'grd', 'other']);
        expect(isPromotedLiveTvChannel('healthy', result)).toBe(true);
    });
    it('partial outage suppresses only the failed channel', () => {
        const result = summary({ feeds: [feed], failures: [failures[0]] });
        expect(result.sources[0].playback).toBe('partial');
        expect(result.suppressedChannelIds).toEqual(['musa']);
    });
    it('feed recovery clears the broad warning independently of guide and channel playback warnings', () => {
        const result = summary({
            feeds: [feed, { ...feed, state: 'completed', at: at() }, { ...feed, feed: 'guide' }],
            failures,
        });
        expect(result.sources[0].channelFeed.state).toBe('healthy');
        expect(result.sources[0].guideFeed.state).toBe('failed');
        expect(result.sources[0].playback).toBe('partial');
        expect(result.suppressedChannelIds).not.toContain('other');
    });
    it('genuine new video progress overrides a prior failure, while old segments and stale successes do not', () => {
        const result = summary({
            feeds: [feed],
            failures,
            progress: [{ channelId: 'musa', at: at() }],
        });
        expect(result.channels.musa).toBe('healthy');
        expect(result.suppressedChannelIds).not.toContain('musa');
        expect(
            summary({ failures, progress: [{ channelId: 'musa', at: at(6) }] }).channels.musa,
        ).toBe('upstream');
        expect(
            summary({
                failures: [{ ...failures[0], at: at() }],
                progress: [{ channelId: 'musa', at: new Date(now - 1000).toISOString() }],
            }).channels.musa,
        ).toBe('upstream');
    });
    it('stale and future evidence expire instead of leaving permanent badges', () => {
        expect(
            summary({
                feeds: [{ ...feed, at: at(25 * 60) }],
                failures: [
                    { ...failures[0], at: new Date(now - FAILURE_FRESH_MS - 1).toISOString() },
                ],
            }).sources[0].channelFeed.state,
        ).toBe('unknown');
        expect(
            summary({ failures: [{ ...failures[0], at: at(-1) }] }).suppressedChannelIds,
        ).toEqual([]);
    });
    it('network ingest failures are upstream; local encoder/spawn and rendition failures are distinct', () => {
        expect(playbackFailureCause('ingest', 'crashed', 'Connection refused')).toBe('upstream');
        expect(playbackFailureCause('ingest', 'spawn_failed', 'Connection refused')).toBe(
            'service',
        );
        expect(playbackFailureCause('egress', 'crashed', 'Connection refused')).toBe('service');
        expect(playbackFailureCause('ingest', 'crashed', 'Error opening input: invalid data')).toBe(
            'service',
        );
        expect(
            summary({ failures: [{ ...failures[0], cause: 'service' }] }).sources[0].playback,
        ).toBe('service');
        expect(summary({ serviceFailed: true }).sources[0].playback).toBe('service');
    });
    it('loading evidence failure is explicitly unknown and preserves usable browsing data', () => {
        const result = summary({ evidenceUnavailable: true });
        expect(result.evidenceUnavailable).toBe(true);
        expect(result.sources).toHaveLength(2);
        expect(result.suppressedChannelIds).toEqual([]);
    });
    it('hidden/disabled lineups cannot contribute an outage, and newly observed progress clears cached promotional exclusions', () => {
        const result = summary({
            channels: channels.map((c) => ({ ...c, isVisible: c.sourceId === 'b' })),
            feeds: [feed],
            failures,
        });
        expect(result.sources.map((s) => s.sourceId)).toEqual(['b']);
        const recovered = summary({
            feeds: [feed],
            failures,
            progress: [
                { channelId: 'musa', at: at() },
                { channelId: 'grd', at: at() },
            ],
        });
        expect(channels.filter((c) => isPromotedLiveTvChannel(c.id, recovered))).toEqual(channels);
    });
});
