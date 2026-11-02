// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    detectQualityTier,
    extractBaseName,
    hasFeedMarker,
    isVodEntry,
    normalizeGroupTitle,
    isDegradedFeed,
    processChannels,
    isSeparatorEntry,
    separatorLabel,
} from './auto-processor.js';
import { parseM3u } from './m3u-parser.js';
import type { M3uChannel } from './m3u-parser.js';

// ── Helper ─────────────────────────────────────────────────────────────

function makeChannel(overrides: Partial<M3uChannel> & { name: string }): M3uChannel {
    return {
        tvgId: undefined,
        tvgName: undefined,
        logoUrl: undefined,
        groupTitle: undefined,
        streamUrl: 'http://provider.example/live/user/pass/1.ts',
        countryCode: undefined,
        extras: {},
        ...overrides,
    };
}

// ── Quality Tier Detection ─────────────────────────────────────────────

describe('detectQualityTier', () => {
    it('detects UHD indicators', () => {
        expect(detectQualityTier('MTK UHD')).toBe('uhd');
        expect(detectQualityTier('Channel 4K')).toBe('uhd');
        expect(detectQualityTier('Sport 2160p')).toBe('uhd');
    });

    it('detects FHD indicators', () => {
        expect(detectQualityTier('Nordwelle FHD')).toBe('fhd');
        expect(detectQualityTier('Sport 1080p')).toBe('fhd');
        expect(detectQualityTier('Channel FULLHD')).toBe('fhd');
        expect(detectQualityTier('Channel FULL HD')).toBe('fhd');
        expect(detectQualityTier('FHD Kino')).toBe('fhd');
    });

    it('detects HD indicators', () => {
        expect(detectQualityTier('KWF HD')).toBe('hd');
        expect(detectQualityTier('Sport 720p')).toBe('hd');
    });

    it('detects SD indicators', () => {
        expect(detectQualityTier('Orb Sport SD')).toBe('sd');
        expect(detectQualityTier('Channel 480p')).toBe('sd');
        expect(detectQualityTier('Channel 576p')).toBe('sd');
    });

    it('returns undefined when no quality indicator present', () => {
        expect(detectQualityTier('Tukan Prime 1')).toBeUndefined();
        expect(detectQualityTier('VDD')).toBeUndefined();
        expect(detectQualityTier('')).toBeUndefined();
    });

    it('returns highest quality when multiple indicators present', () => {
        expect(detectQualityTier('Channel UHD HD')).toBe('uhd');
        expect(detectQualityTier('Channel FHD SD')).toBe('fhd');
    });

    it('handles quality before backup markers', () => {
        expect(detectQualityTier('Nordwelle FHD *')).toBe('fhd');
        expect(detectQualityTier('MTK HD \u00b2')).toBe('hd');
    });

    it('handles quality after channel numbers', () => {
        expect(detectQualityTier('ZAVO 1 FHD')).toBe('fhd');
    });

    it('does not confuse FHD/UHD with HD', () => {
        // FHD should not match as HD
        expect(detectQualityTier('Channel FHD')).toBe('fhd');
        // UHD should not match as HD
        expect(detectQualityTier('Channel UHD')).toBe('uhd');
    });

    it('reads a trailing HD+ as the HD feed of a channel', () => {
        expect(detectQualityTier('Channel HD+')).toBe('hd');
        expect(detectQualityTier('HD+ Info')).toBeUndefined();
    });
});

// ── Base Name Extraction ───────────────────────────────────────────────

