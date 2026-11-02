// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type postgres from 'postgres';
import type { ReconcileFileGroup } from '$lib/server/database/queries/episode-reconciliation.queries.js';

// ---------------------------------------------------------------------------
// Mocks for the loadTmdbCatalog language-resolution tests (hoisted).
// `importOriginal` spreads keep every other export intact so the pure-function
// computeReconciliationProposals tests below are unaffected and other modules
// in the import graph don't lose exports they import by name.
// ---------------------------------------------------------------------------

const {
    mockCreateTMDBApi,
    mockFreshGetTVShowSeasons,
    mockFreshGetSeasonEpisodes,
    mockSingletonGetTVShowSeasons,
    mockSingletonGetSeasonEpisodes,
    mockSingletonGetSeasonEpisodesInLanguage,
    mockGetTmdbId,
} = vi.hoisted(() => ({
    mockCreateTMDBApi: vi.fn(),
    mockFreshGetTVShowSeasons: vi.fn(),
    mockFreshGetSeasonEpisodes: vi.fn(),
    mockSingletonGetTVShowSeasons: vi.fn(),
    mockSingletonGetSeasonEpisodes: vi.fn(),
    mockSingletonGetSeasonEpisodesInLanguage: vi.fn(),
    mockGetTmdbId: vi.fn(),
}));

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    tmdbApi: {
        isAvailable: () => true,
        getTVShowSeasons: mockSingletonGetTVShowSeasons,
        getSeasonEpisodes: mockSingletonGetSeasonEpisodes,
        getSeasonEpisodesInLanguage: mockSingletonGetSeasonEpisodesInLanguage,
    },
    createTMDBApi: mockCreateTMDBApi,
}));

vi.mock('$lib/server/tasks/plugin-context.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    // No childList-capable provider registered → loadTmdbCatalog exercises the
    // direct-TMDB fallback path, which is exactly what these tests pin.
    getProvidersByPriority: vi.fn(() => []),
    invokeProviderChildList: vi.fn(),
}));

vi.mock('$lib/server/database/queries/external-ids.queries.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    getTmdbId: { get: mockGetTmdbId },
}));

import { config } from '$lib/server/config.js';
import {
    computeReconciliationProposals,
    loadTmdbCatalog,
    type TmdbCatalogEpisode,
} from './episode-reconciliation.service.js';

const catalog: TmdbCatalogEpisode[] = [
    {
        tmdbEpisodeId: '78864',
        name: 'Der Einbruch',
        altNames: [],
        overview: null,
        seasonNumber: 1,
        episodeNumber: 1,
        stillPath: null,
    },
    {
        tmdbEpisodeId: '78888',
        name: 'Das Experiment',
        altNames: [],
        overview: null,
        seasonNumber: 1,
        episodeNumber: 3,
        stillPath: null,
    },
    {
        tmdbEpisodeId: '79000',
        name: 'Wo sind Spinellis Eltern?',
        altNames: [],
        overview: null,
        seasonNumber: 1,
        episodeNumber: 25,
        stillPath: null,
    },
    {
        tmdbEpisodeId: '79001',
        name: 'Die vierte Dimension',
        altNames: [],
        overview: null,
        seasonNumber: 1,
        episodeNumber: 26,
        stillPath: null,
    },
];

