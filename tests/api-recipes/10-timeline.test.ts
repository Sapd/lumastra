// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owner: package 9. A package that changes this area updates this recipe in the same commit.
// Recipe: show chapters, scrubbing thumbnails and a skip-intro button, from a bare token.
import { test, expect } from 'vitest';
import { client, expectOk, reachable, records } from './client';
import { request } from './harness';

type Timeline = {
    fileId: string;
    durationMs: number;
    chapters: { index: number; name: string; startMs: number; endMs: number; image?: { href: string } | null }[];
    segments: { type: string; startMs: number; endMs: number }[];
    trickplay: { state: string; variants: { width: number; manifestHref: string }[] };
};

async function getJson(href: string): Promise<unknown> {
    const response = await request(href, process.env.RECIPES_TOKEN!, {
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GET ${href}: ${response.status}`);
    expect(response.headers.get('content-type') ?? '').toMatch(/json/i);
    return response.json();
}

async function check(id: string): Promise<{ chapters: number; segments: number; sheets: number; subtitles: number }> {
    const timeline = expectOk(
        'GET',
        '/playback/{id}/timeline',
        await client.GET('/api/v1/playback/{id}/timeline', { params: { path: { id } } }),
    ) as Timeline;
    // One call: the server resolves the file and echoes it; every time is an integer in ms.
    expect(typeof timeline.fileId).toBe('string');
    expect(Number.isInteger(timeline.durationMs)).toBe(true);
    for (const c of timeline.chapters) {
        expect(Number.isInteger(c.startMs) && Number.isInteger(c.endMs)).toBe(true);
        expect(c.endMs).toBeGreaterThanOrEqual(c.startMs);
    }
    for (const s of timeline.segments) {
        expect(['intro', 'outro', 'recap', 'preview', 'commercial']).toContain(s.type);
        expect(s.endMs).toBeGreaterThanOrEqual(s.startMs);
    }
    // Chapter thumbnails are ready URLs: no building, no parent walking.
    const withImage = timeline.chapters.find((c) => c.image?.href);
    if (withImage) await reachable(withImage.image!.href, 'image');
    // Scrubbing: the variant's manifest is JSON with ready sheet hrefs.
    let sheets = 0;
    const variant = timeline.trickplay.variants[0];
    if (variant) {
        const manifest = (await getJson(variant.manifestHref)) as {
            fileId: string; width: number; intervalMs: number; tileColumns: number; tileRows: number;
            thumbnailCount: number; sheets: { index: number; startMs: number; endMs: number; href: string }[];
        };
        expect(manifest.fileId).toBe(timeline.fileId);
        expect(manifest.width).toBe(variant.width);
        expect(manifest.sheets.length).toBeGreaterThan(0);
        sheets = manifest.sheets.length;
        await reachable(manifest.sheets[0].href, 'image');
    }
    // Subtitle hrefs are grant-bearing resources from the start envelope.
    const start = expectOk(
        'POST',
        '/play-sessions',
        await client.POST('/api/v1/play-sessions', { body: { mediaId: id, deviceId: 'api-recipes-timeline' } }),
    );
    let subtitles = 0;
    try {
        const delivery = start.delivery;
        for (const track of ('subtitles' in delivery ? delivery.subtitles : []) ?? []) {
            if (track.format === 'text' && track.hrefs.text) {
                const response = await request(track.hrefs.text, process.env.RECIPES_TOKEN!, {
                    signal: AbortSignal.timeout(30000),
                });
                expect(response.status).toBeLessThan(300);
                await response.body?.cancel();
                subtitles += 1;
                break;
            }
        }
    } finally {
        expectOk('POST', '/play-sessions/{id}/cancel', await client.POST(
            '/api/v1/play-sessions/{id}/cancel', { params: { path: { id: start.playbackSessionId } } },
        ));
    }
    return { chapters: timeline.chapters.length, segments: timeline.segments.length, sheets, subtitles };
}

async function candidates(): Promise<{ movies: string[]; episodes: string[] }> {
    // Discovery through browse (one call): movies directly, episodes via their series.
    const browse = expectOk(
        'GET',
        '/browse',
        await client.GET('/api/v1/browse', {}),
    ) as { recentlyAdded?: { id: string; type: string }[] };
    const seen = new Set<string>();
    const rows = records(browse).filter(
        (r): r is { id: string; type: string } =>
            typeof r.id === 'string' && (r.type === 'movie' || r.type === 'series') && !seen.has(r.id) && !!seen.add(r.id),
    );
    const movies = rows.filter((r) => r.type === 'movie').map((r) => r.id);
    const episodes: string[] = [];
    for (const series of rows.filter((r) => r.type === 'series').slice(0, 8)) {
        const eps = expectOk(
            'GET',
            '/series/{id}/episodes',
            await client.GET('/api/v1/series/{id}/episodes', { params: { path: { id: series.id } } }),
        );
        for (const r of records(eps))
            if (typeof r.id === 'string' && (r.availability as { hasFile?: boolean } | undefined)?.hasFile === true) {
                episodes.push(r.id);
                break;
            }
    }
    return { movies, episodes };
}

test('10 timeline → chapters, skip segments, trickplay sheets, subtitle hrefs (episode and movie)', async (ctx) => {
    const found = await candidates();
    if (!found.movies.length && !found.episodes.length) return ctx.skip('Instance has no playable content');
    const results: Record<string, unknown> = {};
    // Walk a few items so the report shows at least one with chapters/segments/trickplay when it exists.
    for (const [kind, ids] of [['episode', found.episodes], ['movie', found.movies]] as const)
        results[kind] = await Promise.all(ids.slice(0, 12).map(async (id) => ({ id, ...(await check(id)) })));
    console.log('[timeline recipe]', JSON.stringify(results));
});
