// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Host dispatch to lyrics providers.
 *
 * Sequential and first-answer-wins, unlike subtitles where the host collects
 * from everyone and ranks. There is nothing to rank — a track has one set of
 * lyrics — so the cheapest correct thing is to stop at the first provider that
 * has them. That shortcut is only safe if "has them" is judged strictly, which
 * is most of what these tests pin.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchLyricsFromPlugins } from './lyrics-providers.js';

const QUERY = {
    trackId: '11111111-1111-1111-1111-111111111111',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    durationSeconds: 200,
};

const ctx = {} as never;
const deps = (providers: unknown[]) => ({
    listProviders: () => providers as never,
    buildCtx: () => ctx,
});

describe('first answer wins', () => {
    it('stops at the first provider with lyrics and never asks the rest', async () => {
        const second = vi.fn();
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', fetchLyrics: async () => ({ plain: 'la la' }) },
                { id: 'b', fetchLyrics: second },
            ]),
        );
        expect(out).toMatchObject({ plainLyrics: 'la la', providerId: 'a' });
        expect(second).not.toHaveBeenCalled();
    });

    it('falls through to the next when the first has nothing', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', fetchLyrics: async () => null },
                { id: 'b', fetchLyrics: async () => ({ synced: '[00:01.00]hi' }) },
            ]),
        );
        expect(out).toMatchObject({ syncedLyrics: '[00:01.00]hi', providerId: 'b' });
    });
});

describe('what does not count as an answer', () => {
    it('a result with neither plain nor synced', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', fetchLyrics: async () => ({ plain: null, synced: null }) },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(out?.providerId).toBe('b');
    });

    it('EMPTY STRINGS — the shape is right but there are no lyrics in it', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', fetchLyrics: async () => ({ plain: '', synced: '' }) },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(out?.providerId).toBe('b');
    });

    it('non-string values, which would otherwise reach the player as junk', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', fetchLyrics: async () => ({ plain: 42, synced: {} }) },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(out?.providerId).toBe('b');
    });
});

describe('fault isolation', () => {
    it('a THROWING provider does not stop the ones after it', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                {
                    id: 'a',
                    fetchLyrics: async () => {
                        throw new Error('boom');
                    },
                },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(out?.providerId).toBe('b');
    });

    it('an UNCONFIGURED provider is skipped without being asked', async () => {
        const never = vi.fn();
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                { id: 'a', isConfigured: async () => false, fetchLyrics: never },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(never).not.toHaveBeenCalled();
        expect(out?.providerId).toBe('b');
    });

    it('a provider whose isConfigured throws is skipped, not treated as configured', async () => {
        const never = vi.fn();
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([
                {
                    id: 'a',
                    isConfigured: async () => {
                        throw new Error('boom');
                    },
                    fetchLyrics: never,
                },
                { id: 'b', fetchLyrics: async () => ({ plain: 'real' }) },
            ]),
        );
        expect(never).not.toHaveBeenCalled();
        expect(out?.providerId).toBe('b');
    });

    it('returns null when nobody answers, rather than throwing', async () => {
        const out = await fetchLyricsFromPlugins(
            QUERY,
            deps([{ id: 'a', fetchLyrics: async () => null }]),
        );
        expect(out).toBeNull();
    });

    it('returns null when there are no providers at all', async () => {
        expect(await fetchLyricsFromPlugins(QUERY, deps([]))).toBeNull();
    });

    it('returns null when listing providers throws', async () => {
        const out = await fetchLyricsFromPlugins(QUERY, {
            listProviders: () => {
                throw new Error('registry down');
            },
            buildCtx: () => ctx,
        } as never);
        expect(out).toBeNull();
    });
});
