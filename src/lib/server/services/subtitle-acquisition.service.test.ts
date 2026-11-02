// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — searching and ranking subtitle candidates across providers.
 *
 * Ranking is the part with judgement in it. An exact file-hash match is worth
 * more than any amount of popularity, because it is the difference between
 * subtitles that stay in sync and subtitles that drift; and the viewer's own
 * language preference order outranks both.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
    PluginContext,
    SubtitleCandidate,
    SubtitleProviderDefinition,
} from '@sapd/lumastra-plugin-sdk';
import {
    searchSubtitleCandidates,
    rankCandidates,
    sidecarPathFor,
    normalizeDownload,
} from './subtitle-acquisition.service.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ctxStub = { logger: { warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;

function provider(
    id: string,
    search: SubtitleProviderDefinition['search'],
    isConfigured?: SubtitleProviderDefinition['isConfigured'],
): SubtitleProviderDefinition {
    return {
        id,
        search,
        download: async () => ({ content: '', format: 'srt' }),
        ...(isConfigured ? { isConfigured } : {}),
    } as SubtitleProviderDefinition;
}

function deps(providers: SubtitleProviderDefinition[]) {
    return { listProviders: () => providers, buildCtx: () => ctxStub };
}

const QUERY = {
    mediaItemId: '00000000-0000-0000-0000-000000000001',
    mediaType: 'movie' as const,
    title: 'Awakening',
    languages: ['en', 'de'],
};

