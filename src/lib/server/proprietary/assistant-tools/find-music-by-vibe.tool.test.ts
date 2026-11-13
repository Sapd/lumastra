// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `find_music_by_vibe` assistant tool.
 * Mocks the CLAP text-embedding call and the backing query — no real DB,
 * no real sidecar/subprocess.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { findMusicByVibeTool, SIMILARITY_FLOOR, stripEraTerms } from './find-music-by-vibe.tool.js';
import type { AssistantToolContext } from './types.js';
import type { TextSoundSearchRow } from '../../database/queries/text-sound-search.queries.js';

vi.mock('../../services/sonic-embedding.service.js', () => ({
    embedTextQuery: vi.fn(),
}));
vi.mock('../../database/queries/text-sound-search.queries.js', () => ({
    textSoundSearch: vi.fn(),
}));

import { embedTextQuery } from '../../services/sonic-embedding.service.js';
import { textSoundSearch } from '../../database/queries/text-sound-search.queries.js';
import { buildAssistantTools } from './registry.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: toUserId(randomUUID()),
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const rainTrack: TextSoundSearchRow = {
    media_id: 't1',
    similarity_score: 0.87,
    title: 'Rainy Window',
    custom_poster_url: null,
    custom_metadata: {},
    runtime_seconds: 210,
    artist_title: 'Ambient Collective',
    album_id: 'alb-1',
    album_title: 'Quiet Hours',
    album_edition_year: 1994,
};

describe('find_music_by_vibe registry gating', () => {
    it('is registered when textToSoundEnabled is set', () => {
        const tools = buildAssistantTools({ textToSoundEnabled: true });
        expect(tools.some((t) => t.name === 'find_music_by_vibe')).toBe(true);
    });

    it('is absent when textToSoundEnabled is false/omitted (model cannot call it)', () => {
        const toolsOff = buildAssistantTools({ textToSoundEnabled: false });
        const toolsOmitted = buildAssistantTools({});
        expect(toolsOff.some((t) => t.name === 'find_music_by_vibe')).toBe(false);
        expect(toolsOmitted.some((t) => t.name === 'find_music_by_vibe')).toBe(false);
    });
});

describe('findMusicByVibeTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('has the expected name and gating description', () => {
        expect(findMusicByVibeTool.name).toBe('find_music_by_vibe');
        expect(findMusicByVibeTool.description.toLowerCase()).toContain('mood');
    });

    it('validates args: query is required, 1-400 chars; limit optional 1-30', () => {
        const schema = findMusicByVibeTool.argsSchema;
        expect(schema.safeParse({ query: 'rainy evening' }).success).toBe(true);
        expect(schema.safeParse({ query: '' }).success).toBe(false);
        expect(schema.safeParse({}).success).toBe(false);
        expect(schema.safeParse({ query: 'x'.repeat(401) }).success).toBe(false);
        expect(schema.safeParse({ query: 'chill', limit: 30 }).success).toBe(true);
        expect(schema.safeParse({ query: 'chill', limit: 31 }).success).toBe(false);
        expect(schema.safeParse({ query: 'chill', limit: 0 }).success).toBe(false);
    });

    it('returns an "unavailable" summary and no music when embedTextQuery returns null', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue(null);

        const result = await findMusicByVibeTool.execute({ query: 'rainy evening' }, makeCtx());

        expect(textSoundSearch).not.toHaveBeenCalled();
        expect(result.music).toBeUndefined();
        const summary = JSON.parse(result.summaryForModel);
        expect(summary.error).toBe('mood_search_unavailable');
        expect(String(summary.note)).toMatch(/cannot filter music by mood/i);
    });

    it('happy path: embeds the query, searches, and maps rows to music cards', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1, 0.2, 0.3]);
        vi.mocked(textSoundSearch).mockResolvedValue([rainTrack]);

        const result = await findMusicByVibeTool.execute(
            { query: 'rainy evening music', limit: 5 },
            makeCtx(),
        );

        expect(embedTextQuery).toHaveBeenCalledWith('rainy evening music');
        const call = vi.mocked(textSoundSearch).mock.calls[0];
        expect(call[1]).toEqual([0.1, 0.2, 0.3]);
        expect(call[2]).toBe(5);
        // The tool must project its SearchAccessContext onto a full
        // MediaAccessBoundary — never hand-rebuild a partial field literal.
        expect(call[3]).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });

        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.matches[0]).toMatchObject({
            title: 'Rainy Window',
            artist: 'Ambient Collective',
            album: 'Quiet Hours',
        });

        expect(result.music).toHaveLength(1);
        expect(result.music?.[0]).toMatchObject({
            id: 't1',
            title: 'Rainy Window',
            mediaType: 'track',
            artistName: 'Ambient Collective',
            albumTitle: 'Quiet Hours',
            albumId: 'alb-1',
            bucket: 'sonic-vibe-match',
        });
    });

    it('defaults to limit 12 when omitted', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([]);

        await findMusicByVibeTool.execute({ query: 'chill' }, makeCtx());

        const call = vi.mocked(textSoundSearch).mock.calls[0];
        expect(call[2]).toBe(12);
    });
});