describe('extractBaseName', () => {
    it('strips quality suffixes', () => {
        expect(extractBaseName('Nordwelle FHD')).toBe('Nordwelle');
        expect(extractBaseName('Nordwelle HD')).toBe('Nordwelle');
        expect(extractBaseName('MTK UHD')).toBe('MTK');
        expect(extractBaseName('Orb Sport SD')).toBe('Orb Sport');
    });

    it('strips raw quality variants and a trailing feed word', () => {
        expect(extractBaseName('Nordwelle HDraw')).toBe('Nordwelle');
        expect(extractBaseName('Nordwelle HDraw²')).toBe('Nordwelle');
        expect(extractBaseName('Nordwelle HDraw Cable')).toBe('Nordwelle');
        expect(extractBaseName('Siebenstern MAXX FHDraw')).toBe('Siebenstern MAXX');
        expect(extractBaseName('Sport8 HD RAW')).toBe('Sport8');
        // Feed words only count at the end of the name.
        expect(extractBaseName('Kabel Acht HDraw')).toBe('Kabel Acht');
        expect(extractBaseName('SAT.4 HDraw Cable')).toBe('SAT.4');
        expect(extractBaseName('Cable News HD')).toBe('Cable News');
        // A trailing HD+ / FHD+ is a feed of the same station.
        expect(extractBaseName('Nordwelle HD+')).toBe('Nordwelle');
        expect(extractBaseName('MTK FHD+')).toBe('MTK');
        expect(extractBaseName('HD+ Info')).toBe('HD+ Info');
    });

    it('keeps names where the feed word is the station', () => {
        // No quality tag: the trailing word belongs to the name.
        expect(extractBaseName('KWL RAW')).toBe('KWL RAW');
        // Only digits would remain.
        expect(extractBaseName('3 SAT HD')).toBe('3 SAT');
        // A backup digit after a raw tag goes with it, like after HD.
        expect(extractBaseName('Nordwelle HDraw 2')).toBe('Nordwelle');
    });

    it('ranks raw feeds by their quality and keeps the clean feed primary', () => {
        expect(detectQualityTier('Nordwelle HDraw')).toBe('hd');
        expect(detectQualityTier('Orb Sport UHDraw')).toBe('uhd');
        const result = processChannels([
            makeChannel({ name: 'Nordwelle HDraw' }),
            makeChannel({ name: 'Nordwelle HD' }),
        ]);
        expect(result.backupGroups).toHaveLength(1);
        const group = result.backupGroups[0];
        expect(result.channels[group.primaryIndex].original.name).toBe('Nordwelle HD');
    });

    it('strips backup markers', () => {
        expect(extractBaseName('Pinotopia HD *')).toBe('Pinotopia');
        expect(extractBaseName('Stern7 HD **')).toBe('Stern7');
        expect(extractBaseName('VEX HD WEB')).toBe('VEX');
    });

    it('strips superscript numbers', () => {
        expect(extractBaseName('3kult HD \u00b9')).toBe('3kult');
        expect(extractBaseName('3kult HD \u00b2')).toBe('3kult');
    });

    it('preserves channel numbers', () => {
        expect(extractBaseName('ZAVO 1 FHD')).toBe('ZAVO 1');
        expect(extractBaseName('Orb Sport BL 1 FHD')).toBe('Orb Sport BL 1');
        expect(extractBaseName('HLV 1 HD *')).toBe('HLV 1');
    });

    it('does not strip numbers from channels without quality tier', () => {
        expect(extractBaseName('Tukan Prime 1')).toBe('Tukan Prime 1');
    });

    it('normalizes whitespace', () => {
        expect(extractBaseName('  Nord  Welle   FHD  ')).toBe('Nord Welle');
    });

    it('returns original name when stripping would produce empty string', () => {
        expect(extractBaseName('HD')).toBe('HD');
        expect(extractBaseName('FHD')).toBe('FHD');
    });
});

// ── VOD Detection ──────────────────────────────────────────────────────

describe('hasFeedMarker', () => {
    it('detects asterisk, superscript, and WEB markers', () => {
        expect(hasFeedMarker('News 24 HD *')).toBe(true);
        expect(hasFeedMarker('News 24 HD **')).toBe(true);
        expect(hasFeedMarker('News 24 HD ²')).toBe(true);
        expect(hasFeedMarker('News 24 HD ¹')).toBe(true);
        expect(hasFeedMarker('News 24 HD WEB')).toBe(true);
        expect(hasFeedMarker('News 24 backup')).toBe(true);
    });

    it('returns false for clean names (including plain quality tags)', () => {
        expect(hasFeedMarker('News 24 HD')).toBe(false);
        expect(hasFeedMarker('News 24 FHD')).toBe(false);
        expect(hasFeedMarker('Channel One')).toBe(false);
    });

    it('is stable across repeated calls (g-flag lastIndex reset)', () => {
        expect(hasFeedMarker('News 24 HD *')).toBe(true);
        expect(hasFeedMarker('News 24 HD *')).toBe(true);
        expect(hasFeedMarker('News 24 HD')).toBe(false);
        expect(hasFeedMarker('News 24 HD')).toBe(false);
    });
});

describe('isVodEntry', () => {
    it('detects VOD by file extension', () => {
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/movie/user/pass/12345.mkv',
                }),
            ),
        ).toBe(true);
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/series/user/pass/67890.mp4',
                }),
            ),
        ).toBe(true);
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/vod/12345.avi',
                }),
            ),
        ).toBe(true);
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/vod/12345.flv',
                }),
            ),
        ).toBe(true);
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/vod/12345.wmv',
                }),
            ),
        ).toBe(true);
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Movie',
                    streamUrl: 'http://example.com/vod/12345.mov',
                }),
            ),
        ).toBe(true);
    });

    it('does not flag live streams as VOD', () => {
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Channel',
                    streamUrl: 'http://example.com/live/user/pass/501.ts',
                }),
            ),
        ).toBe(false);
    });

    it('ignores query parameters in URL', () => {
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Channel',
                    streamUrl: 'http://example.com/live/user/pass/501.ts?token=abc',
                }),
            ),
        ).toBe(false);
    });

    it('detects VOD by group-title hints', () => {
        expect(
            isVodEntry(
                makeChannel({
                    name: 'Action Movie',
                    groupTitle: 'VOD | Action',
                }),
            ),
        ).toBe(true);
        expect(isVodEntry(makeChannel({ name: 'Comedy', groupTitle: 'Movies | Comedy' }))).toBe(
            true,
        );
        expect(isVodEntry(makeChannel({ name: 'Show', groupTitle: 'Series | Drama' }))).toBe(true);
    });

    it('does not flag non-VOD group titles', () => {
        expect(isVodEntry(makeChannel({ name: 'Channel', groupTitle: 'FreeTV / HD+' }))).toBe(
            false,
        );
        expect(isVodEntry(makeChannel({ name: 'Channel', groupTitle: 'Sports' }))).toBe(false);
    });
});

