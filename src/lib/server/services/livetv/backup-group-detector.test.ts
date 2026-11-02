// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { detectBackupGroups } from './backup-group-detector.js';
import type { ProcessedChannel } from './auto-processor.js';
import type { M3uChannel } from './m3u-parser.js';

// ── Helper ─────────────────────────────────────────────────────────────

function makeProcessedChannel(
    overrides: Omit<Partial<ProcessedChannel>, 'original'> & {
        baseName: string;
        original: Partial<M3uChannel> & { name: string };
    },
): ProcessedChannel {
    const o = overrides.original;
    const orig: M3uChannel = {
        name: o.name,
        tvgId: o.tvgId,
        tvgName: o.tvgName,
        logoUrl: o.logoUrl,
        groupTitle: o.groupTitle,
        streamUrl: o.streamUrl ?? 'http://provider.example/live/user/pass/1.ts',
        countryCode: o.countryCode,
        extras: o.extras ?? {},
    };
    return {
        qualityTier: overrides.qualityTier ?? undefined,
        baseName: overrides.baseName,
        category: overrides.category ?? 'Uncategorized',
        backupGroupKey: overrides.backupGroupKey ?? undefined,
        isPrimary: overrides.isPrimary ?? false,
        isVod: overrides.isVod ?? false,
        regionalVariant: overrides.regionalVariant ?? undefined,
        region: overrides.region ?? undefined,
        original: orig,
    };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('detectBackupGroups', () => {
    it('groups channels by matching base name', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Nordwelle',
                qualityTier: 'fhd',
                original: {
                    name: 'Nordwelle FHD',
                    tvgId: 'Nordwelle.de',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'Nordwelle',
                qualityTier: 'hd',
                original: {
                    name: 'Nordwelle HD',
                    tvgId: 'Nordwelle.de',
                    countryCode: 'de',
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('Nordwelle');
        expect(groups[0].channelIndices).toHaveLength(2);
        expect(groups[0].detectionSignals).toContain('name_match');
    });

    it('confirms groups with matching tvg-id', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'KWF',
                qualityTier: 'fhd',
                original: {
                    name: 'KWF FHD',
                    tvgId: 'KWF.de',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'KWF',
                qualityTier: 'hd',
                original: { name: 'KWF HD', tvgId: 'KWF.de', countryCode: 'de' },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        expect(groups[0].detectionSignals).toContain('tvg_id_match');
    });

    it('confirms groups with matching group-title', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'fhd',
                original: {
                    name: 'MTK FHD',
                    tvgId: 'MTK.de',
                    groupTitle: 'FreeTV',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'hd',
                original: {
                    name: 'MTK HD',
                    tvgId: 'MTK.de',
                    groupTitle: 'FreeTV',
                    countryCode: 'de',
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        expect(groups[0].detectionSignals).toContain('group_title_match');
    });

    it('selects highest quality as primary', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'hd',
                original: { name: 'MTK HD', tvgId: 'MTK.de', countryCode: 'de' },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'fhd',
                original: {
                    name: 'MTK FHD',
                    tvgId: 'MTK.de',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'sd',
                original: { name: 'MTK SD', tvgId: 'MTK.de', countryCode: 'de' },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        // Primary should be the FHD channel (index 1)
        expect(groups[0].primaryIndex).toBe(1);
    });

    it('does NOT group channels with different base names', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'ZAVO 1',
                qualityTier: 'fhd',
                original: {
                    name: 'ZAVO 1 FHD',
                    tvgId: 'ZAVO1.de',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'ZAVO 2',
                qualityTier: 'fhd',
                original: {
                    name: 'ZAVO 2 FHD',
                    tvgId: 'ZAVO2.de',
                    countryCode: 'de',
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(0);
    });

    it('excludes VOD channels from grouping', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Channel',
                qualityTier: 'fhd',
                isVod: true,
                original: { name: 'Channel FHD' },
            }),
            makeProcessedChannel({
                baseName: 'Channel',
                qualityTier: 'hd',
                isVod: true,
                original: { name: 'Channel HD' },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(0);
    });

    it('separates channels from different countries', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Channel',
                qualityTier: 'hd',
                original: {
                    name: 'Channel HD',
                    tvgId: 'Channel.de',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'Channel',
                qualityTier: 'hd',
                original: {
                    name: 'Channel HD',
                    tvgId: 'Channel.at',
                    countryCode: 'at',
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        // Should NOT group them — they're regional variants, not backups
        expect(groups).toHaveLength(0);
    });

    it('handles channels without tvg-id', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Custom',
                qualityTier: 'fhd',
                original: {
                    name: 'Custom FHD',
                    tvgId: undefined,
                    countryCode: undefined,
                },
            }),
            makeProcessedChannel({
                baseName: 'Custom',
                qualityTier: 'hd',
                original: {
                    name: 'Custom HD',
                    tvgId: undefined,
                    countryCode: undefined,
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('Custom');
    });

    it('handles single channel (no group formed)', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Lonely',
                qualityTier: 'hd',
                original: { name: 'Lonely HD' },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(0);
    });

    it('handles empty input', () => {
        const groups = detectBackupGroups([]);
        expect(groups).toHaveLength(0);
    });

    it('strips backup markers from group-title comparison', () => {
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'Pino',
                qualityTier: 'fhd',
                original: {
                    name: 'Pino FHD',
                    groupTitle: 'Kids',
                    countryCode: 'de',
                },
            }),
            makeProcessedChannel({
                baseName: 'Pino',
                qualityTier: 'hd',
                original: {
                    name: 'Pino HD *',
                    groupTitle: 'Kids *',
                    countryCode: 'de',
                },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(1);
        expect(groups[0].detectionSignals).toContain('group_title_match');
    });

    it('does not merge a UHD feed with the HD/FHD feed of the same base name', () => {
        // A UHD feed is a distinct channel (own schedule/rights), not a mirror of
        // the FHD feed. Merging them made the FHD entry vanish from /livetv and
        // dragged the card to the UHD feed's playlist position.
        const channels: ProcessedChannel[] = [
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'fhd',
                original: { name: 'MTK FHD', countryCode: 'de' },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'hd',
                original: { name: 'MTK HD', countryCode: 'de' },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'uhd',
                original: { name: 'MTK UHD ¹', countryCode: 'de' },
            }),
            makeProcessedChannel({
                baseName: 'MTK',
                qualityTier: 'uhd',
                original: { name: 'MTK UHD ²', countryCode: 'de' },
            }),
        ];

        const groups = detectBackupGroups(channels);

        expect(groups).toHaveLength(2);

        const sdrGroup = groups.find((g) => g.channelIndices.includes(0));
        const uhdGroup = groups.find((g) => g.channelIndices.includes(2));

        // The FHD feed stays the primary of its own group (index 0 = MTK FHD).
        expect(sdrGroup?.channelIndices).toEqual([0, 1]);
        expect(sdrGroup?.primaryIndex).toBe(0);

        // The UHD feeds form a separate group; the clean feed leads.
        expect(uhdGroup?.channelIndices).toEqual([2, 3]);
        expect(uhdGroup?.primaryIndex).toBe(2);
    });
});

describe('detectBackupGroups — group keys', () => {
    const feed = (name: string, tier: 'fhd' | 'hd', countryCode: string) =>
        makeProcessedChannel({
            baseName: 'Nordwelle',
            qualityTier: tier,
            original: { name, tvgId: `Nordwelle.${countryCode}`, countryCode },
        });

    it('gives the country-separated groups of one station different keys', () => {
        const groups = detectBackupGroups([
            feed('Nordwelle FHD', 'fhd', 'de'),
            feed('Nordwelle HD', 'hd', 'de'),
            feed('Nordwelle FHD', 'fhd', 'at'),
            feed('Nordwelle HD', 'hd', 'at'),
        ]);
        expect(groups).toHaveLength(2);
        expect(new Set(groups.map((g) => g.key)).size).toBe(2);
    });

    it('keeps a station without a country at the plain key', () => {
        const plain = (name: string, tier: 'fhd' | 'hd') =>
            makeProcessedChannel({
                baseName: 'Nordwelle',
                qualityTier: tier,
                original: { name },
            });
        const [group] = detectBackupGroups([
            plain('Nordwelle FHD', 'fhd'),
            plain('Nordwelle HD', 'hd'),
        ]);
        expect(group.key).toBe('nordwelle');
    });
});
