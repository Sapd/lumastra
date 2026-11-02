// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { matchChannels, extractUrlChannelId, type ExistingChannel } from './channel-matcher.js';
import type { ProcessedChannel } from './auto-processor.js';
import type { M3uChannel } from './m3u-parser.js';

// ── Test Helpers ───────────────────────────────────────────────────────

function makeExisting(overrides: Partial<ExistingChannel> = {}): ExistingChannel {
    return {
        id: 'existing-1',
        name: 'Nordwelle HD',
        streamUrl: 'http://provider.com/live/user/pass/12345.ts',
        epgChannelId: 'Nordwelle.de',
        qualityTier: 'hd',
        categoryId: 'some-uuid',
        categoryName: 'free-tv',
        backupGroupId: undefined,
        sortOrder: 1,
        isVisible: true,
        adminDisplayName: undefined,
        countryCode: 'de',
        consecutiveAbsences: 0,
        ...overrides,
    };
}

function makeM3uChannel(overrides: Partial<M3uChannel> = {}): M3uChannel {
    return {
        tvgId: 'Nordwelle.de',
        tvgName: 'Nordwelle HD',
        name: 'Nordwelle HD',
        logoUrl: 'http://logo.com/nordwelle.png',
        groupTitle: 'Free TV',
        streamUrl: 'http://provider.com/live/user/pass/12345.ts',
        countryCode: 'de',
        extras: {},
        ...overrides,
    };
}

function makeProcessed(
    m3uOverrides: Partial<M3uChannel> = {},
    procOverrides: Partial<Omit<ProcessedChannel, 'original'>> = {},
): ProcessedChannel {
    return {
        original: makeM3uChannel(m3uOverrides),
        qualityTier: 'hd',
        baseName: 'Nordwelle',
        category: 'free-tv',
        backupGroupKey: undefined,
        isPrimary: false,
        isVod: false,
        regionalVariant: undefined,
        region: undefined,
        ...procOverrides,
    };
}

// ── extractUrlChannelId ────────────────────────────────────────────────

describe('extractUrlChannelId', () => {
    it('extracts numeric ID from .ts URLs', () => {
        expect(extractUrlChannelId('http://provider.com/live/user/pass/12345.ts')).toBe('12345');
    });

    it('extracts numeric ID from .m3u8 URLs', () => {
        expect(extractUrlChannelId('http://provider.com/live/user/pass/99999.m3u8')).toBe('99999');
    });

    it('extracts channel name from /ch/ path', () => {
        expect(extractUrlChannelId('http://provider.com/ch/NORDWELLEHD/stream.m3u8')).toBe(
            'NORDWELLEHD',
        );
    });

    it('extracts ID from query parameter', () => {
        expect(extractUrlChannelId('http://provider.com/play/live.php?id=789')).toBe('789');
    });

    it('extracts from /live/user/pass/ID pattern', () => {
        expect(extractUrlChannelId('http://provider.com/live/john/secret123/42567')).toBe('42567');
    });

    it('returns undefined for unrecognized URL formats', () => {
        expect(extractUrlChannelId('http://provider.com/some/random/path')).toBeUndefined();
    });

    it('handles malformed URLs gracefully', () => {
        expect(extractUrlChannelId('not-a-url')).toBeUndefined();
    });
});

// ── matchChannels ──────────────────────────────────────────────────────