// ── Category Normalization ─────────────────────────────────────────────

describe('normalizeGroupTitle', () => {
    it('maps sports-related titles', () => {
        expect(normalizeGroupTitle('Orb Topliga')).toBe('Sports');
        expect(normalizeGroupTitle('ZAVO Event')).toBe('Live Events');
        expect(normalizeGroupTitle('USA Sport')).toBe('Sports');
        expect(normalizeGroupTitle('Orb Sport')).toBe('Sports');
    });

    it('maps kids-related titles', () => {
        expect(normalizeGroupTitle('Kids')).toBe('Kids');
        expect(normalizeGroupTitle('Kids *')).toBe('Kids');
        expect(normalizeGroupTitle('Kinder')).toBe('Kids');
    });

    it('maps cinema-related titles', () => {
        expect(normalizeGroupTitle('Orb Cinema')).toBe('Movies');
        expect(normalizeGroupTitle('Kino')).toBe('Movies');
        expect(normalizeGroupTitle('Film')).toBe('Movies');
    });

    it('maps news-related titles', () => {
        expect(normalizeGroupTitle('News')).toBe('News');
        expect(normalizeGroupTitle('Nachrichten')).toBe('News');
    });

    it('maps entertainment-related titles', () => {
        expect(normalizeGroupTitle('Entertainment')).toBe('Entertainment');
        expect(normalizeGroupTitle('Unterhaltung')).toBe('Entertainment');
    });

    it('maps free TV titles', () => {
        expect(normalizeGroupTitle('FreeTV / HD+')).toBe('Free TV');
        expect(normalizeGroupTitle('FreeTV')).toBe('Free TV');
    });

    it('maps genre words in other languages', () => {
        expect(normalizeGroupTitle('PL FILMY i SERIALE')).toBe('Movies');
        expect(normalizeGroupTitle('Детские 2')).toBe('Kids');
        expect(normalizeGroupTitle('TR SİNEMA')).toBe('Movies');
        expect(normalizeGroupTitle('RO • STIRI')).toBe('News');
        expect(normalizeGroupTitle('TR BELGESEL')).toBe('Documentary');
        expect(normalizeGroupTitle('EVENTS • GRD')).toBe('Live Events');
        expect(normalizeGroupTitle('KONTI LIVE EVENT MIX')).toBe('Live Events');
        expect(normalizeGroupTitle('DE • Radio')).toBe('Radio');
        expect(normalizeGroupTitle('US • Regional')).toBe('Regional');
    });

    it('turns a country-only or noise-only title into General', () => {
        expect(normalizeGroupTitle('SK • SLOVAKIA')).toBe('General');
        expect(normalizeGroupTitle('FHD+ HEVC & WebTV')).toBe('General');
        expect(normalizeGroupTitle('AT / CH')).toBe('General');
        expect(normalizeGroupTitle('Schweiz')).toBe('General');
    });

    it('keeps a bouquet title without its country part', () => {
        expect(normalizeGroupTitle('Tukan Prime')).toBe('Tukan Prime');
        expect(normalizeGroupTitle('SomeUnknownCategory')).toBe('SomeUnknownCategory');
        expect(normalizeGroupTitle('NL VELOPLAY')).toBe('VELOPLAY');
        expect(normalizeGroupTitle('DE • Orb • Low Quali')).toBe('Orb');
        expect(normalizeGroupTitle('ZAHRA: ZAHRA GROUP')).toBe('ZAHRA GROUP');
    });

    it('returns Uncategorized for empty/undefined input', () => {
        expect(normalizeGroupTitle('')).toBe('Uncategorized');
        expect(normalizeGroupTitle('   ')).toBe('Uncategorized');
    });
});

// ── Full Pipeline ──────────────────────────────────────────────────────