// ---------------------------------------------------------------------------
// Confidence floor
//
// The numbers asserted here are the ones measured against the 28k-vector
// production corpus (see SIMILARITY_FLOOR's doc comment): an activity/context
// query tops out around 0.33-0.40, a real sound description reaches 0.48-0.56.
// ---------------------------------------------------------------------------

function trackAt(score: number, title = 'Some Track'): TextSoundSearchRow {
    return { ...rainTrack, media_id: `t-${score}`, similarity_score: score, title };
}

describe('findMusicByVibeTool confidence floor', () => {
    beforeEach(() => vi.clearAllMocks());

    it('exposes a floor of 0.4 (measured split between representable and OOD queries)', () => {
        expect(SIMILARITY_FLOOR).toBe(0.4);
    });

    it('returns no_confident_match — not a silent empty list — when every hit is below the floor', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        // The reported "Musik zum Kochen" bug: Rod Stewart's Christmas album at 0.30.
        vi.mocked(textSoundSearch).mockResolvedValue([
            trackAt(0.3016, 'Little Girl Cried'),
            trackAt(0.3011, 'Let It Snow'),
            trackAt(0.2934, 'When You Wish Upon a Star'),
        ]);

        const result = await findMusicByVibeTool.execute({ query: 'music for cooking' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.error).toBe('no_confident_match');
        expect(summary.matches).toBeUndefined();
        // No cards either — the UI must not show what the model is told not to claim.
        expect(result.music).toBeUndefined();
        expect(String(summary.note)).toMatch(/could not|cannot/i);
        expect(summary.bestSimilarity).toBeCloseTo(0.302, 3);
        expect(summary.similarityFloor).toBe(0.4);
        // The below-floor titles must never reach the model.
        expect(result.summaryForModel).not.toContain('Let It Snow');
    });

    it('returns no_confident_match when the query matched nothing at all', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([]);

        const result = await findMusicByVibeTool.execute({ query: 'workout energy' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.error).toBe('no_confident_match');
        expect(summary.bestSimilarity).toBeNull();
        expect(result.music).toBeUndefined();
    });

    it('keeps only the hits at or above the floor and drops the tail', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([
            trackAt(0.564, 'Nocturne'),
            trackAt(0.41, 'Prelude'),
            trackAt(0.399, 'Noise'),
            trackAt(0.2, 'More Noise'),
        ]);

        const result = await findMusicByVibeTool.execute({ query: 'calm solo piano' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.returnedCount).toBe(2);
        expect(summary.matches.map((m: { title: string }) => m.title)).toEqual([
            'Nocturne',
            'Prelude',
        ]);
        expect(result.music).toHaveLength(2);
    });

    it('never leaks the edition year to the model (it is the pressing year, not the release year)', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([trackAt(0.5, 'Roundabout')]);

        const result = await findMusicByVibeTool.execute({ query: 'calm solo piano' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.matches[0].year).toBeUndefined();
        expect(result.summaryForModel).not.toContain('1994');
    });
});