describe('matchChannels', () => {
    describe('exact tvg-id match', () => {
        it('scores 100% confidence when all signals match', () => {
            const existing = [makeExisting()];
            const newCh = [makeProcessed()];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(1);
            expect(result.matched[0].confidence).toBe(100);
            expect(result.matched[0].tier).toBe('auto');
            expect(result.newChannels).toHaveLength(0);
            expect(result.removedChannels).toHaveLength(0);
        });

        it('scores high confidence with tvg-id match even when URL changes', () => {
            const existing = [makeExisting()];
            const newCh = [
                makeProcessed({
                    streamUrl: 'http://new-cdn.com/live/user/pass/99999.ts',
                }),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(1);
            // tvg-id (40) + name (25) + group (10) = 75 — still within review tier
            // but URL channel ID doesn't match (old: 12345, new: 99999)
            expect(result.matched[0].confidence).toBeGreaterThanOrEqual(50);
            expect(result.matched[0].tier).toBe('review');
            expect(result.stats.urlChangedCount).toBe(1);
        });
    });

    describe('name-only match', () => {
        it('scores review confidence with name+URL ID+group match (60 points)', () => {
            const existing = [
                makeExisting({
                    epgChannelId: undefined,
                    streamUrl: 'http://old-provider.com/live/user/pass/12345.ts',
                }),
            ];
            const newCh = [
                makeProcessed(
                    {
                        tvgId: undefined,
                        streamUrl: 'http://new-provider.com/live/user/pass/12345.ts',
                    },
                    { category: 'free-tv' },
                ),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(1);
            // name (25) + URL channel ID (25) + group (10) = 60 → review tier
            expect(result.matched[0].confidence).toBe(60);
            expect(result.matched[0].tier).toBe('review');
        });

        it('treats name+group match (35 points) as new channel', () => {
            const existing = [
                makeExisting({
                    epgChannelId: undefined,
                    streamUrl: 'http://old.com/stream/abc',
                }),
            ];
            const newCh = [
                makeProcessed(
                    {
                        tvgId: undefined,
                        streamUrl: 'http://new.com/stream/xyz',
                    },
                    { category: 'free-tv' },
                ),
            ];

            const result = matchChannels(existing, newCh);

            // name (25) + group-title (10) = 35 — below 50 threshold
            expect(result.matched).toHaveLength(0);
            expect(result.newChannels).toHaveLength(1);
            expect(result.removedChannels).toHaveLength(1);
        });
    });

    describe('completely new channel', () => {
        it('identifies channels with no matches', () => {
            const existing = [makeExisting()];
            const newCh = [
                makeProcessed(
                    {
                        tvgId: 'KWF.de',
                        name: 'KWF HD',
                        streamUrl: 'http://provider.com/live/user/pass/67890.ts',
                    },
                    {
                        baseName: 'KWF',
                        category: 'news',
                    },
                ),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(0);
            expect(result.newChannels).toHaveLength(1);
            expect(result.removedChannels).toHaveLength(1);
            expect(result.stats.newCount).toBe(1);
            expect(result.stats.removedCount).toBe(1);
        });
    });

    describe('mass restructure detection', () => {
        it('detects mass restructure when >50% channels unmatched', () => {
            const existing = [
                makeExisting({
                    id: 'e1',
                    name: 'Channel A',
                    epgChannelId: 'A.de',
                }),
                makeExisting({
                    id: 'e2',
                    name: 'Channel B',
                    epgChannelId: 'B.de',
                }),
                makeExisting({
                    id: 'e3',
                    name: 'Channel C',
                    epgChannelId: 'C.de',
                }),
                makeExisting({
                    id: 'e4',
                    name: 'Channel D',
                    epgChannelId: 'D.de',
                }),
            ];
            // Only one new channel matches (25% match rate → 75% unmatched)
            const newCh = [
                makeProcessed({ tvgId: 'A.de', name: 'Channel A' }),
                makeProcessed(
                    { tvgId: 'X.de', name: 'New X' },
                    { baseName: 'New X', category: 'other' },
                ),
                makeProcessed(
                    { tvgId: 'Y.de', name: 'New Y' },
                    { baseName: 'New Y', category: 'other' },
                ),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.massRestructure).toBe(true);
            expect(result.removedChannels.length).toBeGreaterThan(existing.length * 0.5);
        });

        it('does not flag as mass restructure when most channels match', () => {
            const existing = [
                makeExisting({
                    id: 'e1',
                    name: 'Ch A',
                    epgChannelId: 'A.de',
                    streamUrl: 'http://p.com/live/u/p/1.ts',
                }),
                makeExisting({
                    id: 'e2',
                    name: 'Ch B',
                    epgChannelId: 'B.de',
                    streamUrl: 'http://p.com/live/u/p/2.ts',
                }),
            ];
            const newCh = [
                makeProcessed({
                    tvgId: 'A.de',
                    name: 'Ch A',
                    streamUrl: 'http://p.com/live/u/p/1.ts',
                }),
                makeProcessed({
                    tvgId: 'B.de',
                    name: 'Ch B',
                    streamUrl: 'http://p.com/live/u/p/2.ts',
                }),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.massRestructure).toBe(false);
            expect(result.matched).toHaveLength(2);
        });
    });

    describe('greedy assignment', () => {
        it('assigns best matches first, preventing double-matching', () => {
            // Two existing channels with similar names
            const existing = [
                makeExisting({
                    id: 'e1',
                    name: 'MTK HD',
                    epgChannelId: 'MTK.de',
                    streamUrl: 'http://p.com/live/u/p/100.ts',
                }),
                makeExisting({
                    id: 'e2',
                    name: 'MTK2 HD',
                    epgChannelId: 'MTK2.de',
                    streamUrl: 'http://p.com/live/u/p/200.ts',
                }),
            ];
            const newCh = [
                makeProcessed({
                    tvgId: 'MTK.de',
                    name: 'MTK HD',
                    streamUrl: 'http://p.com/live/u/p/100.ts',
                }),
                makeProcessed({
                    tvgId: 'MTK2.de',
                    name: 'MTK2 HD',
                    streamUrl: 'http://p.com/live/u/p/200.ts',
                }),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(2);
            // Each existing should match to its correct new channel
            const matchMap = new Map(
                result.matched.map((m) => [m.existingChannel.id, m.newChannel.original.tvgId]),
            );
            expect(matchMap.get('e1')).toBe('MTK.de');
            expect(matchMap.get('e2')).toBe('MTK2.de');
        });
    });

    describe('empty inputs', () => {
        it('handles empty existing channels', () => {
            const result = matchChannels([], [makeProcessed()]);

            expect(result.matched).toHaveLength(0);
            expect(result.newChannels).toHaveLength(1);
            expect(result.removedChannels).toHaveLength(0);
            expect(result.massRestructure).toBe(false);
        });

        it('handles empty new channels', () => {
            const result = matchChannels([makeExisting()], []);

            expect(result.matched).toHaveLength(0);
            expect(result.newChannels).toHaveLength(0);
            expect(result.removedChannels).toHaveLength(1);
            expect(result.massRestructure).toBe(true); // 100% unmatched > 50%
        });

        it('handles both empty', () => {
            const result = matchChannels([], []);

            expect(result.matched).toHaveLength(0);
            expect(result.newChannels).toHaveLength(0);
            expect(result.removedChannels).toHaveLength(0);
            expect(result.massRestructure).toBe(false);
        });
    });

    describe('tvg-id case insensitivity', () => {
        it('matches tvg-ids case-insensitively', () => {
            const existing = [makeExisting({ epgChannelId: 'Nordwelle.de' })];
            const newCh = [makeProcessed({ tvgId: 'nordwelle.de' })];

            const result = matchChannels(existing, newCh);

            expect(result.matched).toHaveLength(1);
            expect(result.matched[0].signals.find((s) => s.type === 'tvg-id')?.matched).toBe(true);
        });
    });

    describe('stats correctness', () => {
        it('reports correct stats for mixed results', () => {
            const existing = [
                makeExisting({
                    id: 'e1',
                    name: 'Ch A',
                    epgChannelId: 'A.de',
                    streamUrl: 'http://p.com/live/u/p/1.ts',
                }),
                makeExisting({
                    id: 'e2',
                    name: 'Ch B',
                    epgChannelId: 'B.de',
                    streamUrl: 'http://p.com/live/u/p/2.ts',
                }),
                makeExisting({
                    id: 'e3',
                    name: 'Ch C',
                    epgChannelId: 'C.de',
                    streamUrl: 'http://p.com/live/u/p/3.ts',
                }),
            ];
            const newCh = [
                // Matches e1 exactly
                makeProcessed({
                    tvgId: 'A.de',
                    name: 'Ch A',
                    streamUrl: 'http://p.com/live/u/p/1.ts',
                }),
                // Matches e2 with URL change
                makeProcessed({
                    tvgId: 'B.de',
                    name: 'Ch B',
                    streamUrl: 'http://new-cdn.com/live/u/p/999.ts',
                }),
                // New channel
                makeProcessed(
                    {
                        tvgId: 'X.de',
                        name: 'New X',
                        streamUrl: 'http://p.com/live/u/p/999.ts',
                    },
                    { baseName: 'New X', category: 'other' },
                ),
            ];

            const result = matchChannels(existing, newCh);

            expect(result.stats.totalExisting).toBe(3);
            expect(result.stats.totalNew).toBe(3);
            expect(result.stats.newCount).toBe(1);
            expect(result.stats.removedCount).toBe(1); // Ch C not matched
            expect(result.stats.urlChangedCount).toBe(1); // Ch B URL changed
        });
    });
});