describe('processChannels', () => {
    it('handles empty input', () => {
        const result = processChannels([]);
        expect(result.channels).toHaveLength(0);
        expect(result.backupGroups).toHaveLength(0);
        expect(result.categories).toHaveLength(0);
        expect(result.vodCount).toBe(0);
        expect(result.stats.totalInput).toBe(0);
    });

    it('processes sample M3U data correctly', () => {
        const samplePath = path.resolve(__dirname, '../../__tests__/fixtures/livetv/sample.m3u');
        // Parse sample M3U to get channels
        const content = fs.readFileSync(samplePath, 'utf-8');
        const parsed = parseM3u(content);

        const result = processChannels(parsed.channels);

        expect(result.stats.totalInput).toBe(parsed.channels.length);
        expect(result.stats.totalInput).toBeGreaterThan(0);
        expect(result.vodCount).toBe(0); // sample.m3u has no VOD entries
        expect(result.categories.length).toBeGreaterThan(0);
        expect(result.warnings).toEqual([]);
    });

    it('detects VOD and excludes from backup grouping', () => {
        const channels: M3uChannel[] = [
            makeChannel({
                name: 'MTK FHD',
                tvgId: 'MTK.de',
                groupTitle: 'FreeTV',
                countryCode: 'de',
            }),
            makeChannel({
                name: 'MTK HD',
                tvgId: 'MTK.de',
                groupTitle: 'FreeTV',
                countryCode: 'de',
            }),
            makeChannel({
                name: 'VOD Movie',
                groupTitle: 'VOD | Action',
                streamUrl: 'http://example.com/movie/12345.mkv',
            }),
        ];

        const result = processChannels(channels);

        expect(result.vodCount).toBe(1);
        expect(result.channels[2].isVod).toBe(true);
        expect(result.stats.totalAfterVodFilter).toBe(2);
    });

    // Both cases below look like perfectly ordinary live channels and both
    // vanish from Live TV without a word: importM3uSource drops every entry
    // carrying `isVod` when it persists channels (`if (ch.isVod) continue`),
    // yet the import still finishes "successfully" with the channel count
    // silently short. isVodEntry is unit-tested above; what these pin down is
    // the consequence — the reason a channel you can see in the playlist never
    // reaches the database.
    it('flags an HLS channel as VOD purely because its group is titled "Movies"', () => {
        const channels: M3uChannel[] = [
            makeChannel({
                name: 'Cinegrove',
                groupTitle: 'Movies',
                streamUrl: 'http://provider.example/live/cinegrove/index.m3u8',
            }),
            makeChannel({
                name: 'Cinegrove',
                groupTitle: 'Cinema',
                streamUrl: 'http://provider.example/live/cinegrove/index.m3u8',
            }),
        ];

        const result = processChannels(channels);

        // Identical live stream; only the group title differs.
        expect(result.channels[0].isVod).toBe(true);
        expect(result.channels[1].isVod).toBe(false);
        expect(result.vodCount).toBe(1);
    });

    it('flags a channel as VOD when its stream URL is a direct video file', () => {
        const channels: M3uChannel[] = [
            makeChannel({
                name: 'Studio Loop',
                groupTitle: 'Lifestyle',
                streamUrl: 'http://provider.example/streams/ch1.mp4',
            }),
            makeChannel({
                name: 'Studio Loop',
                groupTitle: 'Lifestyle',
                streamUrl: 'http://provider.example/streams/ch1/index.m3u8',
            }),
        ];

        const result = processChannels(channels);

        expect(result.channels[0].isVod).toBe(true);
        expect(result.channels[1].isVod).toBe(false);
        expect(result.vodCount).toBe(1);
    });

    it('assigns quality tiers to channels', () => {
        const channels: M3uChannel[] = [
            makeChannel({ name: 'Channel FHD' }),
            makeChannel({ name: 'Channel HD' }),
            makeChannel({ name: 'Channel SD' }),
            makeChannel({ name: 'No Quality' }),
        ];

        const result = processChannels(channels);

        expect(result.channels[0].qualityTier).toBe('fhd');
        expect(result.channels[1].qualityTier).toBe('hd');
        expect(result.channels[2].qualityTier).toBe('sd');
        expect(result.channels[3].qualityTier).toBeUndefined();
    });

    it('creates category mappings', () => {
        const channels: M3uChannel[] = [
            makeChannel({ name: 'Ch1', groupTitle: 'Orb Topliga' }),
            makeChannel({ name: 'Ch2', groupTitle: 'Kids' }),
            makeChannel({ name: 'Ch3', groupTitle: 'Orb Topliga' }),
        ];

        const result = processChannels(channels);

        // Should have 2 unique category mappings (Orb Topliga, Kids)
        expect(result.categories).toHaveLength(2);
        expect(
            result.categories.find((c) => c.rawGroupTitle === 'Orb Topliga')?.normalizedName,
        ).toBe('Sports');
        expect(result.categories.find((c) => c.rawGroupTitle === 'Kids')?.normalizedName).toBe(
            'Kids',
        );
    });

    it('detects backup groups and marks primaries', () => {
        const channels: M3uChannel[] = [
            makeChannel({
                name: 'Nordwelle FHD',
                tvgId: 'Nordwelle.de',
                groupTitle: 'FreeTV',
                countryCode: 'de',
            }),
            makeChannel({
                name: 'Nordwelle HD',
                tvgId: 'Nordwelle.de',
                groupTitle: 'FreeTV',
                countryCode: 'de',
            }),
        ];

        const result = processChannels(channels);

        expect(result.backupGroups).toHaveLength(1);
        expect(result.backupGroups[0].name).toBe('Nordwelle');
        expect(result.channels[0].isPrimary).toBe(true);
        expect(result.channels[1].isPrimary).toBe(false);
        expect(result.channels[0].backupGroupKey).toBe(result.channels[1].backupGroupKey);
    });

    it('prefers the clean feed as primary over a same-quality marked backup', () => {
        // Same channel, same quality (HD) — one clean, the others marked as backups
        // (*, superscript, WEB). The clean feed must be the primary even though it is
        // NOT first in the list, so the marked feeds never surface as the visible card.
        const channels: M3uChannel[] = [
            makeChannel({ name: 'News 24 HD *', tvgId: 'News24.de', countryCode: 'de' }),
            makeChannel({ name: 'News 24 HD ²', tvgId: 'News24.de', countryCode: 'de' }),
            makeChannel({ name: 'News 24 HD', tvgId: 'News24.de', countryCode: 'de' }),
            makeChannel({ name: 'News 24 HD WEB', tvgId: 'News24.de', countryCode: 'de' }),
        ];

        const result = processChannels(channels);

        expect(result.backupGroups).toHaveLength(1);
        const primary = result.channels.find((c) => c.isPrimary);
        expect(primary?.original.name).toBe('News 24 HD');
        // exactly one primary
        expect(result.channels.filter((c) => c.isPrimary)).toHaveLength(1);
    });

    it('detects regional-only channels', () => {
        const channels: M3uChannel[] = [
            makeChannel({
                name: 'HLV 1 HD *',
                tvgId: 'HLV1.ch',
                countryCode: 'ch',
                groupTitle: 'AT / CH *',
            }),
        ];

        const result = processChannels(channels);

        expect(result.channels[0].regionalVariant).toBeDefined();
        expect(result.channels[0].regionalVariant?.isRegionalOnly).toBe(true);
        expect(result.channels[0].regionalVariant?.countryCode).toBe('ch');
    });
});