// ---------------------------------------------------------------------------
// Era / decade handling
//
// CLAP-2023 has no era axis: cos("90s rock","80s rock") = 0.970 and
// cos("90s rock","rock music") = 0.827 — the decade token moves the vector
// LESS than deleting it does. Asking for a decade is asking for the genre.
// ---------------------------------------------------------------------------

describe('stripEraTerms', () => {
    it.each([
        ['90s rock', 'rock', ['90s']],
        ['1990s rock', 'rock', ['1990s']],
        ['90er Rock', 'Rock', ['90er']],
        ['1980er Jahre Pop', 'Pop', ['1980er Jahre']],
        ['music from the eighties', 'music from the', ['eighties']],
        ['80s synth and 90s guitar', 'synth and guitar', ['80s', '90s']],
    ])('strips %j', (input, expectedQuery, expectedTerms) => {
        const out = stripEraTerms(input);
        expect(out.query).toBe(expectedQuery);
        expect(out.eraTerms).toEqual(expectedTerms);
    });

    it.each(['calm solo piano', 'aggressive heavy metal guitar', 'upbeat dance electronic beat'])(
        'leaves %j untouched',
        (input) => {
            expect(stripEraTerms(input)).toEqual({ query: input, eraTerms: [] });
        },
    );

    it('keeps the original query when stripping would leave nothing usable', () => {
        expect(stripEraTerms('90s')).toEqual({ query: '90s', eraTerms: ['90s'] });
    });
});

describe('findMusicByVibeTool era handling', () => {
    beforeEach(() => vi.clearAllMocks());

    it('embeds the era-stripped query and tells the model the era was NOT applied', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([trackAt(0.47, 'Roundabout')]);

        const result = await findMusicByVibeTool.execute({ query: '90s rock' }, makeCtx());

        // "90s" is noise in this space — it is removed before embedding.
        expect(embedTextQuery).toHaveBeenCalledWith('rock');

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.eraFilterApplied).toBe(false);
        expect(summary.eraTermsIgnored).toEqual(['90s']);
        expect(String(summary.note)).toMatch(/not filtered by decade|no release-year/i);
    });

    it('omits the era fields entirely when the query carries no decade', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([trackAt(0.47)]);

        const result = await findMusicByVibeTool.execute({ query: 'calm solo piano' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.eraFilterApplied).toBeUndefined();
        expect(summary.eraTermsIgnored).toBeUndefined();
        expect(embedTextQuery).toHaveBeenCalledWith('calm solo piano');
    });

    it('still reports the ignored era when nothing clears the floor', async () => {
        vi.mocked(embedTextQuery).mockResolvedValue([0.1]);
        vi.mocked(textSoundSearch).mockResolvedValue([trackAt(0.31)]);

        const result = await findMusicByVibeTool.execute({ query: '90er Kochmusik' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.error).toBe('no_confident_match');
        expect(summary.eraFilterApplied).toBe(false);
    });
});

describe('findMusicByVibeTool description', () => {
    it('steers the model at sound, not at activity/context or era', () => {
        const d = findMusicByVibeTool.description.toLowerCase();
        // The old text advertised exactly the failing class ("workout energy",
        // "something chill for studying") — those must be gone.
        expect(d).not.toContain('workout energy');
        expect(d).not.toContain('chill for studying');
        expect(d).not.toContain('rainy evening music');
        expect(d).toMatch(/instrument|timbre/);
        expect(d).toMatch(/decade|era/);
    });
});
