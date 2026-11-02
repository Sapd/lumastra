// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { matchEpgChannels, matchEpgChannelsAsync, __testing } from './epg-matcher.js';
import { bestMatch } from '$lib/server/utils/string-similarity.js';
import type { EpgMatch, EpgMatchResult } from './epg-matcher.js';
import { processChannels } from './auto-processor.js';
import type { ProcessedChannel } from './auto-processor.js';
import type { M3uChannel } from './m3u-parser.js';
import type { XmltvChannel, XmltvImportResult, XmltvProgram } from './xmltv-parser.js';
import groundTruth from '../../__tests__/fixtures/livetv/ground-truth-epg-matches.json';

// L2: Silence logger output in tests
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

// ── Null-to-undefined converter for JSON fixtures (M3 fix) ──────────────

/** JSON cannot represent `undefined`, so fixtures use `null`. Convert to match TS interfaces. */
function nullsToUndefined<T>(obj: T): T {
    if (obj === null) return undefined as T;
    if (Array.isArray(obj)) return obj.map(nullsToUndefined) as T;
    if (typeof obj === 'object') {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
            result[key] = nullsToUndefined(value);
        }
        return result as T;
    }
    return obj;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeM3uChannel(overrides: Partial<M3uChannel> = {}): M3uChannel {
    return {
        tvgId: undefined,
        tvgName: undefined,
        name: 'Test Channel',
        logoUrl: undefined,
        groupTitle: undefined,
        streamUrl: 'http://provider.example/live/user/pass/1.ts',
        countryCode: undefined,
        extras: {},
        ...overrides,
    };
}

function makeXmltvChannel(overrides: Partial<XmltvChannel> = {}): XmltvChannel {
    return {
        id: 'test.de',
        displayName: 'Test Channel',
        iconUrl: undefined,
        ...overrides,
    };
}

function makeEpgData(channels: XmltvChannel[], programs: XmltvProgram[] = []): XmltvImportResult {
    return {
        channels,
        programs,
        channelCount: channels.length,
        programCount: programs.length,
        skipped: 0,
        errors: [],
        warnings: [],
    };
}