// ── Ground-Truth Accuracy Test ─────────────────────────────────────────

describe('ground-truth backup grouping accuracy', () => {
    interface GroundTruthFixture {
        channels: M3uChannel[];
        expectedGroups: Array<{
            name: string;
            members: string[];
            primary: string;
        }>;
        expectedNotGrouped: string[];
        expectedVod: string[];
        expectedRegionalVariants: Array<{
            baseName: string;
            countryCodes: string[];
            isRegionalOnly: boolean;
        }>;
    }

    const fixturePath = path.resolve(
        __dirname,
        '../../__tests__/fixtures/livetv/ground-truth-backup-groups.json',
    );
    const fixture: GroundTruthFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

    it('achieves >90% backup grouping accuracy against ground truth', () => {
        const result = processChannels(fixture.channels);

        let correctGroupings = 0;
        let totalExpected = fixture.expectedGroups.length;

        for (const expected of fixture.expectedGroups) {
            // Find a backup group that contains all expected members
            const matchingGroup = result.backupGroups.find((bg) => {
                const memberNames = bg.channelIndices.map((i) => result.channels[i].original.name);
                return expected.members.every((m) => memberNames.includes(m));
            });

            if (matchingGroup) {
                correctGroupings++;
            }
        }

        const accuracy = correctGroupings / totalExpected;
        expect(accuracy).toBeGreaterThanOrEqual(0.9);
    });

    it('selects correct primary channels', () => {
        const result = processChannels(fixture.channels);

        for (const expected of fixture.expectedGroups) {
            const matchingGroup = result.backupGroups.find((bg) => {
                const memberNames = bg.channelIndices.map((i) => result.channels[i].original.name);
                return expected.members.every((m) => memberNames.includes(m));
            });

            if (matchingGroup) {
                const primaryName = result.channels[matchingGroup.primaryIndex].original.name;
                expect(primaryName).toBe(expected.primary);
            }
        }
    });

    it('does not group channels that should not be grouped', () => {
        const result = processChannels(fixture.channels);

        for (const notGroupedName of fixture.expectedNotGrouped) {
            const channelIdx = result.channels.findIndex(
                (ch) => ch.original.name === notGroupedName,
            );
            expect(channelIdx).toBeGreaterThanOrEqual(0);

            const channel = result.channels[channelIdx];
            // Channel should either not be in a backup group at all,
            // or be in a group alone (which shouldn't happen since groups need 2+)
            if (channel.backupGroupKey) {
                const group = result.backupGroups.find((bg) => bg.key === channel.backupGroupKey);
                // If it's in a group, make sure it's not grouped with the wrong channels
                // (e.g., ZAVO 1 and ZAVO 2 should NOT be in the same group)
                if (group) {
                    const otherNotGrouped = fixture.expectedNotGrouped.filter(
                        (n) => n !== notGroupedName,
                    );
                    const memberNames = group.channelIndices.map(
                        (i) => result.channels[i].original.name,
                    );
                    for (const other of otherNotGrouped) {
                        if (memberNames.includes(other)) {
                            // These two should NOT be grouped together
                            expect(memberNames).not.toContain(other);
                        }
                    }
                }
            }
        }
    });

    it('identifies all VOD entries with zero false negatives', () => {
        const result = processChannels(fixture.channels);

        for (const expectedVod of fixture.expectedVod) {
            const channel = result.channels.find((ch) => ch.original.name === expectedVod);
            expect(channel).toBeDefined();
            expect(channel?.isVod).toBe(true);
        }
    });

    it('achieves 100% quality tier accuracy', () => {
        const result = processChannels(fixture.channels);

        for (const ch of result.channels) {
            const name = ch.original.name;
            if (/\bFHD\b/i.test(name)) {
                expect(ch.qualityTier).toBe('fhd');
            } else if (/\bUHD\b|4K/i.test(name)) {
                expect(ch.qualityTier).toBe('uhd');
            } else if (/\bSD\b/i.test(name)) {
                expect(ch.qualityTier).toBe('sd');
            } else if (/\bHD\b/i.test(name)) {
                expect(ch.qualityTier).toBe('hd');
            } else {
                expect(ch.qualityTier).toBeUndefined();
            }
        }
    });
});

