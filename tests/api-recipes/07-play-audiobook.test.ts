// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 5/8 (audiobook delivery/listening). A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk } from './client';
import { request, safeTarget } from './harness';

// The checked-in recipe types predate unified start. Keep this HTTP-only projection
// until those types are refreshed; do not route this journey through the web client.
interface StartResponse {
    playbackSessionId: string;
    kind: 'audiobook';
    delivery: { kind: 'multipart-audio'; tracks: { url: string }[]; startPositionMs: number };
    grant: { token: string; param: 'grant' };
    reporting: { playbackSessionId: string; href: string; intervalMs: number; unit: 'ms' };
}

test('07 audiobook → start → stream → listen report → stop', async (ctx) => {
    let book: { id: string } | undefined;
    for (let offset = 0; ; offset += 100) {
        const books = expectOk(
            'GET',
            '/audiobooks',
            await client.GET('/api/v1/audiobooks', {
                params: { query: { offset, limit: 100, sort: 'title', order: 'asc' } },
            }),
        );
        book = books.items[0];
        if (book || !books.page.hasMore) break;
    }
    if (!book) return ctx.skip('Instance has no available audiobook library content');
    // Author page: list authors, open one, list its books (package 18).
    const authors = expectOk(
        'GET',
        '/audiobooks/authors',
        await client.GET('/api/v1/audiobooks/authors', { params: { query: { limit: 5 } } }),
    );
    const author = authors.items[0];
    if (author) {
        expectOk(
            'GET',
            '/audiobooks/authors/{id}',
            await client.GET('/api/v1/audiobooks/authors/{id}', {
                params: { path: { id: author.id } },
            }),
        );
        expectOk(
            'GET',
            '/audiobooks/authors/{id}/books',
            await client.GET('/api/v1/audiobooks/authors/{id}/books', {
                params: { path: { id: author.id } },
            }),
        );
    }
    // Continue a series: pick a series, read its next-up book and ordered list.
    const seriesList = expectOk(
        'GET',
        '/audiobooks/series',
        await client.GET('/api/v1/audiobooks/series', { params: { query: { limit: 5 } } }),
    );
    const series = seriesList.items[0];
    if (series) {
        expectOk(
            'GET',
            '/audiobooks/series/{id}',
            await client.GET('/api/v1/audiobooks/series/{id}', {
                params: { path: { id: series.id } },
            }),
        );
        expectOk(
            'GET',
            '/audiobooks/series/{id}/books',
            await client.GET('/api/v1/audiobooks/series/{id}/books', {
                params: { path: { id: series.id } },
            }),
        );
    }
    expectOk(
        'GET',
        '/media/{id}',
        await client.GET('/api/v1/media/{id}', { params: { path: { id: book.id } } }),
    );
    const response = await request('/api/v1/play-sessions', process.env.RECIPES_TOKEN!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mediaId: book.id,
            deviceId: 'api-recipes',
            capabilities: {
                containers: ['mp3', 'mp4', 'flac', 'ogg', 'audio/mpeg', 'audio/mp4'],
                videoCodecs: [],
                audioCodecs: ['mp3', 'aac', 'flac', 'opus'],
                subtitleFormats: [],
                hdr: [],
            },
        }),
    });
    expectOk('POST', '/play-sessions', { response });
    const start = (await response.json()) as StartResponse;
    try {
        expect(start.kind).toBe('audiobook');
        expect(start.delivery.kind).toBe('multipart-audio');
        expect(
            start.delivery.tracks.length,
            'Audiobook must contain playable tracks',
        ).toBeGreaterThan(0);
        const url = safeTarget(start.delivery.tracks[0].url);
        expect(start.playbackSessionId).toBeTruthy();
        expect(start.reporting.playbackSessionId).toBe(start.playbackSessionId);
        expect(start.reporting.unit).toBe('ms');
        expect(start.reporting.intervalMs).toBeGreaterThan(0);
        expect(start.grant.param).toBe('grant');
        expect(url.searchParams.get('grant')).toBe(start.grant.token);
        expect(start.grant.token).toBeTruthy();
        // Delivery must work using only its URL grant, without account credentials.
        const stream = await fetch(url, {
            headers: { Range: 'bytes=0-4095' },
            redirect: 'manual',
            signal: AbortSignal.timeout(20000),
        });
        try {
            expect(stream.ok, `Delivery returned ${stream.status}`).toBe(true);
            expect(stream.headers.get('content-type')).toMatch(/^audio\/|^video\//i);
        } finally {
            await stream.body?.cancel();
        }
        expectOk('PUT', '/play-sessions report', {
            response: await request(start.reporting.href, process.env.RECIPES_TOKEN!, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    positionMs: start.delivery.startPositionMs,
                    listenedMs: 0,
                    sessionElapsedMs: 0,
                    eventSeq: 1,
                    status: 'ACTIVE',
                }),
            }),
        });
    } finally {
        expectOk('PUT', '/play-sessions stop', {
            response: await request(start.reporting.href, process.env.RECIPES_TOKEN!, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    positionMs: start.delivery.startPositionMs,
                    listenedMs: 0,
                    sessionElapsedMs: 0,
                    eventSeq: 2,
                    status: 'COMPLETED',
                    endReason: 'user',
                }),
            }),
        });
    }
});