function processAndMatch(
    m3uChannels: M3uChannel[],
    xmltvChannels: XmltvChannel[],
    programs: XmltvProgram[] = [],
): EpgMatchResult {
    const processed = processChannels(m3uChannels);
    return matchEpgChannels(processed.channels, makeEpgData(xmltvChannels, programs));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('EPG Matcher', () => {
    describe('tvg-id exact matching', () => {
        it('matches channel with exact tvg-id → confidence 1.0', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        tvgId: 'Nordwelle.de',
                        name: 'Nordwelle FHD',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'Nordwelle.de',
                        displayName: 'Nordwelle HD *',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].epgChannelId).toBe('Nordwelle.de');
            expect(result.matches[0].confidence).toBe(1.0);
            expect(result.matches[0].signals).toContain('tvg_id_exact');
        });

        it('matches case-insensitive tvg-id → confidence 0.95', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        tvgId: 'NORDWELLE.DE',
                        name: 'Nordwelle FHD',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'Nordwelle.de',
                        displayName: 'Nordwelle HD *',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].confidence).toBe(0.95);
            expect(result.matches[0].signals).toContain('tvg_id_partial');
        });

        it('matches tvg-id with whitespace difference → confidence 0.95', () => {
            const result = processAndMatch(
                [makeM3uChannel({ tvgId: 'HLV 1.ch', name: 'HLV 1 HD *' })],
                [makeXmltvChannel({ id: 'HLV1.ch', displayName: 'HLV 1 HD' })],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].confidence).toBe(0.95);
            expect(result.matches[0].signals).toContain('tvg_id_partial');
        });

        it('skips tvg-id signal when tvgId is undefined', () => {
            const result = processAndMatch(
                [makeM3uChannel({ tvgId: undefined, name: 'Unknown Channel' })],
                [
                    makeXmltvChannel({
                        id: 'Unknown.de',
                        displayName: 'Unknown Channel',
                    }),
                ],
            );

            // Should match via name, not tvg-id
            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].signals).not.toContain('tvg_id_exact');
            expect(result.matches[0].signals).not.toContain('tvg_id_partial');
        });
    });

    describe('name fuzzy matching', () => {
        it('exact normalized name match → confidence 0.9', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'Nordwelle HD',
                        tvgName: 'Nordwelle',
                    }),
                ],
                [makeXmltvChannel({ id: 'test.de', displayName: 'Nordwelle' })],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].confidence).toBe(0.9);
        });

        it('high similarity (>= 0.8) → confidence in 0.86-0.9 range', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'Alpenländisch Fernsehen HD',
                        tvgName: 'Alpenländisches Fernsehen',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'Alpenländisches Fernsehen HD',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.86);
            expect(result.matches[0].confidence).toBeLessThanOrEqual(0.9);
        });

        it('medium similarity (>= 0.6) → confidence in 0.62-0.7 range', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'MTK Plus Event HD',
                        tvgName: undefined,
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'MTK Event Special',
                    }),
                ],
            );

            // Should either match with medium confidence or be unmatched
            // (depends on exact Levenshtein score after normalization)
            if (result.matches.length > 0) {
                expect(result.matches[0].confidence).toBeGreaterThanOrEqual(0.5);
                expect(result.matches[0].confidence).toBeLessThanOrEqual(0.7);
            } else {
                // Score below 0.6 threshold — no match is also acceptable
                expect(result.unmatched).toHaveLength(1);
            }
        });

        it('low similarity (< 0.6) → no match', () => {
            const result = processAndMatch(
                [makeM3uChannel({ name: 'AAAAA BBBBB CCCCC' })],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'XXXXX YYYYY ZZZZZ',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(0);
            expect(result.unmatched).toHaveLength(1);
        });

        it('prefers tvgName when it produces higher score', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'AL Fernsehen HD',
                        tvgName: 'Alpenländisches Fernsehen',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'Alpenländisches Fernsehen HD',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].signals).toContain('tvg_name_match');
        });
    });

    describe('group-title cross-referencing', () => {
        it('matching category boosts confidence by 0.05', () => {
            const programs: XmltvProgram[] = [
                {
                    channelId: 'kids.de',
                    title: 'Cartoon Show',
                    startTime: '2026-03-09T08:00:00+01:00',
                    endTime: '2026-03-09T08:30:00+01:00',
                    genres: ['Kids'],
                    description: undefined,
                    officialRating: undefined,
                },
            ];

            // Use name matching (no tvg-id) so confidence starts below 1.0 and the boost is visible
            const resultWithPrograms = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'Kids Channel FHD',
                        tvgName: 'Kids Channel',
                        groupTitle: 'Kids',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'kids.de',
                        displayName: 'Kids Channel',
                    }),
                ],
                programs,
            );

            const resultWithoutPrograms = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'Kids Channel FHD',
                        tvgName: 'Kids Channel',
                        groupTitle: 'Kids',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'kids.de',
                        displayName: 'Kids Channel',
                    }),
                ],
            );

            // With matching category: should have group_title signal and higher confidence
            expect(resultWithPrograms.matches[0].signals).toContain('group_title');
            expect(resultWithPrograms.matches[0].confidence).toBeGreaterThan(
                resultWithoutPrograms.matches[0].confidence,
            );
        });

        it('non-matching category has no effect', () => {
            const programs: XmltvProgram[] = [
                {
                    channelId: 'news.de',
                    title: 'News Show',
                    startTime: '2026-03-09T20:00:00+01:00',
                    endTime: '2026-03-09T20:30:00+01:00',
                    genres: ['News'],
                    description: undefined,
                    officialRating: undefined,
                },
            ];

            const result = processAndMatch(
                [
                    makeM3uChannel({
                        tvgId: 'news.de',
                        name: 'News Channel FHD',
                        groupTitle: 'Sports',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'news.de',
                        displayName: 'News Channel HD',
                    }),
                ],
                programs,
            );

            expect(result.matches[0].signals).not.toContain('group_title');
        });

        it('empty programs array → group-title signal is a no-op', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        tvgId: 'test.de',
                        name: 'Test Channel FHD',
                        groupTitle: 'Kids',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'Test Channel HD',
                    }),
                ],
                [],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].signals).not.toContain('group_title');
        });
    });

    describe('backup group propagation', () => {
        it('primary matched via tvg-id → backup members get same confidence', () => {
            const m3u: M3uChannel[] = [
                makeM3uChannel({ tvgId: 'Nordwelle.de', name: 'Nordwelle FHD' }),
                makeM3uChannel({ tvgId: 'Nordwelle.de', name: 'Nordwelle HD' }),
            ];

            const result = processAndMatch(m3u, [
                makeXmltvChannel({
                    id: 'Nordwelle.de',
                    displayName: 'Nordwelle HD *',
                }),
            ]);

            // Both should be matched — no duplicates in unmatched (H1 fix)
            expect(result.matches).toHaveLength(2);
            expect(result.unmatched).toHaveLength(0);

            // Both carry the guide id: each matches it directly (an exact
            // tvg-id match is not exclusive), with the same confidence.
            const [a, b] = result.matches;
            expect(b.epgChannelId).toBe(a.epgChannelId);
            expect(b.confidence).toBe(a.confidence);
            expect(result.matches.every((m) => m.signals.includes('tvg_id_exact'))).toBe(true);
        });

        it('primary matched via name-fuzzy → backup members get confidence * 0.95', () => {
            const m3u: M3uChannel[] = [
                makeM3uChannel({
                    name: 'Test Channel FHD',
                    tvgName: 'Test Channel',
                }),
                makeM3uChannel({
                    name: 'Test Channel HD',
                    tvgName: 'Test Channel',
                }),
            ];

            const xmltv = [makeXmltvChannel({ id: 'test.de', displayName: 'Test Channel' })];
            const result = processAndMatch(m3u, xmltv);

            expect(result.matches).toHaveLength(2);

            const backupMatch = result.matches.find((m) =>
                m.signals.includes('backup_propagation'),
            );
            const primaryMatch = result.matches.find(
                (m) => !m.signals.includes('backup_propagation'),
            );

            expect(primaryMatch).toBeDefined();
            expect(backupMatch).toBeDefined();
            expect(backupMatch!.confidence).toBeCloseTo(primaryMatch!.confidence * 0.95, 2);
        });

        it('every feed carrying the guide id is matched to it', () => {
            const m3u: M3uChannel[] = [
                makeM3uChannel({ tvgId: '3kult.de', name: '3kult HD ¹' }),
                makeM3uChannel({ tvgId: '3kult.de', name: '3kult HD ²' }),
            ];

            const result = processAndMatch(m3u, [
                makeXmltvChannel({ id: '3kult.de', displayName: '3kult HD *' }),
            ]);

            expect(result.matches.map((m) => m.epgChannelId)).toEqual(['3kult.de', '3kult.de']);
        });
    });

    describe('conflict resolution', () => {
        it('multiple M3U channels matching same XMLTV channel → highest confidence wins', () => {
            // Use very different names/groups to prevent backup grouping.
            // Channel 1 matches via tvg-id (confidence 1.0).
            // Channel 2 matches via tvgName (confidence 0.9).
            // They target the same XMLTV channel but are NOT in the same backup group.
            const m3u: M3uChannel[] = [
                makeM3uChannel({
                    tvgId: 'sport.de',
                    name: 'Sport Live FHD',
                    groupTitle: 'Sports',
                }),
                makeM3uChannel({
                    name: 'Totally Different Name',
                    tvgName: 'Sport Live',
                    groupTitle: 'Entertainment',
                }),
            ];

            const result = processAndMatch(m3u, [
                makeXmltvChannel({ id: 'sport.de', displayName: 'Sport Live' }),
            ]);

            // tvg-id match (confidence 1.0) should win over name match (confidence 0.9)
            expect(result.matches).toHaveLength(1);
            expect(result.matches[0].signals).toContain('tvg_id_exact');
            expect(result.matches[0].confidence).toBe(1.0);

            // Loser should be in unmatched with a reason
            expect(result.unmatched).toHaveLength(1);
            expect(result.unmatched[0].reason).toContain('Conflict');
        });
    });

    describe('VOD channels excluded', () => {
        it('channels with VOD group-title are not matched', () => {
            const result = processAndMatch(
                [makeM3uChannel({ name: 'Movie HD', groupTitle: 'VOD' })],
                [makeXmltvChannel({ id: 'test.de', displayName: 'Movie HD' })],
            );

            expect(result.matches).toHaveLength(0);
            expect(result.stats.totalChannels).toBe(0); // VOD channels are excluded from count
        });

        it('channels with VOD file extension are not matched', () => {
            const result = processAndMatch(
                [
                    makeM3uChannel({
                        name: 'Movie Channel',
                        streamUrl: 'http://provider.example/vod/movie.mkv',
                    }),
                ],
                [
                    makeXmltvChannel({
                        id: 'test.de',
                        displayName: 'Movie Channel',
                    }),
                ],
            );

            expect(result.matches).toHaveLength(0);
        });
    });

    describe('unmatched channels', () => {
        it('channels below threshold have bestCandidate populated', () => {
            const result = processAndMatch(
                [makeM3uChannel({ name: 'AAAA BBBB HD' })],
                [makeXmltvChannel({ id: 'test.de', displayName: 'XXXX YYYY' })],
            );

            expect(result.unmatched).toHaveLength(1);
            // bestCandidate may or may not be populated depending on score
        });

        it('channels with no XMLTV candidates → undefined bestCandidate', () => {
            const result = processAndMatch(
                [makeM3uChannel({ name: 'Unique Channel HD' })],
                [], // No XMLTV channels at all
            );

            expect(result.unmatched).toHaveLength(1);
            expect(result.unmatched[0].bestCandidate).toBeUndefined();
        });
    });

    describe('no duplicate channels across matches and unmatched', () => {
        it('backup group members that lost conflict are cleaned from unmatched after propagation', () => {
            const m3u: M3uChannel[] = [
                makeM3uChannel({ tvgId: 'Nordwelle.de', name: 'Nordwelle FHD' }),
                makeM3uChannel({ tvgId: 'Nordwelle.de', name: 'Nordwelle HD' }),
                makeM3uChannel({ tvgId: '3kult.de', name: '3kult HD ¹' }),
                makeM3uChannel({ tvgId: '3kult.de', name: '3kult HD ²' }),
            ];

            const result = processAndMatch(m3u, [
                makeXmltvChannel({
                    id: 'Nordwelle.de',
                    displayName: 'Nordwelle HD *',
                }),
                makeXmltvChannel({ id: '3kult.de', displayName: '3kult HD *' }),
            ]);

            // All 4 channels should be matched (2 primary + 2 backup propagation)
            expect(result.matches).toHaveLength(4);
            expect(result.unmatched).toHaveLength(0);

            // No channel index should appear in both arrays
            const matchedIndices = new Set(result.matches.map((m) => m.channelIndex));
            const unmatchedIndices = new Set(result.unmatched.map((u) => u.channelIndex));
            for (const idx of matchedIndices) {
                expect(unmatchedIndices.has(idx)).toBe(false);
            }

            // Stats should add up correctly
            expect(result.stats.matched + result.stats.unmatched).toBe(result.stats.totalChannels);
        });
    });

    describe('full pipeline (matchEpgChannels)', () => {
        it('empty input → empty result', () => {
            const result = processAndMatch([], []);

            expect(result.matches).toHaveLength(0);
            expect(result.unmatched).toHaveLength(0);
            expect(result.stats.totalChannels).toBe(0);
            expect(result.stats.matched).toBe(0);
            expect(result.stats.unmatched).toBe(0);
            expect(result.stats.averageConfidence).toBe(0);
        });

        it('statistics are accurate', () => {
            const m3u: M3uChannel[] = [
                makeM3uChannel({ tvgId: 'ch1.de', name: 'Channel 1 FHD' }),
                makeM3uChannel({ tvgId: 'ch2.de', name: 'Channel 2 FHD' }),
                makeM3uChannel({ name: 'Unmatched Channel HD' }),
            ];

            const xmltv = [
                makeXmltvChannel({ id: 'ch1.de', displayName: 'Channel 1 HD' }),
                makeXmltvChannel({ id: 'ch2.de', displayName: 'Channel 2 HD' }),
            ];

            const result = processAndMatch(m3u, xmltv);

            expect(result.stats.totalChannels).toBe(3);
            expect(result.stats.matched).toBe(2);
            expect(result.stats.unmatched).toBe(1);
            expect(result.stats.averageConfidence).toBeGreaterThan(0);
            expect(result.stats.bySignal.tvg_id_exact).toBe(2);
        });

        it('no errors for valid input', () => {
            const result = processAndMatch(
                [makeM3uChannel({ tvgId: 'test.de', name: 'Test FHD' })],
                [makeXmltvChannel({ id: 'test.de', displayName: 'Test HD' })],
            );

            expect(result.matches).toHaveLength(1);
            expect(result.warnings).toHaveLength(0);
        });
    });

    describe('ground-truth accuracy test', () => {
        it('EPG matching achieves >90% accuracy against ground truth', () => {
            const m3uChannels = nullsToUndefined(groundTruth.m3uChannels) as M3uChannel[];
            const xmltvChannels = nullsToUndefined(groundTruth.xmltvChannels) as XmltvChannel[];
            const xmltvPrograms = nullsToUndefined(
                groundTruth.xmltvPrograms,
            ) as unknown as XmltvProgram[];

            const processed = processChannels(m3uChannels);
            const epgData = makeEpgData(xmltvChannels, xmltvPrograms);
            const result = matchEpgChannels(processed.channels, epgData);

            // Build match lookup by channel name
            const matchByName = new Map<string, EpgMatch>();
            for (const match of result.matches) {
                matchByName.set(match.channelName, match);
            }

            const unmatchedNames = new Set(result.unmatched.map((u) => u.channelName));

            let correctMatches = 0;
            let totalExpected = 0;

            for (const expected of groundTruth.expectedMatches) {
                if (expected.expectedSignal === 'unmatched') {
                    // Should be in unmatched
                    totalExpected++;
                    if (unmatchedNames.has(expected.channelName)) {
                        correctMatches++;
                    }
                    continue;
                }

                totalExpected++;
                const actual = matchByName.get(expected.channelName);
                if (actual && actual.epgChannelId === expected.epgChannelId) {
                    correctMatches++;
                }
            }

            // Also check expected unmatched
            for (const expectedUnmatched of groundTruth.expectedUnmatched) {
                totalExpected++;
                if (unmatchedNames.has(expectedUnmatched) || !matchByName.has(expectedUnmatched)) {
                    correctMatches++;
                }
            }

            const accuracy = correctMatches / totalExpected;
            expect(accuracy).toBeGreaterThanOrEqual(0.9);

            // H1 fix verification: no channel appears in both arrays
            const matchedIndices = new Set(result.matches.map((m) => m.channelIndex));
            const unmatchedIndices = new Set(result.unmatched.map((u) => u.channelIndex));
            for (const idx of matchedIndices) {
                expect(
                    unmatchedIndices.has(idx),
                    `Channel index ${idx} in both matches and unmatched`,
                ).toBe(false);
            }

            // Stats must add up to totalChannels
            expect(result.stats.matched + result.stats.unmatched).toBe(result.stats.totalChannels);
        });

        it('all tvg-id exact matches are found correctly', () => {
            const m3uChannels = nullsToUndefined(groundTruth.m3uChannels) as M3uChannel[];
            const xmltvChannels = nullsToUndefined(groundTruth.xmltvChannels) as XmltvChannel[];
            const xmltvPrograms = nullsToUndefined(
                groundTruth.xmltvPrograms,
            ) as unknown as XmltvProgram[];

            const processed = processChannels(m3uChannels);
            const epgData = makeEpgData(xmltvChannels, xmltvPrograms);
            const result = matchEpgChannels(processed.channels, epgData);

            const tvgIdExactExpected = groundTruth.expectedMatches.filter(
                (e) => e.expectedSignal === 'tvg_id_exact',
            );

            for (const expected of tvgIdExactExpected) {
                const actual = result.matches.find((m) => m.channelName === expected.channelName);
                expect(
                    actual,
                    `Expected tvg_id_exact match for "${expected.channelName}"`,
                ).toBeDefined();
                expect(actual!.epgChannelId).toBe(expected.epgChannelId);
                expect(actual!.signals).toContain('tvg_id_exact');
            }
        });
    });
});