describe('section headers', () => {
    it('recognizes decorated section-header entries and nothing else', () => {
        for (const name of [
            '✦●✦ DE • Local RAW ✦●✦',
            '✦●✦|BG| KIDS ✦●✦',
            '▼•●• TopLiga Replay •●• ▼',
            '##########   ADULT XXX   ##########',
            '---AZERBAIJAN  ---',
        ]) {
            expect(isSeparatorEntry(name), name).toBe(true);
        }
        for (const name of [
            'Nordwelle HD',
            '♥ DuexXxPlay Studio ᴴᴰ',
            '+18 • Some Channel ᴜʜᴅ',
            '☆ Welcome Channel ☆',
            '[DE] Nordwelle HD',
            '(CH) HLV 1',
            '.Black HD',
            '★★★',
            '🇩🇪 Nordwelle 📺',
            '🇩🇪 Nordwelle 🇩🇪',
            '❤️ Love Radio ❤️',
            '★ Orb ★',
            '|DE| KWF',
        ]) {
            expect(isSeparatorEntry(name), name).toBe(false);
        }
    });

    it('extracts the label a header announces', () => {
        expect(separatorLabel('✦●✦ DE • Local RAW ✦●✦')).toBe('DE • Local RAW');
        expect(separatorLabel('##########   ADULT XXX   ##########')).toBe('ADULT XXX');
        expect(separatorLabel('✦●✦|BG| KIDS ✦●✦')).toBe('BG| KIDS');
    });

    it('drops headers and files the channels below them under the header label', () => {
        const result = processChannels([
            makeChannel({ name: 'Welcome' }),
            makeChannel({ name: '✦●✦ DE • ZAVO ✦●✦' }),
            makeChannel({ name: 'ZAVO 1 HD' }),
            makeChannel({ name: 'Channel Two', groupTitle: 'Own Group' }),
            makeChannel({ name: '✦●✦ DE Kinder ✦●✦' }),
            makeChannel({ name: 'MiMO HD' }),
        ]);
        const live = result.channels.filter((c) => !c.isVod);
        expect(live.map((c) => c.original.name)).toEqual([
            'Welcome',
            'ZAVO 1 HD',
            'Channel Two',
            'MiMO HD',
        ]);
        expect(result.separatorCount).toBe(2);
        expect(result.vodCount).toBe(2);
        const byName = new Map(live.map((c) => [c.original.name, c.category]));
        expect(byName.get('Welcome')).toBe('General'); // above the first header
        expect(byName.get('ZAVO 1 HD')).toBe('ZAVO'); // the section's own label, country part dropped
        expect(byName.get('Channel Two')).toBe('Own Group'); // its own group-title wins
        expect(byName.get('MiMO HD')).toBe('Kids');
    });

    it('still groups backups that sit under different headers', () => {
        const result = processChannels([
            makeChannel({ name: '✦●✦ DE • Local RAW ✦●✦' }),
            makeChannel({ name: 'Siebenstern HD' }),
            makeChannel({ name: '✦●✦ FHD+ HEVC & WebTV ✦●✦' }),
            makeChannel({ name: 'Siebenstern FHD' }),
        ]);
        expect(result.backupGroups).toHaveLength(1);
        const names = result.backupGroups[0].channelIndices.map(
            (i) => result.channels[i].original.name,
        );
        expect(names.sort()).toEqual(['Siebenstern FHD', 'Siebenstern HD']);
    });
});

describe('processChannels — lineup region', () => {
    const ch = (name: string, extra: Partial<M3uChannel> = {}): M3uChannel =>
        ({ name, streamUrl: `http://p/${name}`, extras: {}, ...extra }) as M3uChannel;

    it('takes the region from the name tag or the section header, keeping original.countryCode', () => {
        const result = processChannels([
            ch('✦●✦ RO • GENERAL ✦●✦'),
            ch('Pro TV HD'),
            ch('US: VDD HD'),
            ch('Nordwelle HD', { countryCode: 'de' }),
            ch('✦●✦ ADULT XXX ✦●✦'),
            ch('Some Channel'),
        ]);
        const live = result.channels.filter((c) => !c.isVod);
        expect(live.map((c) => [c.original.name, c.region])).toEqual([
            ['Pro TV HD', 'ro'],
            ['US: VDD HD', 'us'],
            ['Nordwelle HD', 'de'],
            ['Some Channel', 'adult'],
        ]);
        expect(live[0].original.countryCode).toBeUndefined();
    });

    it('does not let a section region split backup groups', () => {
        const result = processChannels([
            ch('✦●✦ FHD+ HEVC & WebTV ✦●✦'),
            ch('3kult HD'),
            ch('✦●✦ DE • Local RAW ✦●✦'),
            ch('3kult HDraw'),
        ]);
        expect(result.backupGroups).toHaveLength(1);
        expect(result.backupGroups[0].channelIndices).toHaveLength(2);
    });
});

