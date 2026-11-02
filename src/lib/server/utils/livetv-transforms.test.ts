// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    liveTvChannelToUniversalItem,
    liveTvChannelToWhatsOnItem,
    formatWhatsOnSubtitle,
    getRemainingMinutes,
    filterChannels,
} from './livetv-transforms.js';
import type { LiveTvChannel } from '$lib/schemas/livetv.js';

function makeChannel(overrides: Partial<LiveTvChannel> = {}): LiveTvChannel {
    return {
        images: {},
        id: 'ch-uuid-1',
        name: 'WBN One',
        sortOrder: 1,
        isVisible: true,
        ...overrides,
    };
}

describe('liveTvChannelToUniversalItem', () => {
    it('converts a channel with current program', () => {
        const channel = makeChannel({
            images: {
                primary: { href: 'https://example.com/logo.png', revision: '0', source: 'self' },
            },
            currentProgram: {
                id: 'prog-1',
                channelId: 'ch-uuid-1',
                title: 'Evening News',
                startTime: '2026-03-09T18:00:00Z',
                endTime: '2026-03-09T19:00:00Z',
            },
        });

        const item = liveTvChannelToUniversalItem(channel);

        expect(item.id).toBe('ch-uuid-1');
        expect(item.title).toBe('WBN One');
        expect(item.mediaType).toBe('tvchannel');
        expect(item.aspectRatio).toBe('video');
        expect(item.image).toBe('https://example.com/logo.png');
        expect(item.subtitle).toBe('Evening News');
        expect(item.externalIds).toEqual({ internal: 'ch-uuid-1' });
        expect(item.isAvailable).toBe(true);
        expect(item.canRequest).toBe(false);
    });

    it('converts a channel without current program', () => {
        const channel = makeChannel();
        const item = liveTvChannelToUniversalItem(channel);

        expect(item.subtitle).toBeUndefined();
    });

    it('converts a channel without a primary image to empty string', () => {
        const channel = makeChannel();
        const item = liveTvChannelToUniversalItem(channel);

        expect(item.image).toBe('');
    });

    it('does not set optional entertainment fields', () => {
        const channel = makeChannel();
        const item = liveTvChannelToUniversalItem(channel);

        expect(item.year).toBeUndefined();
        expect(item.rating).toBeUndefined();
        expect(item.progress).toBeUndefined();
    });
});

describe('getRemainingMinutes', () => {
    const BASE_NOW = new Date('2026-03-10T20:00:00Z').getTime();

    it('returns 30 for program ending in 30 minutes', () => {
        const endTime = new Date(BASE_NOW + 30 * 60_000).toISOString();
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBe(30);
    });

    it('returns 2 for program ending in 2 minutes', () => {
        const endTime = new Date(BASE_NOW + 2 * 60_000).toISOString();
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBe(2);
    });

    it('returns 1 for program ending in < 1 minute but > 0', () => {
        const endTime = new Date(BASE_NOW + 30_000).toISOString(); // 30 seconds
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBe(1);
    });

    it('returns undefined for program already ended', () => {
        const endTime = new Date(BASE_NOW - 5 * 60_000).toISOString();
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBeUndefined();
    });

    it('returns undefined when endTime is undefined', () => {
        expect(getRemainingMinutes(undefined, BASE_NOW)).toBeUndefined();
    });

    it('returns undefined for invalid endTime string', () => {
        expect(getRemainingMinutes('not-a-date', BASE_NOW)).toBeUndefined();
    });

    it('returns undefined when endTime exactly equals now', () => {
        const endTime = new Date(BASE_NOW).toISOString();
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBeUndefined();
    });

    it('rounds up partial minutes', () => {
        // 1 minute and 1 second remaining → should return 2
        const endTime = new Date(BASE_NOW + 61_000).toISOString();
        expect(getRemainingMinutes(endTime, BASE_NOW)).toBe(2);
    });
});