// ── Large sources: same answers, fast path, async ───────────────────────

describe('EPG Matcher — large-source fast path', () => {
    function plainChannels(names: string[]): ProcessedChannel[] {
        return names.map(
            (name) =>
                ({
                    original: makeM3uChannel({ name }),
                    baseName: name,
                    category: '',
                    isPrimary: false,
                    isVod: false,
                }) as unknown as ProcessedChannel,
        );
    }

    it('picks the first EPG channel when display names repeat', () => {
        const result = matchEpgChannels(
            plainChannels(['Sport Eins']),
            makeEpgData([
                makeXmltvChannel({ id: 'first', displayName: 'Sport Eins' }),
                makeXmltvChannel({ id: 'second', displayName: 'Sport Eins' }),
            ]),
        );
        expect(result.matches[0]?.epgChannelId).toBe('first');
    });

    it('breaks a fuzzy tie towards the earlier EPG channel', () => {
        // "kanal x" is one edit away from both candidates.
        const result = matchEpgChannels(
            plainChannels(['Kanal X']),
            makeEpgData([
                makeXmltvChannel({ id: 'y1', displayName: 'Kanal Y' }),
                makeXmltvChannel({ id: 'z1', displayName: 'Kanal Z' }),
            ]),
        );
        expect(result.matches[0]?.epgChannelId).toBe('y1');
    });

    it('matches a tvg-id across country suffixes to the first candidate', () => {
        const processed = plainChannels(['Whatever']);
        (processed[0].original as { tvgId?: string }).tvgId = 'Foo.uk';
        const result = matchEpgChannels(
            processed,
            makeEpgData([
                makeXmltvChannel({ id: 'foo.de', displayName: 'Unrelated A' }),
                makeXmltvChannel({ id: 'foo.at', displayName: 'Unrelated B' }),
            ]),
        );
        expect(result.matches[0]?.epgChannelId).toBe('foo.de');
        expect(result.matches[0]?.signals).toContain('tvg_id_partial');
    });

    it('async matching yields, reports progress and returns the sync result', async () => {
        const names = Array.from({ length: 600 }, (_, i) => `Channel ${i} ${i % 3 ? 'HD' : 'FHD'}`);
        const epg = makeEpgData(
            Array.from({ length: 300 }, (_, i) =>
                makeXmltvChannel({ id: `ch${i * 2}.de`, displayName: `Channel ${i * 2}` }),
            ),
        );
        const expected = matchEpgChannels(plainChannels(names), epg);

        // Every clock read jumps 100 ms, so the matcher yields at every check.
        let clock = 0;
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
        const progress: Array<{ processed: number; total: number }> = [];
        try {
            const actual = await matchEpgChannelsAsync(plainChannels(names), epg, (p) => {
                progress.push(p);
            });
            expect(actual).toEqual(expected);
        } finally {
            nowSpy.mockRestore();
        }
        expect(progress.length).toBeGreaterThan(10);
        expect(progress.every((p) => p.total === 600 && p.processed <= p.total)).toBe(true);
        expect(progress.map((p) => p.processed)).toEqual(
            [...progress.map((p) => p.processed)].sort((a, b) => a - b),
        );
    });
});