describe('extractBaseName — feed word only after the quality tag', () => {
    it.each([
        ['KWL RAW HD', 'KWL RAW'],
        ['Elk Sat HD', 'Elk Sat'],
        ['Hearthmark Cable HD', 'Hearthmark Cable'],
        ['Orb Sport HD Cable', 'Orb Sport'],
        ['TORQ HDraw Cable', 'TORQ'],
        ['Telesport 1 HD SAT', 'Telesport 1'],
    ])('%s -> %s', (name, base) => {
        expect(extractBaseName(name)).toBe(base);
    });
});

describe('HD+ / FHD+ feeds join the station', () => {
    it('groups "Super MTK HD+" with the other Super MTK feeds, plain feed primary', () => {
        const ch = (name: string): M3uChannel =>
            ({ name, streamUrl: `http://p/${name}`, extras: {} }) as M3uChannel;
        const result = processChannels([
            ch('Super MTK FHD'),
            ch('Super MTK HD'),
            ch('Super MTK HD+'),
            ch('Super MTK HDraw'),
            ch('MTK FHD+'),
            ch('MTK FHD'),
        ]);
        expect(result.backupGroups).toHaveLength(2);
        const superMTK = result.backupGroups.find((g) => g.channelIndices.includes(0))!;
        expect([...superMTK.channelIndices].sort()).toEqual([0, 1, 2, 3]);
        const mtk = result.backupGroups.find((g) => g.channelIndices.includes(4))!;
        expect(result.channels[mtk.primaryIndex].original.name).toBe('MTK FHD');
        expect(hasFeedMarker('MTK FHD+')).toBe(true);
    });
});

describe('bracketed feed tags and styled letters', () => {
    const ch = (name: string): M3uChannel =>
        ({ name, streamUrl: `http://p/${name}`, extras: {} }) as M3uChannel;

    it('groups transcoded, mobile and HD+ feeds with the station', () => {
        const names = [
            'Orb Sport F1 HDraw',
            'Orb Sport F1 FHD+',
            'Orb Sport F1 HD+',
            'Orb Sport F1 HD',
            'Orb Sport F1 HD (Transcoded)',
            'Orb Sport F1 (Mobil)',
            'Orb Sport F1 UHD',
        ];
        const result = processChannels(names.map(ch));
        const f1 = result.backupGroups.find((g) => g.channelIndices.includes(0))!;
        expect([...f1.channelIndices].sort()).toEqual([0, 1, 2, 3, 4, 5]); // UHD stays its own channel
    });

    it('never makes a transcoded feed the primary while a normal one exists', () => {
        const result = processChannels(
            ['TR: ZENO SPORTS 2 FHD [ʟᴏᴄᴀʟ ᴛʀᴀɴsᴄᴏᴅᴇᴅ]', 'TR: zeNO SPORTS 2 HD'].map(ch),
        );
        expect(result.backupGroups).toHaveLength(1);
        expect(result.channels[result.backupGroups[0].primaryIndex].original.name).toBe(
            'TR: zeNO SPORTS 2 HD',
        );
    });

    it('reads small-caps quality tags', () => {
        expect(extractBaseName('HR-Kanal HDʀᴀᴡ')).toBe('HR-Kanal');
        expect(detectQualityTier('KU| BAWAN TV ᴴᴰ')).toBe('hd');
    });
});

describe('feed tags, degraded feeds and styled letters (review cases)', () => {
    it.each([
        ['Station (Transcoded) HD', 'Station', true],
        ['Station HD (Mobil) 2', 'Station', true],
        ['Station [Local Transcoded]', 'Station', true],
        ['Station HD (Backup)', 'Station', true],
        ['Station Low Quality', 'Station Low Quality', true],
        ['Station (HEVC)', 'Station', false],
        ['Station HD', 'Station', false],
        ['Mobil TV', 'Mobil TV', false],
    ])('%s -> base %s, degraded %s', (name, base, degraded) => {
        expect(extractBaseName(name)).toBe(base);
        expect(isDegradedFeed(name)).toBe(degraded);
    });

    it('reads a glued superscript quality tag and leaves real letters alone', () => {
        expect(extractBaseName('MTKᴴᴰ')).toBe('MTK');
        expect(detectQualityTier('MTKᴴᴰ')).toBe('hd');
        // Cyrillic ғ and Latin ǫ are letters of real alphabets, not styling.
        expect(extractBaseName('Қазақғ HD')).toBe('Қазақғ');
    });
});

