// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { WatchStatePullItem } from '@sapd/lumastra-plugin-sdk';
import {
    pendingRowFromPullItem,
    planPendingDrain,
    eventSourceForProvider,
    PENDING_MAX_AGE_MS,
    type PendingResolutionRow,
} from './watch-sync-pending.js';

const USER = '11111111-1111-1111-1111-111111111111';

function pullItem(overrides: Partial<WatchStatePullItem> = {}): WatchStatePullItem {
    return {
        providerId: 'jf-item-1',
        tmdbId: '603',
        imdbId: null,
        mediaType: 'movie',
        isWatched: true,
        resumePositionMs: 0,
        runtimeMs: 8_160_000,
        watchCount: 1,
        providerUsername: 'alice',
        lastWatchedAt: new Date('2026-01-01T00:00:00.000Z'),
        firstWatchedAt: new Date('2025-12-01T00:00:00.000Z'),
        ...overrides,
    };
}

function pendingRow(overrides: Partial<PendingResolutionRow> = {}): PendingResolutionRow {
    return {
        id: 1,
        user_id: USER,
        provider: 'jellyfin',
        media_type: 'movie',
        provider_id: 'jf-item-1',
        tmdb_id: '603',
        imdb_id: null,
        internal_media_id: null,
        series_tmdb_id: null,
        season_number: null,
        episode_number: null,
        is_watched: true,
        resume_position_ms: 0,
        runtime_ms: 8_160_000,
        watch_count: 1,
        last_watched_at: new Date('2026-01-01T00:00:00.000Z'),
        first_watched_at: new Date('2025-12-01T00:00:00.000Z'),
        attempts: 0,
        created_at: new Date('2026-01-02T00:00:00.000Z'),
        ...overrides,
    };
}

describe('pendingRowFromPullItem', () => {
    it('maps an unresolved movie pull item into an insert row keyed by provider id', () => {
        const row = pendingRowFromPullItem(pullItem(), USER, 'jellyfin');
        expect(row).toMatchObject({
            user_id: USER,
            provider: 'jellyfin',
            provider_id: 'jf-item-1',
            media_type: 'movie',
            tmdb_id: '603',
            is_watched: true,
            runtime_ms: 8_160_000,
            watch_count: 1,
        });
        // Episode-only fields are null for a movie.
        expect(row.series_tmdb_id).toBeNull();
        expect(row.season_number).toBeNull();
        expect(row.episode_number).toBeNull();
    });

    it('carries episode coordinates for an episode pull item', () => {
        const row = pendingRowFromPullItem(
            pullItem({
                mediaType: 'episode',
                tmdbId: null,
                seriesTmdbId: '1396',
                seasonNumber: 2,
                episodeNumber: 5,
                providerId: 'jf-ep-9',
            }),
            USER,
            'jellyfin',
        );
        expect(row).toMatchObject({
            media_type: 'episode',
            series_tmdb_id: '1396',
            season_number: 2,
            episode_number: 5,
            provider_id: 'jf-ep-9',
            tmdb_id: null,
        });
    });

    it('normalises missing optional numeric fields to null, not undefined', () => {
        const row = pendingRowFromPullItem(
            pullItem({ seasonNumber: undefined, episodeNumber: undefined }),
            USER,
            'jellyfin',
        );
        expect(row.season_number).toBeNull();
        expect(row.episode_number).toBeNull();
    });
});