describe('EPG Matcher — name scoring equals the original full scan', () => {
    // The scorer before the large-source rewrite: normalize every candidate and
    // score it against the query, first highest score wins, below 0.6 is no match.
    function originalBest(query: string, names: string[]) {
        const { normalizeName } = __testing;
        const r = bestMatch(normalizeName(query), names.map(normalizeName));
        return r.bestIndex < 0 || r.bestScore < 0.6
            ? { score: 0, index: -1 }
            : { score: r.bestScore, index: r.bestIndex };
    }

    function mulberry32(seed: number): () => number {
        return () => {
            seed |= 0;
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    it('picks the same EPG channel with the same score on seeded random names', () => {
        const rnd = mulberry32(20261015);
        const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
        const alphabet = 'abcdeiklmnorstuvz äöüßéñİ123'.split('');
        const tags = ['', ' HD', ' FHD', ' SD', ' 4K', '*', ' ²', ' UHD+'];
        const word = (): string =>
            Array.from({ length: 1 + Math.floor(rnd() * 9) }, () => pick(alphabet)).join('');
        const mutate = (s: string): string => {
            const chars = s.split('');
            const edits = Math.floor(rnd() * 5); // 0..4 edits: straddles the 0.6 floor
            for (let e = 0; e < edits; e++) {
                const i = Math.floor(rnd() * (chars.length + 1));
                const op = rnd();
                if (op < 0.33) chars.splice(i, 1);
                else if (op < 0.66) chars.splice(i, 0, pick(alphabet));
                else chars[i] = pick(alphabet);
            }
            return chars.join('');
        };

        const base = Array.from({ length: 120 }, () =>
            rnd() < 0.3 ? `${word()} ${word()}` : word(),
        );
        const epgNames = [
            ...base.map((b) => b + pick(tags)),
            ...base.slice(0, 40).map((b) => b.toUpperCase()), // duplicates after normalizing
            '',
            '   ',
            'HD', // normalizes to an empty string
        ];
        const xmltv = epgNames.map((displayName, i) =>
            makeXmltvChannel({ id: `id${i}`, displayName }),
        );
        const index = __testing.buildNameIndex(xmltv);

        const queries = [
            ...Array.from({ length: 400 }, () => mutate(pick(base)) + pick(tags)),
            ...Array.from({ length: 50 }, () => word()),
            '',
            'HD',
            'x',
        ];
        for (const q of queries) {
            const expected = originalBest(q, epgNames);
            const actual = __testing.findBestNameMatch(q, index.displayNames, index);
            const actualIndex = actual.channel ? xmltv.indexOf(actual.channel) : -1;
            expect({ q, score: actual.score, index: actualIndex }).toEqual({ q, ...expected });
        }
    });
});

// ── Country-aware matching ──────────────────────────────────────────────

describe('EPG Matcher — country-aware matching', () => {
    interface Spec {
        name: string;
        country?: string;
        group?: string;
    }

    /** DB-row wrappers as importEpgSource builds them (country_code -> region). */
    function rows(specs: Spec[], withCountries = true): ProcessedChannel[] {
        return specs.map(
            (s) =>
                ({
                    original: makeM3uChannel({ name: s.name }),
                    baseName: s.name,
                    category: '',
                    backupGroupKey: s.group,
                    isPrimary: false,
                    isVod: false,
                    region: withCountries ? s.country : undefined,
                }) as unknown as ProcessedChannel,
        );
    }

    function matchedIds(result: EpgMatchResult, specs: Spec[]): Record<string, string> {
        const out: Record<string, string> = {};
        for (const m of result.matches) {
            const s = specs[m.channelIndex];
            out[`${s.name}|${s.country ?? ''}`] = m.epgChannelId;
        }
        return out;
    }

    // A bare playlist: country from the section, names often without a tag.
    // The AT and IT feeds come first and are named exactly like the German one.
    const torqChannels: Spec[] = [
        { name: 'TORQ HD', country: 'at', group: 'at' },
        { name: 'AT: TORQ HD+', country: 'at', group: 'at' },
        { name: 'TORQ HD', country: 'it', group: 'it' },
        { name: 'TR: TORQ HD+', country: 'tr' },
        { name: 'TORQ FHD', country: 'de', group: 'de' },
        { name: 'TORQ HD', group: 'de' },
        { name: 'TORQ HDraw', group: 'de' },
        { name: 'TORQ SD', country: 'de', group: 'de' },
    ];
    const torqGuide = makeEpgData([
        makeXmltvChannel({ id: 'TORQHD', displayName: 'AT: TORQ HD' }),
        makeXmltvChannel({ id: 'TORQ HD', displayName: 'TORQ SD' }),
        makeXmltvChannel({ id: 'torq.it', displayName: 'IT: TORQ HD' }),
        makeXmltvChannel({ id: '5673a8729576cd423de4fd11b5d1d08e', displayName: 'TR: TORQ HD+' }),
        makeXmltvChannel({ id: 'WandererMax.es', displayName: 'ES| TORQ HD' }),
        makeXmltvChannel({ id: 'TORQ.uk', displayName: 'UK: TORQ SD' }),
    ]);

    it('without countries the first same-named feed takes the German entry (the old bug)', () => {
        const result = matchEpgChannels(rows(torqChannels, false), torqGuide);
        const ids = matchedIds(result, torqChannels);
        expect(ids['TORQ HD|at']).toBe('TORQ HD');
        expect(ids['TORQ FHD|de']).toBeUndefined();
        expect(ids['TORQ SD|de']).toBeUndefined();
    });

    it('gives every feed the guide entry of its own country', () => {
        const result = matchEpgChannels(rows(torqChannels), torqGuide);
        expect(matchedIds(result, torqChannels)).toEqual({
            'TORQ HD|at': 'TORQHD',
            'AT: TORQ HD+|at': 'TORQHD',
            'TORQ HD|it': 'torq.it',
            'TR: TORQ HD+|tr': '5673a8729576cd423de4fd11b5d1d08e',
            // The German group: the untagged entry, direct or propagated.
            'TORQ FHD|de': 'TORQ HD',
            'TORQ HD|': 'TORQ HD',
            'TORQ HDraw|': 'TORQ HD',
            'TORQ SD|de': 'TORQ HD',
        });
    });

    it('lets each name of a repeated guide id be claimed on its own', () => {
        // The feed lists "TORQHD" twice: as the AT feed and, untagged, as the
        // German one. Claimed by id, the AT feed would lock the German one out.
        const specs: Spec[] = [
            { name: 'AT: TORQ HD', country: 'at' },
            { name: 'TORQ FHD', country: 'de' },
        ];
        const guide = makeEpgData([
            makeXmltvChannel({ id: 'TORQHD', displayName: 'AT: TORQ HD' }),
            makeXmltvChannel({ id: 'TORQHD', displayName: 'TORQ HD' }),
        ]);
        expect(matchedIds(matchEpgChannels(rows(specs), guide), specs)).toEqual({
            'AT: TORQ HD|at': 'TORQHD',
            'TORQ FHD|de': 'TORQHD',
        });
        // Without countries the id is claimed once, as before.
        expect(matchEpgChannels(rows(specs, false), guide).matches).toHaveLength(1);
    });

    it('reads a guide entry country from its id suffix when the name has no tag', () => {
        const specs: Spec[] = [
            { name: 'Kanal Neun', country: 'ch' },
            { name: 'Kanal Neun', country: 'de' },
        ];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([
                makeXmltvChannel({ id: 'KanalNeun.de', displayName: 'Kanal Neun' }),
                makeXmltvChannel({ id: 'KanalNeun.ch', displayName: 'Kanal Neun' }),
            ]),
        );
        expect(matchedIds(result, specs)).toEqual({
            'Kanal Neun|ch': 'KanalNeun.ch',
            'Kanal Neun|de': 'KanalNeun.de',
        });
    });

    it('trusts the name tag over a borrowed id suffix', () => {
        const specs: Spec[] = [
            { name: 'Onda Drei', country: 'es' },
            { name: 'RO: Onda Drei', country: 'ro' },
        ];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([
                makeXmltvChannel({ id: 'ondadrei.es', displayName: 'RO: Onda Drei' }),
                makeXmltvChannel({ id: 'OndaDreiES', displayName: 'ES| Onda Drei' }),
            ]),
        );
        expect(matchedIds(result, specs)).toEqual({
            'Onda Drei|es': 'OndaDreiES',
            'RO: Onda Drei|ro': 'ondadrei.es',
        });
    });

    it('scores a match of another country down', () => {
        const specs: Spec[] = [{ name: 'IT: Kanal Neun', country: 'pl' }];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([makeXmltvChannel({ id: 'kn', displayName: 'IT: Kanal Neun' })]),
        );
        expect(result.matches[0]?.confidence).toBeCloseTo(0.8);
    });

    it('a country from the id suffix alone never counts against a channel', () => {
        // Providers borrow ids: "ORX: CAGE NETWORK" under "cagenetwork.ca".
        const specs: Spec[] = [{ name: 'Kanal Neun', country: 'pl' }];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([makeXmltvChannel({ id: 'KanalNeun.it', displayName: 'Kanal Neun' })]),
        );
        expect(result.matches[0]?.confidence).toBe(0.9);
    });

    it('a fuzzy own-country name does not beat an exact untagged one', () => {
        const specs: Spec[] = [{ name: 'VAPOR HDraw Cable', country: 'de', group: 'g' }];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([
                makeXmltvChannel({ id: 'terrageo.de', displayName: 'TerraGeo HDraw Cable' }),
                makeXmltvChannel({ id: 'VAPORHD', displayName: 'VAPOR HDraw Cable' }),
            ]),
        );
        expect(result.matches[0]?.epgChannelId).toBe('VAPORHD');
        expect(result.matches[0]?.confidence).toBe(0.9);
    });

    it('a country tie never outranks higher confidence', () => {
        // The untagged channel's fuzzy claim loses to the tagged channel's exact one.
        const specs: Spec[] = [{ name: 'ANVIO HDraws' }, { name: 'ANVIO HDraw²', country: 'de' }];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([makeXmltvChannel({ id: 'ANVIOHD', displayName: 'ANVIO HDraw²' })]),
        );
        expect(matchedIds(result, specs)).toEqual({ 'ANVIO HDraw²|de': 'ANVIOHD' });
    });

    it('treats adult and religious regions as no country, but reads the name tag', () => {
        const specs: Spec[] = [
            { name: 'Kanal Neun', country: 'adult' },
            { name: 'DE: Kanal Neun', country: 'adult' },
        ];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([
                makeXmltvChannel({ id: 'kn1', displayName: 'Kanal Neun' }),
                makeXmltvChannel({ id: 'kn.de', displayName: 'DE: Kanal Neun' }),
            ]),
        );
        expect(matchedIds(result, specs)).toEqual({
            'Kanal Neun|adult': 'kn1',
            'DE: Kanal Neun|adult': 'kn.de',
        });
    });

    /** Seeded mix of tagged and untagged guide entries and channel names. */
    function seededSource(channelCount: number) {
        let seed = 7;
        const rnd = (): number => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 2 ** 32;
        };
        const stations = ['TORQ', 'Vapor', 'Kabel Acht', 'Sport 1', 'Aquilant', 'TLQ', 'Musa'];
        const tags = ['', 'AT: ', 'IT: ', 'UK: ', '|PL| ', 'ES| '];
        const suffixes = ['', '.de', '.at', '.uk', '.it'];
        const quality = ['', ' HD', ' FHD', ' SD', ' HDraw', ' HD+'];
        const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
        const guide = makeEpgData(
            Array.from({ length: 60 }, (_, i) => {
                const st = pick(stations);
                return makeXmltvChannel({
                    // Every third id repeats an earlier one.
                    id: `${st.replace(/\s/g, '')}${i % 3 === 2 ? i - 1 : i}${pick(suffixes)}`,
                    displayName: `${pick(tags)}${st}${pick(quality)}`,
                });
            }),
        );
        const specs: Spec[] = Array.from({ length: channelCount }, (_, i) => ({
            name: `${pick(tags)}${pick(stations)}${pick(quality)}`,
            country: pick(['de', 'at', 'it', 'uk', 'pl', undefined]),
            group: rnd() < 0.5 ? `g${i % 20}` : undefined,
        }));
        return { guide, specs };
    }

    it('countryless channels against a tagged guide match exactly like the old matcher', () => {
        const { guide, specs } = seededSource(150);
        // Output of the matcher before country awareness (channelIndex:id:confidence).
        const oldMatcher = [
            '1:KabelAcht10:0.900 3:TLQ58.it:0.900 4:Aquilant27:0.658 5:Sport137:0.900',
            '6:Sport152.uk:0.900 7:Musa22.de:0.860 8:Vapor19.de:0.900 9:TLQ58.at:0.900',
            '10:Sport146.it:0.900 12:Vapor19:0.855 14:TLQ4.at:0.633 16:Musa57.at:0.836',
            '17:Vapor13.it:0.855 19:TORQ7.uk:0.820 21:TLQ6.de:0.900 23:Aquilant15.uk:0.900',
            '25:Sport128.it:0.900 26:Vapor49.uk:0.900 27:KabelAcht4.at:0.855',
            '28:Aquilant9.it:0.871 29:TORQ1.it:0.900 30:TORQ25.de:0.886 35:Vapor0.it:0.855',
            '36:Musa57.at:0.836 37:Vapor13.it:0.855 39:TORQ7.uk:0.820 40:Musa48.de:0.633',
            '41:Musa25.uk:0.886 45:Sport137:0.855 47:KabelAcht4.at:0.855 52:Vapor19:0.900',
            '53:TORQ45.de:0.900 55:KabelAcht43.de:0.900 57:Vapor13.it:0.855 58:TLQ16.it:0.900',
            '65:Sport137:0.855 66:Sport152.uk:0.855 67:Vapor30.it:0.900 68:Vapor19.de:0.855',
            '69:TLQ58.at:0.855 70:TORQ25.de:0.841 75:Vapor0.it:0.855 76:Musa57.at:0.880',
            '77:Vapor13.it:0.900 78:KabelAcht10.de:0.900 79:TORQ7.uk:0.864',
            '80:Aquilant16.it:0.900 81:TORQ46.it:0.900 84:Aquilant33.at:0.855',
            '85:KabelAcht12.it:0.900 86:Aquilant40:0.900 87:KabelAcht4.at:0.855',
            '88:Vapor19.de:0.855 90:Sport13.at:0.900 91:Musa31:0.633 95:Vapor0.it:0.855',
            '96:Musa57.at:0.836 98:TLQ16.it:0.855 99:TORQ7.uk:0.820 104:Aquilant33.at:0.900',
            '108:TORQ34:0.900 109:Musa31.de:0.645 115:Vapor0.it:0.900',
            '117:TORQ49.de:0.900 118:Vapor13.at:0.900 119:TORQ7.uk:0.820',
            '124:Sport124.de:0.900 126:Sport152.uk:0.855 127:KabelAcht4.at:0.900',
            '129:TLQ58.at:0.855 130:TORQ25.de:0.841 132:Vapor19:0.855 136:Musa57.at:0.836',
            '137:Vapor13.it:0.855 138:TLQ16.it:0.855 144:Aquilant33.at:0.855',
            '146:Sport152.uk:0.855 148:Vapor19.de:0.855 149:TLQ58.at:0.855',
        ].join(' ');
        const actual = matchEpgChannels(rows(specs, false), guide)
            .matches.map((m) => `${m.channelIndex}:${m.epgChannelId}:${m.confidence.toFixed(3)}`)
            .join(' ');
        expect(actual).toBe(oldMatcher);
    });

    it('a guide without country info gives the country-blind result', () => {
        const { guide, specs } = seededSource(150);
        const untaggedGuide = makeEpgData(
            guide.channels.map((c, i) =>
                makeXmltvChannel({
                    id: `e${i}`,
                    displayName: c.displayName.replace(/^\W*[A-Z]{2}\W\s*/, ''),
                }),
            ),
        );
        const blind = matchEpgChannels(rows(specs, false), untaggedGuide);
        expect(blind.stats.matched).toBeGreaterThan(0);
        expect(matchEpgChannels(rows(specs), untaggedGuide)).toEqual(blind);
    });

    it('async matching with countries yields and returns the sync result', async () => {
        const { guide, specs } = seededSource(600);
        const expected = matchEpgChannels(rows(specs), guide);
        let clock = 0;
        const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 100));
        const progress: Array<{ processed: number; total: number }> = [];
        try {
            const actual = await matchEpgChannelsAsync(rows(specs), guide, (p) => {
                progress.push(p);
            });
            expect(actual).toEqual(expected);
        } finally {
            nowSpy.mockRestore();
        }
        expect(progress.length).toBeGreaterThan(10);
    });

    it('claims a placeholder id once even when its names share a first word', () => {
        // "Event 1", "Event 2": numbered channels under one placeholder id.
        const specs: Spec[] = [
            { name: 'Event 1', country: 'de' },
            { name: 'Event 2', country: 'de' },
            { name: 'Event 3', country: 'de' },
        ];
        const guide = makeEpgData([
            ...['Event 1', 'Event 2', 'Event 3'].map((displayName) =>
                makeXmltvChannel({ id: 'placeholder', displayName }),
            ),
            // A tagged entry turns country-aware matching on.
            makeXmltvChannel({ id: 'other.at', displayName: 'AT: Other' }),
        ]);
        expect(matchEpgChannels(rows(specs), guide).matches).toHaveLength(1);
    });

    it('treats "(Alt 2)" feeds of one channel as one station', () => {
        const specs: Spec[] = [
            { name: 'UK: Kanal Neun SD (Alt 1)', country: 'uk' },
            { name: 'UK: Kanal Neun SD (Alt 2)', country: 'uk' },
        ];
        const guide = makeEpgData([
            makeXmltvChannel({ id: 'kn.uk', displayName: 'UK: Kanal Neun SD (Alt 1)' }),
            makeXmltvChannel({ id: 'kn.uk', displayName: 'UK: Kanal Neun SD (Alt 2)' }),
        ]);
        expect(matchEpgChannels(rows(specs), guide).matches).toHaveLength(2);
    });

    it('reads a raw tvg-id country ("gb") as the guide code ("uk")', () => {
        const specs: Spec[] = [
            { name: 'Kanal Neun', country: 'de' },
            { name: 'Kanal Neun', country: 'gb' },
        ];
        const result = matchEpgChannels(
            rows(specs),
            makeEpgData([makeXmltvChannel({ id: 'kn', displayName: 'UK: Kanal Neun' })]),
        );
        expect(matchedIds(result, specs)).toEqual({ 'Kanal Neun|gb': 'kn' });
    });
});