describe('computeReconciliationProposals', () => {
    it('binds each episode row on a combined file to the chapter-matched TMDB episode', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-1',
                    fileName: null,
                    chapterNames: [
                        'Opening',
                        'Wo sind Spinellis Eltern?',
                        'Die vierte Dimension',
                        'Credits',
                    ],
                    episodes: [
                        {
                            episodeId: 'ep-3',
                            seasonNumber: 1,
                            episodeNumber: 3,
                            currentTitle: 'Das Experiment / Wir wollen unseren Schrotti',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                        {
                            episodeId: 'ep-4',
                            seasonNumber: 1,
                            episodeNumber: 4,
                            currentTitle: 'Wir wollen unseren Schrotti',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(2);
        const first = proposals.find((p) => p.episodeId === 'ep-3');
        expect(first?.matchedTmdbEpisodeId).toBe('79000');
        expect(first?.proposedTitle).toBe('Wo sind Spinellis Eltern?');
        expect(first?.confidence).toBeGreaterThanOrEqual(0.8);
        expect(first?.changed).toBe(true);
        const second = proposals.find((p) => p.episodeId === 'ep-4');
        expect(second?.matchedTmdbEpisodeId).toBe('79001');
        expect(second?.proposedTitle).toBe('Die vierte Dimension');
    });

    it('skips generic chapter names and files whose content-chapter count != episode-row count', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-2',
                    fileName: null,
                    chapterNames: ['Chapter 1', 'Chapter 2'],
                    episodes: [
                        {
                            episodeId: 'ep-x',
                            seasonNumber: 1,
                            episodeNumber: 7,
                            currentTitle: 'X',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0].matchedTmdbEpisodeId).toBeNull();
        expect(proposals[0].reason).toBe('no-usable-chapters');
    });

    it('marks changed=false when the matched title already equals current', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-3',
                    fileName: null,
                    chapterNames: ['Der Einbruch'],
                    episodes: [
                        {
                            episodeId: 'ep-1',
                            seasonNumber: 1,
                            episodeNumber: 1,
                            currentTitle: 'Der Einbruch',
                            tmdbEpisodeId: '78864',
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals[0].matchedTmdbEpisodeId).toBe('78864');
        expect(proposals[0].changed).toBe(false);
    });

    it('demotes both rows to duplicate-match when they resolve to the same TMDB id', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-dup',
                    fileName: null,
                    chapterNames: ['Das Experiment', 'Das Experiment'],
                    episodes: [
                        {
                            episodeId: 'ep-a',
                            seasonNumber: 1,
                            episodeNumber: 3,
                            currentTitle: 'X',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                        {
                            episodeId: 'ep-b',
                            seasonNumber: 1,
                            episodeNumber: 4,
                            currentTitle: 'Y',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals.every((p) => p.reason === 'duplicate-match')).toBe(true);
        expect(proposals.every((p) => p.matchedTmdbEpisodeId === '78888')).toBe(true);
        expect(proposals.every((p) => p.changed === false)).toBe(true);
    });

    describe('duplicate evidence (fictional releases)', () => {
        const target: TmdbCatalogEpisode = {
            tmdbEpisodeId: '99001',
            name: 'Who Is the Amber Dragon',
            altNames: [],
            overview: null,
            seasonNumber: 1,
            episodeNumber: 1,
            stillPath: null,
        };
        function file(
            index: number,
            overrides: Partial<ReconcileFileGroup> = {},
        ): ReconcileFileGroup {
            return {
                fileId: `amber-file-${index}`,
                fileName: null,
                chapterNames: [target.name],
                episodes: [
                    {
                        episodeId: `amber-ep-${index}`,
                        seasonNumber: 1,
                        episodeNumber: index,
                        currentTitle: `Episode ${index}`,
                        tmdbEpisodeId: null,
                        metadataLocked: false,
                        titleBinding: null,
                    },
                ],
                ...overrides,
            };
        }
        function expectNoCandidate(
            groups: ReconcileFileGroup[],
            entries = [target],
            threshold = 0.5,
        ): void {
            const proposals = computeReconciliationProposals(groups, entries, { threshold });
            expect(proposals).toHaveLength(groups.length);
            for (const p of proposals) {
                expect(p.reason).not.toBe('duplicate-match');
                expect(p.reason).not.toBe('matched');
                expect(p.changed).toBe(false);
                expect(p.matchedTmdbEpisodeId).toBeNull();
                expect(p.proposedTitle).toBeNull();
            }
        }
        it.each([
            'Episode',
            'Main',
            'Chapter',
            'Start',
            'Intro/Credits',
            'Chapter 1',
            'TBA',
            'Episode 19',
            'Episode N',
            'Main!',
            'Start:',
        ])('ignores generic chapter identity evidence: %s', (label) => {
            expectNoCandidate(
                [file(1, { chapterNames: [label] }), file(2, { chapterNames: [label] })],
                [{ ...target, name: label }],
            );
        });
        it.each([
            'TBA',
            'TBD',
            'Episode 19',
            'Episode N',
            'Main!',
            'Start:',
            'Folge 19',
            'Chapter 1',
        ])('ignores placeholder filename and catalog titles: %s', (label) => {
            expectNoCandidate(
                [1, 2].map((i) =>
                    file(i, {
                        fileName: `Amber Lantern - S01E0${i} - ${label}.mkv`,
                        chapterNames: [],
                    }),
                ),
                [{ ...target, name: label }],
            );
        });
        it('ignores a placeholder catalog variant even for a meaningful query', () => {
            expectNoCandidate(
                [file(1, { chapterNames: ['Mains'] })],
                [{ ...target, name: 'Main', altNames: ['Episode 19'] }],
            );
        });
        it.each([0.5, 0.9])('rejects a shared filename tail above threshold %s', (threshold) => {
            expectNoCandidate(
                [1, 2].map((i) =>
                    file(i, {
                        fileName: `Amber Lantern - S01E0${i} - Who Is the Amber Dragon.mkv`,
                        chapterNames: [],
                    }),
                ),
                [target],
                threshold,
            );
        });
        it('rejects fuzzy recurring character names without independent evidence', () => {
            expectNoCandidate(
                [
                    file(1, { chapterNames: ['Mira and Her Brother'] }),
                    file(2, { chapterNames: ['Mira and Her Brothers'] }),
                ],
                [{ ...target, name: 'Mira and Her Brother' }],
            );
        });
        it.each([
            ['Teil 1', 'Teil 2'],
            ['(1)', '(2)'],
            ['Part 1', 'Part 2'],
        ])('vetoes duplicate inference from distinct filename parts %s / %s', (a, b) => {
            const evidence = { fileHashHead: 'a'.repeat(64), fileSizeBytes: 123456 };
            expectNoCandidate(
                [a, b].map((part, index) =>
                    file(index, {
                        ...evidence,
                        fileName: `Amber Lantern - S01E01 - The Glass Rescue ${part}.mkv`,
                    }),
                ),
            );
        });
        it('matches a unique normalized filename alias ahead of weak chapters', () => {
            const [proposal] = computeReconciliationProposals(
                [
                    file(1, {
                        fileName: 'Amber Lantern - S01E01 - 004 - Die Uhrmacherin ruft!.mkv',
                        chapterNames: ['Who Is the Amber Dragon'],
                    }),
                ],
                [{ ...target, name: 'The Clockmaker Calls', altNames: ['Die Uhrmacherin ruft'] }],
                { threshold: 1 },
            );
            expect(proposal).toMatchObject({
                reason: 'matched',
                source: 'filename',
                confidence: 1,
                matchedTmdbEpisodeId: target.tmdbEpisodeId,
            });
        });
        it('abstains when two catalog identities share the exact normalized filename alias', () => {
            const [proposal] = computeReconciliationProposals(
                [
                    file(1, {
                        fileName: 'Amber Lantern - S01E01 - The Clockmaker Calls.mkv',
                        chapterNames: [],
                    }),
                ],
                [
                    { ...target, name: 'The Clockmaker Calls' },
                    {
                        ...target,
                        tmdbEpisodeId: '99002',
                        name: 'Another Clock',
                        altNames: ['The Clockmaker Calls'],
                    },
                ],
            );
            expect(proposal.matchedTmdbEpisodeId).toBeNull();
            expect(proposal.changed).toBe(false);
        });
        it.each(['Teil 1', '(1)', 'Part 1', 'Teil.1', 'Part_1'])(
            'refuses a chapter proposal contradicting filename part %s',
            (part) => {
                expectNoCandidate(
                    [
                        file(1, {
                            fileName: `Amber Lantern - S01E01 - The Glass Rescue ${part}.mkv`,
                            chapterNames: ['The Glass Rescue Part 2'],
                        }),
                    ],
                    [{ ...target, name: 'The Glass Rescue Part 2' }],
                );
            },
        );
        it('checks a combined-file window even when a chapter matches exactly', () => {
            expectNoCandidate([
                file(1, {
                    fileName: 'Amber Lantern - S01E01-02-03 - The Glass Rescue.mkv',
                    chapterNames: [target.name],
                }),
            ]);
        });
        it('accepts explicit matching parts through a catalog alias', () => {
            const [proposal] = computeReconciliationProposals(
                [
                    file(1, {
                        fileName: 'Amber Lantern - S01E01 - Die Glasrettung Teil 2.mkv',
                        chapterNames: [],
                    }),
                ],
                [{ ...target, name: 'The Glass Rescue (2)', altNames: ['Die Glasrettung Teil 2'] }],
            );
            expect(proposal).toMatchObject({
                reason: 'matched',
                confidence: 1,
                matchedTmdbEpisodeId: target.tmdbEpisodeId,
            });
        });
        it('rejects separate parts of a story', () => {
            const proposals = computeReconciliationProposals(
                [
                    file(1, { chapterNames: ['The Glass Rescue Part 1'] }),
                    file(2, { chapterNames: ['The Glass Rescue Part 2'] }),
                ],
                [{ ...target, name: 'The Glass Rescue Part 1' }],
            );
            expect(proposals[0]).toMatchObject({
                reason: 'matched',
                matchedTmdbEpisodeId: target.tmdbEpisodeId,
            });
            expect(proposals[1]).toMatchObject({
                reason: 'below-threshold',
                matchedTmdbEpisodeId: null,
                changed: false,
            });
        });
        it.each([
            ['season', 'S01E03', 'S02E03'],
            ['episode', 'S01E03', 'S01E07'],
            ['absolute', '016', '017'],
            ['release ordinal', 'S01E03 - 016', 'S01E03 - 017'],
        ])('rejects distinct explicit %s numbers even with identical titles', (_kind, a, b) => {
            const evidence = { fileHashHead: 'a'.repeat(64), fileSizeBytes: 123456 };
            expectNoCandidate([
                file(1, { ...evidence, fileName: `Amber Lantern - ${a} - ${target.name}.mkv` }),
                file(2, { ...evidence, fileName: `Amber Lantern - ${b} - ${target.name}.mkv` }),
            ]);
        });
        it.each([
            { durationSeconds: 1440 },
            { durationSeconds: 1200.3 },
            { fileHashHead: 'b'.repeat(64) },
            { fileSizeBytes: 543210 },
        ])('rejects conflicting physical evidence: %j', (difference) => {
            const evidence = {
                durationSeconds: 1200,
                fileHashHead: 'a'.repeat(64),
                fileSizeBytes: 123456,
            };
            expectNoCandidate([file(1, evidence), file(2, { ...evidence, ...difference })]);
        });
        it('does not treat equal durations and titles alone as duplicate proof', () => {
            expectNoCandidate([
                file(1, { durationSeconds: 1200 }),
                file(2, { durationSeconds: 1200 }),
            ]);
        });
        it('still flags a true duplicate with matching file evidence and retains the candidate', () => {
            const evidence = {
                durationSeconds: 1200,
                fileHashHead: 'a'.repeat(64),
                fileSizeBytes: 123456,
            };
            const proposals = computeReconciliationProposals(
                [file(1, evidence), file(2, evidence)],
                [target],
            );
            expect(proposals).toHaveLength(2);
            for (const p of proposals) {
                expect(p).toMatchObject({
                    reason: 'duplicate-match',
                    changed: false,
                    matchedTmdbEpisodeId: target.tmdbEpisodeId,
                    proposedTitle: target.name,
                });
            }
        });
        it.each(['S01E01-E03', 'S01E01-03'])(
            'recognizes duplicate combined releases with equivalent range %s',
            (window) => {
                const entries = ['The Amber Dragon', 'The Glass Rescue', 'The Lantern Returns'].map(
                    (name, i) => ({
                        ...target,
                        name,
                        tmdbEpisodeId: String(99100 + i),
                        episodeNumber: i + 1,
                    }),
                );
                const groups = [window, 'S01E01E02E03'].map((numbers, index) =>
                    file(index, {
                        fileName: `Amber Lantern - ${numbers}.mkv`,
                        chapterNames: entries.map((entry) => entry.name),
                        durationSeconds: 1800,
                        fileHashHead: 'a'.repeat(64),
                        fileSizeBytes: 123456,
                        episodes: entries.map((entry, i) => ({
                            episodeId: `combined-${index}-${i}`,
                            seasonNumber: entry.seasonNumber,
                            episodeNumber: entry.episodeNumber,
                            currentTitle: `Episode ${i + 1}`,
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        })),
                    }),
                );
                const proposals = computeReconciliationProposals(groups, entries);
                expect(proposals).toHaveLength(6);
                proposals.forEach((proposal, i) =>
                    expect(proposal).toMatchObject({
                        reason: 'duplicate-match',
                        changed: false,
                        matchedTmdbEpisodeId: entries[i % 3].tmdbEpisodeId,
                        proposedTitle: entries[i % 3].name,
                    }),
                );
            },
        );
        it('keeps a distinct third claimant out of a true duplicate pair', () => {
            const evidence = {
                durationSeconds: 1200,
                fileHashHead: 'a'.repeat(64),
                fileSizeBytes: 123456,
            };
            const proposals = computeReconciliationProposals(
                [
                    file(1, evidence),
                    file(2, evidence),
                    file(3, { ...evidence, fileHashHead: 'c'.repeat(64) }),
                ],
                [target],
            );
            expect(proposals.map((p) => p.reason)).toEqual([
                'duplicate-match',
                'duplicate-match',
                'below-threshold',
            ]);
            expect(proposals[2].matchedTmdbEpisodeId).toBeNull();
            expect(proposals.every((p) => !p.changed)).toBe(true);
        });
    });

    it('emits manually-locked reason with changed=false and null ids for a locked episode', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-locked',
                    fileName: null,
                    chapterNames: ['Der Einbruch'],
                    episodes: [
                        {
                            episodeId: 'ep-locked',
                            seasonNumber: 1,
                            episodeNumber: 1,
                            currentTitle: 'Der Einbruch',
                            tmdbEpisodeId: '78864',
                            metadataLocked: true,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0].reason).toBe('manually-locked');
        expect(proposals[0].changed).toBe(false);
        expect(proposals[0].matchedTmdbEpisodeId).toBeNull();
        expect(proposals[0].proposedTitle).toBeNull();
    });

    it('never overrides an identity-bound episode even when a confident chapter match exists', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-identity',
                    fileName: null,
                    // A chapter that WOULD confidently match catalog entry 78864.
                    chapterNames: ['Der Einbruch'],
                    episodes: [
                        {
                            episodeId: 'ep-identity',
                            seasonNumber: 1,
                            episodeNumber: 1,
                            currentTitle: 'A Trusted Prior Match',
                            tmdbEpisodeId: '99999',
                            metadataLocked: false,
                            titleBinding: 'identity',
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(1);
        // Identity-bound rows are frozen: emitted as a no-op review entry, never
        // proposed for change — the backfill must not re-litigate trusted matches.
        expect(proposals[0].reason).toBe('identity-bound');
        expect(proposals[0].changed).toBe(false);
        expect(proposals[0].matchedTmdbEpisodeId).toBeNull();
        expect(proposals[0].proposedTitle).toBeNull();
    });

    it('locks one episode without shifting chapter binding for its sibling on the same file', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-mixed',
                    fileName: null,
                    chapterNames: ['Wo sind Spinellis Eltern?', 'Die vierte Dimension'],
                    episodes: [
                        {
                            episodeId: 'ep-locked-2',
                            seasonNumber: 1,
                            episodeNumber: 25,
                            currentTitle: 'Old Title',
                            tmdbEpisodeId: null,
                            metadataLocked: true,
                            titleBinding: null,
                        },
                        {
                            episodeId: 'ep-unlocked',
                            seasonNumber: 1,
                            episodeNumber: 26,
                            currentTitle: 'Old Title 2',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(2);
        const locked = proposals.find((p) => p.episodeId === 'ep-locked-2');
        expect(locked?.reason).toBe('manually-locked');
        expect(locked?.changed).toBe(false);
        expect(locked?.matchedTmdbEpisodeId).toBeNull();
        const unlocked = proposals.find((p) => p.episodeId === 'ep-unlocked');
        expect(unlocked?.reason).toBe('matched');
        expect(unlocked?.matchedTmdbEpisodeId).toBe('79001');
        expect(unlocked?.proposedTitle).toBe('Die vierte Dimension');
    });

    it('matches a chapter against an English altName and uses the primary name as proposedTitle', () => {
        const catalogWithAlt: TmdbCatalogEpisode[] = [
            {
                tmdbEpisodeId: '78864',
                name: 'Der Einbruch',
                altNames: ['The Break-In'],
                overview: null,
                seasonNumber: 1,
                episodeNumber: 1,
                stillPath: null,
            },
            {
                tmdbEpisodeId: '79001',
                name: 'Die vierte Dimension',
                altNames: ['The Fourth Dimension'],
                overview: null,
                seasonNumber: 1,
                episodeNumber: 26,
                stillPath: null,
            },
        ];
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-altname',
                    fileName: null,
                    chapterNames: ['The Break-In'],
                    episodes: [
                        {
                            episodeId: 'ep-alt',
                            seasonNumber: 1,
                            episodeNumber: 1,
                            currentTitle: 'Some Title',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalogWithAlt,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(1);
        expect(proposals[0].reason).toBe('matched');
        expect(proposals[0].matchedTmdbEpisodeId).toBe('78864');
        expect(proposals[0].proposedTitle).toBe('Der Einbruch');
        expect(proposals[0].confidence).toBeGreaterThanOrEqual(0.8);
        expect(proposals[0].source).toBe('chapters');
    });

    it('uses filename segments to match episodes when a chapterless file has parseable title segments', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-chapterless',
                    fileName:
                        'Harborfolk.Grosse.Pause.S01E05E06.Wo.sind.Spinellis.Eltern.-.Die.vierte.Dimension.German.DL.480p.DSNP.WEB-DL.AAC.2.0.H.264-4SF.mkv',
                    chapterNames: [],
                    episodes: [
                        {
                            episodeId: 'ep-fn-1',
                            seasonNumber: 1,
                            episodeNumber: 25,
                            currentTitle: 'Old',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                        {
                            episodeId: 'ep-fn-2',
                            seasonNumber: 1,
                            episodeNumber: 26,
                            currentTitle: 'Old2',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(2);
        expect(proposals.every((p) => p.source === 'filename')).toBe(true);
        const p1 = proposals.find((p) => p.episodeId === 'ep-fn-1');
        const p2 = proposals.find((p) => p.episodeId === 'ep-fn-2');
        expect(p1?.reason).toBe('matched');
        expect(p1?.proposedTitle).toBe('Wo sind Spinellis Eltern?');
        expect(p2?.reason).toBe('matched');
        expect(p2?.proposedTitle).toBe('Die vierte Dimension');
    });

    it.each(['S01E05E07', 'S01E06E05', 'S01E05-07-06'])(
        'abstains for a skipped or reversed combined window %s',
        (window) => {
            const proposals = computeReconciliationProposals(
                [
                    {
                        fileId: 'invented-file',
                        fileName: `Invented.${window}.Wo.sind.Spinellis.Eltern.-.Die.vierte.Dimension.German.mkv`,
                        chapterNames: [],
                        episodes: [25, 26].map((number) => ({
                            episodeId: `invented-${number}`,
                            seasonNumber: 1,
                            episodeNumber: number,
                            currentTitle: 'Before',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        })),
                    },
                ],
                catalog,
                { threshold: 0 },
            );
            expect(
                proposals.every(
                    (proposal) =>
                        proposal.reason === 'contradictory-file-window' &&
                        !proposal.changed &&
                        proposal.matchedTmdbEpisodeId === null,
                ),
            ).toBe(true);
        },
    );
    it('emits no-usable-chapters when fileName yields no parseable segments', () => {
        const proposals = computeReconciliationProposals(
            [
                {
                    fileId: 'file-noparseable',
                    fileName: 'SomeShow.S01E01E02.German.DL.720p.mkv',
                    chapterNames: [],
                    episodes: [
                        {
                            episodeId: 'ep-np-1',
                            seasonNumber: 1,
                            episodeNumber: 1,
                            currentTitle: 'Old',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                        {
                            episodeId: 'ep-np-2',
                            seasonNumber: 1,
                            episodeNumber: 2,
                            currentTitle: 'Old2',
                            tmdbEpisodeId: null,
                            metadataLocked: false,
                            titleBinding: null,
                        },
                    ],
                },
            ],
            catalog,
            { threshold: 0.8 },
        );
        expect(proposals).toHaveLength(2);
        expect(proposals.every((p) => p.reason === 'no-usable-chapters')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// loadTmdbCatalog — language resolution on the direct-TMDB fallback path
// ---------------------------------------------------------------------------
//
// Regression coverage for the frozen-singleton language bug (same class as the
// series-children.ts fix): the language-less fallbacks (getTVShowSeasons /
// getSeasonEpisodes) used to run on the tmdbApi singleton, whose language is
// captured ONCE at process boot — episode titles proposed by reconciliation
// (title_binding='identity', user-visible) then synced in the boot-time
// language regardless of the current config. The fallbacks must construct a
// fresh client via createTMDBApi(config.TMDB_LANGUAGE), re-reading config per
// call. The explicit-language fallback (getSeasonEpisodesInLanguage) stays on
// the singleton deliberately: its per-request `language` param fully overrides
// the client's own language (makeRequest merges `{ language: this.language,
// ...params }` — the explicit param wins).

describe('loadTmdbCatalog — TMDB fallback language', () => {
    /** Tagged-template sql stub returning queued responses (langRows, audioRows). */
    function makeSql(responses: unknown[][]): postgres.Sql {
        let i = 0;
        const stub = ((strings: TemplateStringsArray) => {
            const text = Array.isArray(strings) ? strings.join('') : '';
            // Subject-set fragments are built with sql`` too; answer by query text,
            // not call order, so fragments never consume a queued response.
            if (text.trimStart().startsWith('SELECT ep.id, ep.parent_id FROM media_items ep'))
                return {};
            if (text.includes('WITH subjects AS'))
                return Promise.resolve([
                    {
                        image: 'evidence',
                        media_ids: [],
                        file_ids: [],
                        library_group_ids: [],
                        library_language: null,
                        audio_languages: [],
                    },
                ]);
            return Promise.resolve(responses[i++] ?? []);
        }) as unknown as postgres.Sql;
        return stub;
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetTmdbId.mockResolvedValue(1396);
        mockCreateTMDBApi.mockImplementation(() => ({
            getTVShowSeasons: mockFreshGetTVShowSeasons,
            getSeasonEpisodes: mockFreshGetSeasonEpisodes,
        }));
        mockFreshGetTVShowSeasons.mockResolvedValue([
            { seasonNumber: 1, name: 'Season 1', episodeCount: 1 },
        ]);
        mockFreshGetSeasonEpisodes.mockResolvedValue([
            { id: 62085, name: 'Pilot', episodeNumber: 1, seasonNumber: 1 },
        ]);
        mockSingletonGetSeasonEpisodesInLanguage.mockResolvedValue([]);
    });

    it('constructs the language-less fallback client with the CURRENT config.TMDB_LANGUAGE', async () => {
        const langSpy = vi.spyOn(config, 'TMDB_LANGUAGE', 'get').mockReturnValue('de-DE');
        try {
            // langRows (no library language), audioRows (no audio streams)
            const catalogResult = await loadTmdbCatalog(makeSql([[], []]), 'series-uuid');

            expect(mockCreateTMDBApi).toHaveBeenCalledWith('de-DE');
            expect(catalogResult).toHaveLength(1);
            expect(catalogResult[0].name).toBe('Pilot');

            // The frozen singleton must NOT serve the language-less calls.
            expect(mockSingletonGetTVShowSeasons).not.toHaveBeenCalled();
            expect(mockSingletonGetSeasonEpisodes).not.toHaveBeenCalled();
        } finally {
            langSpy.mockRestore();
        }
    });

    it('re-reads config.TMDB_LANGUAGE per call instead of caching a boot-time value', async () => {
        const langSpy = vi.spyOn(config, 'TMDB_LANGUAGE', 'get').mockReturnValue('de-DE');
        try {
            await loadTmdbCatalog(makeSql([[], []]), 'series-uuid');
            expect(mockCreateTMDBApi).toHaveBeenLastCalledWith('de-DE');

            // Simulate an admin flipping the setting back after "boot" — a
            // frozen singleton would still report 'de-DE' here.
            langSpy.mockReturnValue('en-US');
            await loadTmdbCatalog(makeSql([[], []]), 'series-uuid');
            expect(mockCreateTMDBApi).toHaveBeenLastCalledWith('en-US');
        } finally {
            langSpy.mockRestore();
        }
    });

    it('keeps the alt-language fetch on the singleton with an explicit per-request language', async () => {
        const langSpy = vi.spyOn(config, 'TMDB_LANGUAGE', 'get').mockReturnValue('en-US');
        try {
            await loadTmdbCatalog(makeSql([[], []]), 'series-uuid');

            // altLangs always includes 'en'; the explicit language param fully
            // overrides the singleton's frozen language, so this call is safe
            // on the singleton (and asserts it stays that way).
            expect(mockSingletonGetSeasonEpisodesInLanguage).toHaveBeenCalledWith(1396, 1, 'en');
        } finally {
            langSpy.mockRestore();
        }
    });
});