describe('planPendingDrain', () => {
    const NOW = new Date('2026-01-10T00:00:00.000Z');

    it('imports + deletes rows that now resolve to an internal media id', () => {
        const rows = [pendingRow({ id: 7, provider_id: 'jf-item-1' })];
        const resolved = new Map([['jf-item-1', 'media-uuid-1']]);

        const plan = planPendingDrain(rows, resolved, NOW, PENDING_MAX_AGE_MS);

        expect(plan.toImport).toHaveLength(1);
        expect(plan.toImport[0]).toMatchObject({
            pendingId: 7,
            userId: USER,
            mediaId: 'media-uuid-1',
            isWatched: true,
        });
        expect(plan.toDeleteIds).toEqual([7]);
        expect(plan.toBumpIds).toEqual([]);
        expect(plan.toDropIds).toEqual([]);
    });

    it('carries the row media_type into the import plan (so the importer uses the right threshold)', () => {
        const rows = [pendingRow({ id: 7, provider_id: 'jf-ep', media_type: 'episode' })];
        const resolved = new Map([['jf-ep', 'media-ep-1']]);

        const plan = planPendingDrain(rows, resolved, NOW, PENDING_MAX_AGE_MS);

        expect(plan.toImport[0].mediaType).toBe('episode');
    });

    it('bumps still-unresolved rows that are within the max age', () => {
        const rows = [pendingRow({ id: 8, created_at: new Date('2026-01-09T00:00:00.000Z') })];
        const resolved = new Map<string, string>(); // nothing resolves

        const plan = planPendingDrain(rows, resolved, NOW, PENDING_MAX_AGE_MS);

        expect(plan.toImport).toEqual([]);
        expect(plan.toDeleteIds).toEqual([]);
        expect(plan.toBumpIds).toEqual([8]);
        expect(plan.toDropIds).toEqual([]);
    });

    it('drops still-unresolved rows older than the max age (bounds growth)', () => {
        const old = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 1);
        const rows = [pendingRow({ id: 9, created_at: old })];
        const resolved = new Map<string, string>();

        const plan = planPendingDrain(rows, resolved, NOW, PENDING_MAX_AGE_MS);

        expect(plan.toDropIds).toEqual([9]);
        expect(plan.toBumpIds).toEqual([]);
        expect(plan.toImport).toEqual([]);
    });

    it('maps provider names to event sources (and null for unknown)', () => {
        expect(eventSourceForProvider('jellyfin')).toBe('jellyfin-sync');
        expect(eventSourceForProvider('jellyfin-watch-sync')).toBe('jellyfin-sync');
        expect(eventSourceForProvider('Plex')).toBe('plex-sync');
        expect(eventSourceForProvider('mal')).toBe('mal-sync');
        expect(eventSourceForProvider('nope')).toBeNull();
    });

    /**
     * The engine THROWS on an unmapped provider (`watch-sync-engine.service.ts`,
     * the `validatedEventSource` narrowing), so a connector whose provider name
     * is missing here does not degrade — every pull cycle dies at runtime. This
     * is the failure Trakt hit before migration 16.130.0.
     */
    it('maps audiobookshelf to its own event source', () => {
        expect(eventSourceForProvider('audiobookshelf')).toBe('audiobookshelf-sync');
        expect(eventSourceForProvider('AudiobookShelf')).toBe('audiobookshelf-sync');
    });

    /**
     * Guards the substring matcher. `includes('mal')` is a substring test, so a
     * provider name that merely CONTAINS an earlier provider's token would be
     * silently mis-attributed to it — events would be written under the wrong
     * source and arbitrate against the wrong snapshot.
     */
    it('does not mis-attribute audiobookshelf to a substring-matched provider', () => {
        expect(eventSourceForProvider('audiobookshelf')).not.toBe('mal-sync');
        expect(eventSourceForProvider('audiobookshelf')).not.toBe('plex-sync');
        expect(eventSourceForProvider('audiobookshelf')).not.toBe('jellyfin-sync');
    });

    it('partitions a mixed batch correctly', () => {
        const old = new Date(NOW.getTime() - PENDING_MAX_AGE_MS - 1);
        const rows = [
            pendingRow({ id: 1, provider_id: 'a' }), // resolves
            pendingRow({ id: 2, provider_id: 'b' }), // unresolved, fresh
            pendingRow({ id: 3, provider_id: 'c', created_at: old }), // unresolved, aged out
        ];
        const resolved = new Map([['a', 'media-a']]);

        const plan = planPendingDrain(rows, resolved, NOW, PENDING_MAX_AGE_MS);

        expect(plan.toImport.map((i) => i.pendingId)).toEqual([1]);
        expect(plan.toDeleteIds).toEqual([1]);
        expect(plan.toBumpIds).toEqual([2]);
        expect(plan.toDropIds).toEqual([3]);
    });
});