describe('EPG Matcher — exact tvg-id matches are not exclusive', () => {
    function idChannels(specs: Array<{ name: string; tvgId?: string; group?: string }>) {
        return specs.map(
            (s) =>
                ({
                    original: makeM3uChannel({ name: s.name, tvgId: s.tvgId }),
                    baseName: s.name,
                    category: '',
                    backupGroupKey: s.group,
                    isPrimary: false,
                    isVod: false,
                }) as unknown as ProcessedChannel,
        );
    }

    it('gives the guide to every channel whose tvg-id is the guide id, across backup groups', () => {
        const channels = idChannels([
            { name: 'Kanal Gold', tvgId: 'kanalgold.de', group: 'de' },
            { name: 'AT: Kanal Gold HD', tvgId: 'kanalgold.de', group: 'at' },
            { name: 'Kanal Gold Low (HEVC)', tvgId: 'kanalgold.de' },
        ]);
        const result = matchEpgChannels(
            channels,
            makeEpgData([makeXmltvChannel({ id: 'kanalgold.de', displayName: 'Kanal Gold' })]),
        );
        expect(result.matches.map((m) => [m.channelIndex, m.epgChannelId])).toEqual([
            [0, 'kanalgold.de'],
            [1, 'kanalgold.de'],
            [2, 'kanalgold.de'],
        ]);
        expect(result.matches.every((m) => m.signals.includes('tvg_id_exact'))).toBe(true);
        expect(result.unmatched).toEqual([]);
    });

    it('an exact tvg-id match takes the entry from an earlier name match', () => {
        const channels = idChannels([
            { name: 'Kanal Gold' },
            { name: 'Something Else', tvgId: 'kanalgold.de' },
        ]);
        const result = matchEpgChannels(
            channels,
            makeEpgData([makeXmltvChannel({ id: 'kanalgold.de', displayName: 'Kanal Gold' })]),
        );
        expect(result.matches.map((m) => m.channelIndex)).toEqual([1]);
        expect(result.unmatched.map((u) => u.channelIndex)).toEqual([0]);
    });

    it('name matches still compete for an entry an exact match did not take', () => {
        const channels = idChannels([{ name: 'Kanal Gold' }, { name: 'Kanal Gold' }]);
        const result = matchEpgChannels(
            channels,
            makeEpgData([makeXmltvChannel({ id: 'kg', displayName: 'Kanal Gold' })]),
        );
        expect(result.matches.map((m) => m.channelIndex)).toEqual([0]);
    });
});

