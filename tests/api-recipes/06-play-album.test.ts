// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 2/14/5. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { client, expectOk, records } from './client';
import { request, safeTarget } from './harness';

// The checked-in recipe types predate unified start. Keep this HTTP-only projection
// until those types are refreshed; do not route this journey through the web client.
interface StartResponse {
    playbackSessionId: string;
    kind: 'music';
    delivery: { kind: 'file'; url: string; startPositionMs: number };
    grant: { token: string; param: 'grant' };
    reporting: { playbackSessionId: string; href: string; intervalMs: number; unit: 'ms' };
}

test('06 album → tracks → stream → listen report', async (ctx) => {
    const albums = expectOk('GET', '/music/albums', await client.GET('/api/v1/music/albums'));
    const album = records(albums).find((r) => typeof r.id === 'string');
    if (!album) return ctx.skip('Instance has no music albums');
    const detail = expectOk(
        'GET',
        '/music/albums/{id}',
        await client.GET('/api/v1/music/albums/{id}', {
            params: { path: { id: String(album.id) } },
        }),
    );
    // The album detail is a flat Album DTO: `tracks` holds Track DTOs (UUID id, durationMs, images.primary).
    const track = (detail.tracks ?? []).find((t) => typeof t.id === 'string' && t.type === 'track');
    expect(track, 'Album must contain playable tracks').toBeTruthy();
    const id = String(track!.id);
    const response = await request('/api/v1/play-sessions', process.env.RECIPES_TOKEN!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mediaId: id,
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
        expect(start.kind).toBe('music');
        expect(start.delivery.kind).toBe('file');
        const url = safeTarget(start.delivery.url);
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
                    positionMs: start.delivery.startPositionMs + 1000,
                    listenedMs: 1000,
                    sessionElapsedMs: 1000,
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
                    positionMs: start.delivery.startPositionMs + 1000,
                    listenedMs: 1000,
                    sessionElapsedMs: 1000,
                    eventSeq: 2,
                    status: 'COMPLETED',
                    endReason: 'user',
                }),
            }),
        });
    }
});
