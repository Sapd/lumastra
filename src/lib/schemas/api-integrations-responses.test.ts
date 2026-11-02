// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { SyncStatusSchema, SyncActivityItemSchema } from './api-integrations-responses.js';

describe('SyncActivityItemSchema', () => {
    it('accepts seriesTitle alongside an episode title', () => {
        const result = SyncActivityItemSchema.safeParse({
            direction: 'pull',
            outcome: 'success',
            terminal: false,
            title: 'Pilot',
            seriesTitle: 'Drifting Clouds',
            mediaType: 'episode',
            eventKind: 'watched',
            occurredAt: new Date().toISOString(),
        });

        expect(result.success).toBe(true);
        expect(result.data?.seriesTitle).toBe('Drifting Clouds');
    });

    it('omits seriesTitle for non-episode rows without failing validation', () => {
        const result = SyncActivityItemSchema.safeParse({
            direction: 'push',
            outcome: 'success',
            terminal: false,
            title: 'Some Movie',
            mediaType: 'movie',
            occurredAt: new Date().toISOString(),
        });

        expect(result.success).toBe(true);
        expect(result.data?.seriesTitle).toBeUndefined();
    });

    it('accepts seasonNumber/episodeNumber alongside seriesTitle for an episode row', () => {
        const result = SyncActivityItemSchema.safeParse({
            direction: 'pull',
            outcome: 'success',
            terminal: false,
            title: 'Never Ever Do This at Home!',
            seriesTitle: 'Some Anime',
            seasonNumber: 1,
            episodeNumber: 4,
            mediaType: 'episode',
            eventKind: 'watched',
            occurredAt: new Date().toISOString(),
        });

        expect(result.success).toBe(true);
        expect(result.data?.seasonNumber).toBe(1);
        expect(result.data?.episodeNumber).toBe(4);
    });

    it('omits seasonNumber/episodeNumber for non-episode rows without failing validation', () => {
        const result = SyncActivityItemSchema.safeParse({
            direction: 'push',
            outcome: 'success',
            terminal: false,
            title: 'Some Movie',
            mediaType: 'movie',
            occurredAt: new Date().toISOString(),
        });

        expect(result.success).toBe(true);
        expect(result.data?.seasonNumber).toBeUndefined();
        expect(result.data?.episodeNumber).toBeUndefined();
    });
});

describe('SyncStatusSchema', () => {
    it('defaults recentActivity to [] when omitted and accepts a nullable state', () => {
        const result = SyncStatusSchema.safeParse({
            state: null,
            processed: 0,
        });

        expect(result.success).toBe(true);
        // recentActivity is not sent by callers that have no history yet — the
        // schema must supply [] rather than leaving it undefined, since
        // consumers (e.g. SyncActivityList.svelte) iterate it directly.
        expect(result.data?.recentActivity).toEqual([]);
        expect(result.data?.state).toBeNull();
    });

    it('rejects an unknown state value', () => {
        const result = SyncStatusSchema.safeParse({
            state: 'bogus',
            processed: 0,
        });

        expect(result.success).toBe(false);
    });
});