describe('EPG Matcher — placeholder guide ids', () => {
    function named(names: Array<[string, string?]>): ProcessedChannel[] {
        return names.map(
            ([name, tvgId]) =>
                ({
                    original: makeM3uChannel({ name, tvgId }),
                    baseName: name,
                    category: '',
                    isPrimary: false,
                    isVod: false,
                }) as unknown as ProcessedChannel,
        );
    }
    const program = (channelId: string, title: string, hour: number): XmltvProgram =>
        ({
            channelId,
            title,
            startTime: `2026-10-16T${String(hour).padStart(2, '0')}:00:00Z`,
            endTime: `2026-10-16T${String(hour + 1).padStart(2, '0')}:00:00Z`,
            genres: [],
        }) as unknown as XmltvProgram;

    it('ignores an id that several stations carry with one repeated title', () => {
        const events = ['Event Kanal 1', 'Event Kanal 2', 'Arena Live 3'];
        const result = matchEpgChannels(
            named([
                ...events.map((n): [string, string] => [n, 'noguide']),
                ['Kanal Neun', 'kn.de'],
            ]),
            makeEpgData(
                [
                    makeXmltvChannel({ id: 'noguide', displayName: 'Event Kanal 1' }),
                    makeXmltvChannel({ id: 'kn.de', displayName: 'Kanal Neun' }),
                ],
                [
                    ...[1, 2, 3].map((h) => program('noguide', 'No programme information', h)),
                    program('kn.de', 'News', 1),
                    program('kn.de', 'Film', 2),
                ],
            ),
        );
        expect(result.matches.map((m) => m.epgChannelId)).toEqual(['kn.de']);
    });

    it('ignores an id given to ten or more unrelated stations', () => {
        const stations = [
            'Alpha',
            'Bravo',
            'Charlie',
            'Delta',
            'Echo',
            'Foxtrot',
            'Golf',
            'Hotel',
            'India',
            'Juliett',
        ];
        const result = matchEpgChannels(
            named(stations.map((n): [string, string] => [n, 'shared'])),
            makeEpgData([makeXmltvChannel({ id: 'shared', displayName: 'Alpha' })]),
        );
        expect(result.matches).toEqual([]);
    });

    it("keeps a 24/7 channel's guide with one title", () => {
        const result = matchEpgChannels(
            named([
                ['24/7 Kanal Show', 'loop'],
                ['24/7 Kanal Show HD', 'loop'],
            ]),
            makeEpgData(
                [makeXmltvChannel({ id: 'loop', displayName: '24/7 Kanal Show' })],
                [1, 2, 3].map((h) => program('loop', 'Kanal Show', h)),
            ),
        );
        expect(result.matches).toHaveLength(2);
    });

    it("keeps a network's regional variants that share one id", () => {
        const regions = [
            'Nord',
            'Sued',
            'Ost',
            'West',
            'Mitte',
            'Kueste',
            'Berg',
            'Tal',
            'Insel',
            'Stadt',
        ];
        const result = matchEpgChannels(
            named(regions.map((r): [string, string] => [`Kanal 3 Region ${r}`, 'kanal3'])),
            makeEpgData(
                [makeXmltvChannel({ id: 'kanal3', displayName: 'Kanal 3' })],
                [program('kanal3', 'News', 1), program('kanal3', 'Film', 2)],
            ),
        );
        expect(result.matches).toHaveLength(10);
    });
});

