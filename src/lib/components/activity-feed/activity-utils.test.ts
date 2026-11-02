// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    type ActivityItem,
    formatDayHeading,
    getActivityVerb,
    getProgress,
    getSubtitle,
    groupByDay,
    playMethodBadge,
} from './activity-utils';

function item(overrides: Partial<ActivityItem>): ActivityItem {
    return {
        id: 1,
        author: { userId: 'u1', displayName: 'testuser', images: { primary: { href: '/avatar', revision: '0', source: 'self' } } },
        activityType: 'abandoned',
        mediaId: null,
        mediaType: 'movie',
        ratingValue: null,
        externalIds: {},
        title: 'Nosferatu',
        year: null,
        seriesName: null,
        seasonNumber: null,
        episodeNumber: null,
        completionPercentage: null,
        watchTimeSeconds: null,
        sourceService: null,
        metadata: null,
        bitrate: null,
        deviceId: null,
        deviceName: null,
        userAgent: null,
        clientName: null,
        clientVersion: null,
        ipAddress: null,
        playMethod: null,
        transcodeMode: null,
        resolutionWidth: null,
        resolution: null,
        videoCodec: null,
        audioCodec: null,
        container: null,
        stopReason: null,
        sourcePlaySessionId: null,
        sourceSessionId: null,
        planMode: null,
        planReasons: null,
        subtitleMethod: null,
        transcodeCodec: null,
        deliveryPath: null,
        totalDurationSeconds: null,
        currentPositionSeconds: null,
        currentProgressPercentage: null,
        isPaused: false,
        isActive: false,
        lastUpdateTime: null,
        activityTime: '2026-09-20T12:00:00.000Z',
        createdAt: '2026-09-20T12:00:00.000Z',
        ...overrides,
    };
}

describe('groupByDay', () => {
    it('keeps feed order and starts a new group at each local day change', () => {
        const at = (d: number, h: number): string => new Date(2026, 8, d, h).toISOString();
        const groups = groupByDay([
            item({ id: 1, activityTime: at(20, 22) }),
            item({ id: 2, activityTime: at(20, 1) }),
            item({ id: 3, activityTime: at(19, 23) }),
        ]);
        expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([[1, 2], [3]]);
    });
});

describe('formatDayHeading', () => {
    const now = new Date(2026, 8, 27, 15);
    it('names today and yesterday', () => {
        expect(formatDayHeading(new Date(2026, 8, 27, 0, 5).toISOString(), now)).toBe('Today');
        expect(formatDayHeading(new Date(2026, 8, 26, 23).toISOString(), now)).toBe('Yesterday');
    });
    it('omits the year only within the current year', () => {
        expect(formatDayHeading(new Date(2026, 8, 20).toISOString(), now)).not.toMatch(/2026/);
        expect(formatDayHeading(new Date(2025, 8, 20).toISOString(), now)).toMatch(/2025/);
    });
});

describe('row labels', () => {
    it('formats the episode subtitle, else media type and year', () => {
        expect(
            getSubtitle(item({ seriesName: 'The Vampires', seasonNumber: 1, episodeNumber: 3 })),
        ).toBe('The Vampires · S1E3');
        expect(getSubtitle(item({ year: 1922 }))).toBe('movie · 1922');
    });

    it('marks a live start as watching and includes the rating value', () => {
        expect(getActivityVerb(item({ activityType: 'started', isActive: true }))).toBe('Watching');
        expect(getActivityVerb(item({ activityType: 'rating', ratingValue: 8 }))).toBe(
            'Rated 8/10',
        );
    });

    it('prefers live progress over completion and clamps to 0..100', () => {
        expect(getProgress(item({ currentProgressPercentage: 40, completionPercentage: 90 }))).toBe(
            40,
        );
        expect(getProgress(item({ completionPercentage: 140 }))).toBe(100);
        expect(getProgress(item({}))).toBeNull();
    });

    it('flags transcodes, not direct play', () => {
        expect(playMethodBadge('full_transcode')).toBe('badge-soft-yellow');
        expect(playMethodBadge('direct')).toBe('badge-soft-green');
    });
});
