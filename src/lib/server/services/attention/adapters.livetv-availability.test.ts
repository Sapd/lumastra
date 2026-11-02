// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { reconcile } from './reconcile.js';
import type { AlertRow } from './types.js';
import { adaptLiveTvAvailability } from './adapters.js';
import { classifyLiveTvAvailability } from '$lib/shared/livetv-availability.js';
import type { LiveTvSourceSafeRow } from '$lib/server/database/queries/livetv-sources.queries.js';
const now = Date.parse('2026-10-04T21:05:00Z');
const source: LiveTvSourceSafeRow = {
    id: 's',
    name: 'Provider',
    source_type: 'm3u',
    max_streams: 2,
    refresh_cron: null,
    last_refresh_at: new Date(now),
    last_refresh_status: 'success',
    last_refresh_summary: { warnings: ['Parse warning'] },
    created_at: new Date(now),
    updated_at: new Date(now),
};
describe('admin Live TV shared incidents', () => {
    it('agrees with viewer state, prioritizes an actual outage, and folds parse warnings into one incident', () => {
        const summary = classifyLiveTvAvailability(
            {
                channels: [
                    { id: 'a', sourceId: 's', isVisible: true },
                    { id: 'b', sourceId: 's', isVisible: true },
                ],
                feeds: [
                    {
                        sourceId: 's',
                        feed: 'channels',
                        state: 'failed',
                        at: '2026-10-04T20:50:00Z',
                    },
                    { sourceId: 's', feed: 'guide', state: 'failed', at: '2026-10-04T20:40:00Z' },
                ],
                failures: [
                    { channelId: 'a', cause: 'upstream', at: '2026-10-04T21:00:00Z' },
                    { channelId: 'b', cause: 'upstream', at: '2026-10-04T20:08:00Z' },
                ],
                progress: [],
            },
            now,
        );
        const alerts = adaptLiveTvAvailability([source], summary);
        expect(summary.sources[0].playback).toBe('upstream');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].severity).toBe('critical');
        expect(alerts[0].detail).toContain('20:50:00');
        expect(alerts[0].detail).toContain('20:40:00');
        expect(alerts[0].detail).toContain('21:00:00');
        expect(alerts[0].detail).toContain('Parse warning');
    });
    it('retains parse warning information after outage recovery', () => {
        const summary = classifyLiveTvAvailability(
            { channels: [], feeds: [], failures: [], progress: [] },
            now,
        );
        const alerts = adaptLiveTvAvailability([source], summary);
        expect(alerts).toHaveLength(1);
        expect(alerts[0].severity).toBe('info');
    });
    it('reports a failed initial import with no channels and reopens materially expanded incidents', () => {
        const empty = classifyLiveTvAvailability(
            {
                channels: [],
                sourceIds: ['s'],
                feeds: [
                    {
                        sourceId: 's',
                        feed: 'channels',
                        state: 'failed',
                        at: new Date(now).toISOString(),
                    },
                ],
                failures: [],
                progress: [],
            },
            now,
        );
        expect(adaptLiveTvAvailability([source], empty)[0].severity).toBe('warning');
        const summary = (n: number) =>
            classifyLiveTvAvailability(
                {
                    channels: Array.from({ length: n }, (_, i) => ({
                        id: String(i),
                        sourceId: 's',
                        isVisible: true,
                    })),
                    feeds: [],
                    failures: Array.from({ length: n }, (_, i) => ({
                        channelId: String(i),
                        cause: 'upstream' as const,
                        at: new Date(now).toISOString(),
                    })),
                    progress: [],
                },
                now,
            );
        expect(adaptLiveTvAvailability([source], summary(20))[0].count).toBe(20);
        const original = adaptLiveTvAvailability([source], summary(2))[0];
        const prior: AlertRow = {
            ...original,
            domain: 'playback',
            detail: original.detail ?? null,
            source_ref: original.sourceRef ?? null,
            status: 'acked',
            first_seen: new Date(now).toISOString(),
            last_seen: new Date(now).toISOString(),
            acked_at: new Date(now).toISOString(),
            acked_by: 'operator',
            acked_fingerprint: original.fingerprint,
            count: 2,
            acked_count: 2,
            count_first: 2,
            count_prev: 2,
            snoozed_until: null,
            resolved_at: null,
        };
        // 2→3 stays inside the same count bucket, yet must reopen past the ack watermark.
        expect(
            reconcile(
                adaptLiveTvAvailability([source], summary(3)),
                [prior],
                new Date(now).toISOString(),
            ).upserts[0].status,
        ).toBe('active');
        expect(
            reconcile(
                adaptLiveTvAvailability([source], summary(1)),
                [prior],
                new Date(now).toISOString(),
            ).upserts[0].status,
        ).toBe('acked');

        expect(adaptLiveTvAvailability([source], summary(1))[0].fingerprint).not.toBe(
            adaptLiveTvAvailability([source], summary(20))[0].fingerprint,
        );
    });
});