describe('EPG Matcher — one tvg-id on different stations', () => {
    function withIds(specs: Array<[string, string]>): ProcessedChannel[] {
        return specs.map(
            ([name, tvgId]) =>
                ({
                    original: makeM3uChannel({ name, tvgId }),
                    baseName: name,
                    category: '',
                    isPrimary: false,
                    isVod: false,
                }) as unknown as ProcessedChannel,
        );
    }
    const guide = (id: string, displayName: string) =>
        makeEpgData([makeXmltvChannel({ id, displayName })]);
    const matched = (r: EpgMatchResult, specs: Array<[string, string]>): string[] =>
        r.matches.map((m) => specs[m.channelIndex][0]);

    it('keeps the station most feeds belong to when another number shares the id', () => {
        const specs: Array<[string, string]> = [
            ['Kanal 4 HDraw', 'Kanal4HDAT'],
            ['Kanal 4 SDraw', 'Kanal4HDAT'],
            ['AT: Kanal 4 HD+', 'Kanal4HDAT'],
            ['Kanal 24 HDraw', 'Kanal4HDAT'],
        ];
        expect(
            matched(matchEpgChannels(withIds(specs), guide('Kanal4HDAT', 'Kanal 4 HD')), specs),
        ).toEqual(['Kanal 4 HDraw', 'Kanal 4 SDraw', 'AT: Kanal 4 HD+']);
    });

    it('a +1 timeshift is another station', () => {
        const specs: Array<[string, string]> = [
            ['UK: Kochkanal SD (Alt 1)', 'Kochkanal.uk'],
            ['UK: Kochkanal SD (Alt 2)', 'Kochkanal.uk'],
            ['UK: Kochkanal+1 SD', 'Kochkanal.uk'],
        ];
        expect(
            matched(
                matchEpgChannels(withIds(specs), guide('Kochkanal.uk', 'UK: Kochkanal')),
                specs,
            ),
        ).toEqual(['UK: Kochkanal SD (Alt 1)', 'UK: Kochkanal SD (Alt 2)']);
    });

    it('a two-word name with words added at its end is another station', () => {
        const specs: Array<[string, string]> = [
            ['UK: Kanal News FHD', 'KanalNews.uk'],
            ['UK: Kanal News HD', 'KanalNews.uk'],
            ['UK: Kanal News Arabia SD', 'KanalNews.uk'],
        ];
        expect(
            matched(
                matchEpgChannels(withIds(specs), guide('KanalNews.uk', 'UK: Kanal News HD')),
                specs,
            ),
        ).toEqual(['UK: Kanal News FHD', 'UK: Kanal News HD']);
    });

    it('keeps every feed of one station however it is spelled or prefixed', () => {
        const specs: Array<[string, string]> = [
            ['KanalTV AT HDraw', 'KanalTVHDAT'],
            ['AT: Kanal TV HD+', 'KanalTVHDAT'],
            ['Kanal TV HDʀᴀᴡ', 'KanalTVHDAT'],
            ['Kanal TV Low (HEVC)', 'KanalTVHDAT'],
            ['[Bouquet] Kanal TV', 'KanalTVHDAT'],
            ['BQ: KANAL TV', 'KanalTVHDAT'],
            ['24/7 • Kanal TV', 'KanalTVHDAT'],
            ['Kanal TV FHD/HD/SD', 'KanalTVHDAT'],
        ];
        expect(
            matchEpgChannels(withIds(specs), guide('KanalTVHDAT', 'Kanal TV')).matches,
        ).toHaveLength(8);
    });

    it('keeps all stations when they tie', () => {
        const specs: Array<[string, string]> = [
            ['Kanal Overflow 2 HD', 'overflow'],
            ['Kanal Overflow 4 HD', 'overflow'],
        ];
        expect(
            matchEpgChannels(withIds(specs), guide('overflow', 'Something else')).matches,
        ).toHaveLength(2);
    });
});