describe('filterChannels', () => {
    it('returns all channels for empty query', () => {
        const channels = [
            makeChannel({ id: 'ch-1', name: 'WBN One' }),
            makeChannel({ id: 'ch-2', name: 'Siebenstern' }),
        ];
        expect(filterChannels(channels, '')).toEqual(channels);
    });

    it('returns all channels for whitespace-only query', () => {
        const channels = [makeChannel({ id: 'ch-1', name: 'WBN One' })];
        expect(filterChannels(channels, '   ')).toEqual(channels);
    });

    it('matches channel name case-insensitively', () => {
        const channels = [
            makeChannel({ id: 'ch-1', name: 'WBN One' }),
            makeChannel({ id: 'ch-2', name: 'Siebenstern' }),
        ];
        const result = filterChannels(channels, 'wbn');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ch-1');
    });

    it('matches partial channel name (substring)', () => {
        const channels = [
            makeChannel({ id: 'ch-1', name: 'Siebenstern' }),
            makeChannel({ id: 'ch-2', name: 'LRV' }),
        ];
        const result = filterChannels(channels, 'sieben');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ch-1');
    });

    it('matches category name', () => {
        const channels = [
            makeChannel({ id: 'ch-1', name: 'VELO', category: 'Sports' }),
            makeChannel({ id: 'ch-2', name: 'WBN News', category: 'News' }),
        ];
        const result = filterChannels(channels, 'sports');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ch-1');
    });

    it('matches current program title', () => {
        const channels = [
            makeChannel({
                id: 'ch-1',
                name: 'WBN One',
                currentProgram: {
                    id: 'p-1',
                    channelId: 'ch-1',
                    title: 'Evening News',
                    startTime: '2026-03-10T18:00:00Z',
                    endTime: '2026-03-10T19:00:00Z',
                },
            }),
            makeChannel({ id: 'ch-2', name: 'Siebenstern' }),
        ];
        const result = filterChannels(channels, 'evening');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ch-1');
    });

    it('returns empty array when no channels match', () => {
        const channels = [
            makeChannel({ id: 'ch-1', name: 'WBN One' }),
            makeChannel({ id: 'ch-2', name: 'Siebenstern' }),
        ];
        expect(filterChannels(channels, 'xyz')).toEqual([]);
    });

    it('handles channels without category or currentProgram', () => {
        const channels = [makeChannel({ id: 'ch-1', name: 'Test Channel' })];
        const result = filterChannels(channels, 'test');
        expect(result).toHaveLength(1);
    });
});

describe('isVisible filtering (widget-level behavior)', () => {
    it('filters out channels with isVisible: false', () => {
        const channels: LiveTvChannel[] = [
            makeChannel({ id: 'ch-1', name: 'Visible', isVisible: true }),
            makeChannel({ id: 'ch-2', name: 'Hidden', isVisible: false }),
            makeChannel({ id: 'ch-3', name: 'Also Visible', isVisible: true }),
        ];

        const items = channels.filter((ch) => ch.isVisible).map(liveTvChannelToUniversalItem);

        expect(items).toHaveLength(2);
        expect(items[0].title).toBe('Visible');
        expect(items[1].title).toBe('Also Visible');
    });

    it('returns empty array when all channels are hidden', () => {
        const channels: LiveTvChannel[] = [
            makeChannel({ id: 'ch-1', isVisible: false }),
            makeChannel({ id: 'ch-2', isVisible: false }),
        ];

        const items = channels.filter((ch) => ch.isVisible).map(liveTvChannelToUniversalItem);

        expect(items).toHaveLength(0);
    });
});