describe('delivery words: alternate, web, low-bitrate, codec and frame-rate feeds', () => {
    it.each([
        ['UK: Orb Sports 1 FHD HEVC (Alt 1)', 'UK: Orb Sports 1', false],
        ['UK: Orb Sports 1 50FPS FHD', 'UK: Orb Sports 1', false],
        ['UK: Orb Sports 1 HD HEVC', 'UK: Orb Sports 1', false],
        ['US: VDD (Alt 3)', 'US: VDD', false],
        ['Kanalo 1 HD (Web)', 'Kanalo 1', false],
        ['Kanalo 1 FHD Low (HEVC)', 'Kanalo 1', true],
        ['Kanalo 1 HD (Low)', 'Kanalo 1', true],
        ['Slow Seaside HD', 'Slow Seaside', false],
        ['Low Tide TV', 'Low Tide TV', false],
    ])('%s -> base %s, degraded %s', (name, base, degraded) => {
        expect(extractBaseName(name)).toBe(base);
        expect(isDegradedFeed(name)).toBe(degraded);
        expect(hasFeedMarker(name)).toBe(name !== 'Slow Seaside HD' && name !== 'Low Tide TV');
    });

    it('groups every feed of a station and keeps the clean one primary', () => {
        const names = [
            'UK: Orb Sports 1 FHD HEVC (Alt 1)',
            'UK: Orb Sports 1 50FPS FHD',
            'UK: Orb Sports 1 FHD',
            'UK: Orb Sports 1 HD HEVC',
        ];
        const result = processChannels(names.map((name) => makeChannel({ name })));
        expect(result.backupGroups).toHaveLength(1);
        expect(result.backupGroups[0].channelIndices).toHaveLength(4);
        expect(result.channels[result.backupGroups[0].primaryIndex].original.name).toBe(
            'UK: Orb Sports 1 FHD',
        );
    });
});

describe('backup groups across provider sections', () => {
    it('groups a country-tagged and an untagged listing of one station', () => {
        const result = processChannels([
            makeChannel({ name: 'AT: Bergland 1 HD' }),
            makeChannel({ name: 'Bergland 1 HDraw' }),
            makeChannel({ name: '[Bouquet] Bergland 1 HD' }),
        ]);
        expect(result.backupGroups).toHaveLength(1);
        expect(result.backupGroups[0].channelIndices).toHaveLength(3);
    });

    it('keeps stations of different name-tagged countries apart', () => {
        const result = processChannels([
            makeChannel({ name: 'UK: Chronik' }),
            makeChannel({ name: 'UK: Chronik HD' }),
            makeChannel({ name: 'US: Chronik' }),
            makeChannel({ name: 'US: Chronik FHD' }),
        ]);
        expect(result.backupGroups).toHaveLength(2);
        for (const group of result.backupGroups) {
            const tags = new Set(
                group.channelIndices.map((i) => result.channels[i].original.name.slice(0, 3)),
            );
            expect(tags.size).toBe(1);
        }
    });
});

describe('bouquets that mix genres', () => {
    const station = (name: string, groupTitle: string): M3uChannel =>
        makeChannel({ name, groupTitle });

    it('files each station under its own genre and drops the bouquet category', () => {
        const result = processChannels([
            station('Aquilant', 'DE News'),
            station('Pino Jr.', 'DE Kinder'),
            station('Musa', 'DE Doku'),
            station('Arenaplus', 'DE Sport'),
            station('[Rivage] Aquilant HD', 'Rivage+'),
            station('[Rivage] Pino Jr. HD', 'Rivage+'),
            station('[Rivage] Musa HD', 'Rivage+'),
            station('[Rivage] Arenaplus', 'Rivage+'),
            station('[Rivage] Hafen Kanal', 'Rivage+'),
        ]);
        const categories = result.channels.map((c) => c.category);
        expect(categories.slice(4)).toEqual(['News', 'Kids', 'Documentary', 'Sports', 'General']);
        expect(result.categories.map((c) => c.normalizedName)).not.toContain('Rivage+');
    });

    it('keeps a mixed bouquet the stored lineup hides', () => {
        const result = processChannels(
            [
                station('Aquilant', 'DE News'),
                station('Pino Jr.', 'DE Kinder'),
                station('Musa', 'DE Doku'),
                station('[Rivage] Aquilant HD', 'Rivage+'),
                station('[Rivage] Pino Jr. HD', 'Rivage+'),
                station('[Rivage] Musa HD', 'Rivage+'),
            ],
            { keepCategories: new Set(['Rivage+']) },
        );
        expect(result.channels.slice(3).map((c) => c.category)).toEqual([
            'Rivage+',
            'Rivage+',
            'Rivage+',
        ]);
    });

    it('keeps a large bouquet with only a few stray genre words', () => {
        const filler = Array.from({ length: 20 }, (_, i) =>
            station(`[Rivage] Hafen ${String.fromCharCode(65 + i)}`, 'Rivage+'),
        );
        const result = processChannels([
            station('Aquilant', 'DE News'),
            station('Pino Jr.', 'DE Kinder'),
            station('Musa', 'DE Doku'),
            station('[Rivage] Aquilant HD', 'Rivage+'),
            station('[Rivage] Pino Jr. HD', 'Rivage+'),
            station('[Rivage] Musa HD', 'Rivage+'),
            ...filler,
        ]);
        expect(new Set(result.channels.slice(3).map((c) => c.category))).toEqual(
            new Set(['Rivage+']),
        );
    });

    it('keeps a bouquet whose stations share one or two genres', () => {
        const result = processChannels([
            station('Orb Krimi', 'DE Serien'),
            station('Orb Atlantik', 'DE Serien'),
            station('[OrbPlus] Orb Krimi HD', 'OrbPlus'),
            station('[OrbPlus] Orb Atlantik HD', 'OrbPlus'),
            station('[OrbPlus] Orb Eins', 'OrbPlus'),
        ]);
        expect(result.channels.slice(2).map((c) => c.category)).toEqual([
            'OrbPlus',
            'OrbPlus',
            'OrbPlus',
        ]);
    });
});
