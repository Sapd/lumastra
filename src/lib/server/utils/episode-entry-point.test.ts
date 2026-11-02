// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveEpisodeEntryPoint, type EpisodeEntrySibling } from './episode-entry-point';

/** Hafentage S02E20E21 — real prod shape: chapter-derived, bigints as strings. */
const DOUBLE: EpisodeEntrySibling[] = [
    { id: 'e20', episode_number: 20, start_offset_ms: '0', end_offset_ms: '692275' },
    { id: 'e21', episode_number: 21, start_offset_ms: '692275', end_offset_ms: '1354602' },
];

/** S01E01-02-03 — three episodes on one file. */
const TRIPLE: EpisodeEntrySibling[] = [
    { id: 'e1', episode_number: 1, start_offset_ms: '0', end_offset_ms: '600000' },
    { id: 'e2', episode_number: 2, start_offset_ms: '600000', end_offset_ms: '1200000' },
    { id: 'e3', episode_number: 3, start_offset_ms: '1200000', end_offset_ms: '1800000' },
];

/** S11E13-14-15-16 — four. */
const QUAD: EpisodeEntrySibling[] = [
    { id: 'a', episode_number: 13, start_offset_ms: 0, end_offset_ms: 660000 },
    { id: 'b', episode_number: 14, start_offset_ms: 660000, end_offset_ms: 1320000 },
    { id: 'c', episode_number: 15, start_offset_ms: 1320000, end_offset_ms: 1980000 },
    { id: 'd', episode_number: 16, start_offset_ms: 1980000, end_offset_ms: 2640000 },
];