const cand = (over: Partial<SubtitleCandidate> = {}): SubtitleCandidate => ({
    id: 'c1',
    language: 'en',
    format: 'srt',
    ...over,
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('searchSubtitleCandidates', () => {
    it('merges results from every configured provider, tagged with their origin', async () => {
        const result = await searchSubtitleCandidates(
            QUERY,
            deps([
                provider('alpha', async () => [cand({ id: 'a1' })]),
                provider('beta', async () => [cand({ id: 'b1' })]),
            ]),
        );

        expect(result.map((c) => `${c.providerId}:${c.id}`).sort()).toEqual([
            'alpha:a1',
            'beta:b1',
        ]);
    });

    it('skips a provider that reports itself unconfigured', async () => {
        const search = vi.fn(async () => [cand()]);
        const result = await searchSubtitleCandidates(
            QUERY,
            deps([provider('nokey', search, async () => false)]),
        );

        expect(search).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('keeps the other providers when one throws', async () => {
        const result = await searchSubtitleCandidates(
            QUERY,
            deps([
                provider('broken', async () => {
                    throw new Error('upstream 500');
                }),
                provider('working', async () => [cand({ id: 'ok' })]),
            ]),
        );

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('ok');
    });

    it('drops candidates in a language nobody asked for', async () => {
        const result = await searchSubtitleCandidates(
            QUERY,
            deps([
                provider('alpha', async () => [
                    cand({ id: 'en', language: 'en' }),
                    cand({ id: 'fr', language: 'fr' }),
                ]),
            ]),
        );

        expect(result.map((c) => c.id)).toEqual(['en']);
    });

    it('ignores a candidate missing the fields the host must have', async () => {
        const result = await searchSubtitleCandidates(
            QUERY,
            deps([
                provider('sloppy', async () => [
                    { language: 'en', format: 'srt' } as SubtitleCandidate, // no id
                    cand({ id: 'good' }),
                ]),
            ]),
        );

        expect(result.map((c) => c.id)).toEqual(['good']);
    });
});

describe('rankCandidates', () => {
    const rank = (cs: SubtitleCandidate[]): string[] =>
        rankCandidates(
            cs.map((c) => ({ ...c, providerId: 'p' })),
            ['en', 'de'],
        ).map((c) => c.id);

    it('puts an exact hash match first, whatever its popularity', async () => {
        expect(
            rank([
                cand({ id: 'popular', downloadCount: 100_000 }),
                cand({ id: 'exact', hashMatch: true, downloadCount: 1 }),
            ]),
        ).toEqual(['exact', 'popular']);
    });

    it('orders by the viewer preference order, not alphabetically', async () => {
        expect(
            rank([cand({ id: 'german', language: 'de' }), cand({ id: 'english', language: 'en' })]),
        ).toEqual(['english', 'german']);
    });

    it('prefers language over a hash match in another language', async () => {
        // A perfectly-synced subtitle in a language the viewer does not read is
        // worth less than a merely-good one they do.
        expect(
            rank([
                cand({ id: 'de-exact', language: 'de', hashMatch: true }),
                cand({ id: 'en-plain', language: 'en' }),
            ]),
        ).toEqual(['en-plain', 'de-exact']);
    });

    it('breaks ties on download count', async () => {
        expect(
            rank([
                cand({ id: 'few', downloadCount: 5 }),
                cand({ id: 'many', downloadCount: 5000 }),
            ]),
        ).toEqual(['many', 'few']);
    });
});

describe('sidecarPathFor', () => {
    const video = '/media/movies/Awakening (2016)/Awakening (2016).mkv';

    it('writes beside the video, carrying the language in the name', () => {
        expect(sidecarPathFor(video, { language: 'en', format: 'srt' })).toBe(
            '/media/movies/Awakening (2016)/Awakening (2016).en.srt',
        );
    });

    it('marks forced and SDH tracks so players and humans can tell them apart', () => {
        expect(sidecarPathFor(video, { language: 'en', format: 'srt', isForced: true })).toBe(
            '/media/movies/Awakening (2016)/Awakening (2016).en.forced.srt',
        );
        expect(sidecarPathFor(video, { language: 'de', format: 'ass', isSDH: true })).toBe(
            '/media/movies/Awakening (2016)/Awakening (2016).de.sdh.ass',
        );
    });

    it('never lets a provider-supplied language escape the directory', () => {
        // `language` reaches us from third-party code and lands in a filesystem
        // path. A separator or traversal segment here would write outside the
        // media directory entirely.
        expect(() =>
            sidecarPathFor(video, { language: '../../etc/passwd', format: 'srt' }),
        ).toThrow(/language/);
        expect(() => sidecarPathFor(video, { language: 'en/x', format: 'srt' })).toThrow(
            /language/,
        );
    });

    it('disambiguates when a file of that name already exists', () => {
        const taken = new Set(['/media/movies/Awakening (2016)/Awakening (2016).en.srt']);
        expect(sidecarPathFor(video, { language: 'en', format: 'srt' }, taken)).toBe(
            '/media/movies/Awakening (2016)/Awakening (2016).en.2.srt',
        );
    });
});

describe('normalizeDownload', () => {
    it('accepts text content and returns a buffer', () => {
        const out = normalizeDownload({ content: 'WEBVTT\n', format: 'vtt' });
        expect(out.format).toBe('vtt');
        expect(out.bytes.toString('utf8')).toBe('WEBVTT\n');
    });

    it('accepts binary content', () => {
        const out = normalizeDownload({ content: new Uint8Array([1, 2, 3]), format: 'sub' });
        expect(out.bytes).toHaveLength(3);
    });

    it('rejects an empty download', () => {
        expect(() => normalizeDownload({ content: '', format: 'srt' })).toThrow(/empty/);
    });

    it('rejects a format the host cannot serve', () => {
        expect(() =>
            normalizeDownload({ content: 'x', format: 'exe' as unknown as 'srt' }),
        ).toThrow(/format/);
    });

    it('rejects content larger than the serving path will read back', () => {
        // The resolver refuses to read an external subtitle over 10 MB, so
        // accepting one here would write a file that can never be served.
        expect(() =>
            normalizeDownload({ content: 'x'.repeat(11 * 1024 * 1024), format: 'srt' }),
        ).toThrow(/too large/);
    });
});