describe('formatWhatsOnSubtitle', () => {
    const BASE_NOW = new Date('2026-03-10T20:00:00Z').getTime();

    it('returns "title · Ends in X min" for channel with current program', () => {
        const channel = makeChannel({
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'News at Ten',
                startTime: '2026-03-10T19:30:00Z',
                endTime: new Date(BASE_NOW + 23 * 60_000).toISOString(),
            },
        });

        const result = formatWhatsOnSubtitle(channel, BASE_NOW);
        expect(result).toBe('News at Ten · Ends in 23 min');
    });

    it('returns undefined for channel without current program', () => {
        const channel = makeChannel();
        expect(formatWhatsOnSubtitle(channel, BASE_NOW)).toBeUndefined();
    });

    it('returns program title only when program endTime is past', () => {
        const channel = makeChannel({
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'Old Show',
                startTime: '2026-03-10T17:00:00Z',
                endTime: '2026-03-10T18:00:00Z', // 2 hours ago relative to BASE_NOW
            },
        });

        expect(formatWhatsOnSubtitle(channel, BASE_NOW)).toBe('Old Show');
    });

    it('shows 1 min for program ending in under 1 minute', () => {
        const channel = makeChannel({
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'Almost Done',
                startTime: '2026-03-10T19:00:00Z',
                endTime: new Date(BASE_NOW + 30_000).toISOString(), // 30 seconds
            },
        });

        expect(formatWhatsOnSubtitle(channel, BASE_NOW)).toBe('Almost Done · Ends in 1 min');
    });

    it('shows 120 min for program ending in 2 hours', () => {
        const channel = makeChannel({
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'Long Movie',
                startTime: '2026-03-10T18:00:00Z',
                endTime: new Date(BASE_NOW + 120 * 60_000).toISOString(),
            },
        });

        expect(formatWhatsOnSubtitle(channel, BASE_NOW)).toBe('Long Movie · Ends in 120 min');
    });

    it('uses custom formatEndsIn function', () => {
        const channel = makeChannel({
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'Test',
                startTime: '2026-03-10T19:30:00Z',
                endTime: new Date(BASE_NOW + 10 * 60_000).toISOString(),
            },
        });

        const result = formatWhatsOnSubtitle(
            channel,
            BASE_NOW,
            ({ minutes }) => `Endet in ${minutes} Min.`,
        );
        expect(result).toBe('Test · Endet in 10 Min.');
    });
});

describe('liveTvChannelToWhatsOnItem', () => {
    const BASE_NOW = new Date('2026-03-10T20:00:00Z').getTime();

    it('includes enhanced subtitle with time remaining', () => {
        const channel = makeChannel({
            images: {
                primary: { href: 'https://example.com/logo.png', revision: '0', source: 'self' },
            },
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'News at Ten',
                startTime: '2026-03-10T19:30:00Z',
                endTime: new Date(BASE_NOW + 23 * 60_000).toISOString(),
            },
        });

        const item = liveTvChannelToWhatsOnItem(channel, BASE_NOW);

        expect(item.subtitle).toBe('News at Ten · Ends in 23 min');
    });

    it('preserves all base fields from channel', () => {
        const channel = makeChannel({
            images: {
                primary: { href: 'https://example.com/logo.png', revision: '0', source: 'self' },
            },
            currentProgram: {
                id: 'p-1',
                channelId: 'ch-uuid-1',
                title: 'Test',
                startTime: '2026-03-10T19:30:00Z',
                endTime: new Date(BASE_NOW + 10 * 60_000).toISOString(),
            },
        });

        const item = liveTvChannelToWhatsOnItem(channel, BASE_NOW);

        expect(item.id).toBe('ch-uuid-1');
        expect(item.title).toBe('WBN One');
        expect(item.mediaType).toBe('tvchannel');
        expect(item.aspectRatio).toBe('video');
        expect(item.image).toBe('https://example.com/logo.png');
        expect(item.externalIds).toEqual({ internal: 'ch-uuid-1' });
        expect(item.isAvailable).toBe(true);
        expect(item.canRequest).toBe(false);
    });

    it('returns undefined subtitle for channel without current program', () => {
        const channel = makeChannel();
        const item = liveTvChannelToWhatsOnItem(channel, BASE_NOW);
        expect(item.subtitle).toBeUndefined();
    });
});