describe('resolveEpisodeEntryPoint', () => {
    describe('single-episode files', () => {
        it('returns no entry point for a plain file', () => {
            const single: EpisodeEntrySibling[] = [
                { id: 'e5', episode_number: 5, start_offset_ms: null, end_offset_ms: null },
            ];
            expect(resolveEpisodeEntryPoint(single, 'e5')).toEqual({
                streamStartPositionMs: 0,
                clientShouldSeek: false,
            });
        });

        it('returns no entry point for an empty sibling set', () => {
            expect(resolveEpisodeEntryPoint([], 'nope')).toEqual({
                streamStartPositionMs: 0,
                clientShouldSeek: false,
            });
        });
    });

    describe('two episodes on one file', () => {
        it('places the first part at 0 and still reports the range', () => {
            expect(resolveEpisodeEntryPoint(DOUBLE, 'e20')).toEqual({
                streamStartPositionMs: 0,
                clientShouldSeek: true,
                episodeNumberStart: 20,
                episodeNumberEnd: 21,
            });
        });

        it('places the second part at its own start', () => {
            expect(resolveEpisodeEntryPoint(DOUBLE, 'e21')).toEqual({
                streamStartPositionMs: 692275,
                clientShouldSeek: true,
                episodeNumberStart: 20,
                episodeNumberEnd: 21,
            });
        });
    });

    describe('three or more episodes on one file', () => {
        it.each([
            ['e1', 0],
            ['e2', 600000],
            ['e3', 1200000],
        ])('places %s of a triple at %i ms', (id, expected) => {
            const result = resolveEpisodeEntryPoint(TRIPLE, id);
            expect(result.streamStartPositionMs).toBe(expected);
            expect(result.clientShouldSeek).toBe(true);
        });

        it('reports the full range for every part of a triple, not a pair', () => {
            for (const id of ['e1', 'e2', 'e3']) {
                expect(resolveEpisodeEntryPoint(TRIPLE, id)).toMatchObject({
                    episodeNumberStart: 1,
                    episodeNumberEnd: 3,
                });
            }
        });

        it('handles a four-episode file', () => {
            expect(resolveEpisodeEntryPoint(QUAD, 'd')).toEqual({
                streamStartPositionMs: 1980000,
                clientShouldSeek: true,
                episodeNumberStart: 13,
                episodeNumberEnd: 16,
            });
            expect(resolveEpisodeEntryPoint(QUAD, 'c').streamStartPositionMs).toBe(1320000);
        });

        it('accepts numeric offsets as well as bigint strings', () => {
            expect(resolveEpisodeEntryPoint(QUAD, 'b').streamStartPositionMs).toBe(660000);
        });
    });

    describe('undeliverable windows fall back to whole-file playback', () => {
        it('refuses a half-populated window but keeps the range', () => {
            const half: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 1, start_offset_ms: '0', end_offset_ms: null },
                { id: 'b', episode_number: 2, start_offset_ms: null, end_offset_ms: null },
            ];
            expect(resolveEpisodeEntryPoint(half, 'b')).toEqual({
                streamStartPositionMs: 0,
                clientShouldSeek: false,
                episodeNumberStart: 1,
                episodeNumberEnd: 2,
            });
        });

        it('refuses NaN offsets rather than seeking to NaN', () => {
            const bad: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 1, start_offset_ms: '0', end_offset_ms: '600000' },
                {
                    id: 'b',
                    episode_number: 2,
                    start_offset_ms: 'garbage',
                    end_offset_ms: '1200000',
                },
            ];
            const result = resolveEpisodeEntryPoint(bad, 'b');
            expect(result.streamStartPositionMs).toBe(0);
            expect(result.clientShouldSeek).toBe(false);
        });

        it('refuses an inverted or empty window', () => {
            const inverted: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 1, start_offset_ms: '0', end_offset_ms: '600000' },
                { id: 'b', episode_number: 2, start_offset_ms: '900000', end_offset_ms: '600000' },
            ];
            expect(resolveEpisodeEntryPoint(inverted, 'b').clientShouldSeek).toBe(false);

            const empty: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 1, start_offset_ms: '0', end_offset_ms: '600000' },
                { id: 'b', episode_number: 2, start_offset_ms: '600000', end_offset_ms: '600000' },
            ];
            expect(resolveEpisodeEntryPoint(empty, 'b').clientShouldSeek).toBe(false);
        });

        it('refuses when the requested episode is not on the file', () => {
            expect(resolveEpisodeEntryPoint(DOUBLE, 'someone-else')).toEqual({
                streamStartPositionMs: 0,
                clientShouldSeek: false,
                episodeNumberStart: 20,
                episodeNumberEnd: 21,
            });
        });
    });

    describe('episode range', () => {
        it('omits the range when the numbers do not span (mis-linked rows)', () => {
            const same: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 7, start_offset_ms: '0', end_offset_ms: '600000' },
                { id: 'b', episode_number: 7, start_offset_ms: '600000', end_offset_ms: '1200000' },
            ];
            const result = resolveEpisodeEntryPoint(same, 'b');
            expect(result.episodeNumberStart).toBeUndefined();
            expect(result.episodeNumberEnd).toBeUndefined();
            // The window itself is still usable.
            expect(result.streamStartPositionMs).toBe(600000);
        });

        it('ignores null episode numbers when computing the range', () => {
            const partial: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: null, start_offset_ms: '0', end_offset_ms: '600000' },
                { id: 'b', episode_number: 9, start_offset_ms: '600000', end_offset_ms: '1200000' },
                {
                    id: 'c',
                    episode_number: 11,
                    start_offset_ms: '1200000',
                    end_offset_ms: '1800000',
                },
            ];
            expect(resolveEpisodeEntryPoint(partial, 'c')).toMatchObject({
                episodeNumberStart: 9,
                episodeNumberEnd: 11,
            });
        });

        it('omits the range for a hand-linked file holding episodes that are not adjacent', () => {
            const apart: EpisodeEntrySibling[] = [
                { id: 'a', episode_number: 37, start_offset_ms: '0', end_offset_ms: '660000' },
                {
                    id: 'b',
                    episode_number: 41,
                    start_offset_ms: '660000',
                    end_offset_ms: '1320000',
                },
            ];
            const result = resolveEpisodeEntryPoint(apart, 'b');
            expect(result.episodeNumberStart).toBeUndefined();
            expect(result.streamStartPositionMs).toBe(660000);
        });

        it('omits the range for a file holding episodes of two seasons', () => {
            const cross: EpisodeEntrySibling[] = [
                {
                    id: 'a',
                    episode_number: 16,
                    season_number: 11,
                    start_offset_ms: '0',
                    end_offset_ms: '660000',
                },
                {
                    id: 'b',
                    episode_number: 17,
                    season_number: 10,
                    start_offset_ms: '660000',
                    end_offset_ms: '1320000',
                },
            ];
            const result = resolveEpisodeEntryPoint(cross, 'b');
            expect(result.episodeNumberStart).toBeUndefined();
            expect(result.streamStartPositionMs).toBe(660000);
        });

        it('keeps the range of a reversed pair and seeks the second window', () => {
            const reversed: EpisodeEntrySibling[] = [
                { id: 'e20', episode_number: 20, start_offset_ms: '0', end_offset_ms: '660000' },
                {
                    id: 'e19',
                    episode_number: 19,
                    start_offset_ms: '660000',
                    end_offset_ms: '1320000',
                },
            ];
            expect(resolveEpisodeEntryPoint(reversed, 'e19')).toEqual({
                streamStartPositionMs: 660000,
                clientShouldSeek: true,
                episodeNumberStart: 19,
                episodeNumberEnd: 20,
            });
        });
    });
});
