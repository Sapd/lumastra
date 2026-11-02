// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in load for comparing stream proxy implementations (memory/CPU are sampled on the host,
// outside this file). Skipped unless RECIPES_PROXY_LOAD_SECONDS is set. Plays
// RECIPES_PROXY_LOAD_STATIONS stations (default 2) through the public API, follows the first
// variant of each master and downloads every new segment, like a player would.
import { test, expect } from 'vitest';
import { clientFor, expectOk, records } from './client';
import { BASE, request } from './harness';

const seconds = Number(process.env.RECIPES_PROXY_LOAD_SECONDS ?? 0);
const stationCount = Number(process.env.RECIPES_PROXY_LOAD_STATIONS ?? 2);
const token = process.env.RECIPES_LIVETV_TOKEN ?? process.env.RECIPES_TOKEN ?? null;
const client = clientFor(token ?? undefined);

interface Stats {
    stationId: string;
    playlists: number;
    segments: number;
    bytes: number;
    errors: string[];
    maxGapMs: number;
}

async function text(url: string): Promise<string> {
    const response = await request(url, token, { signal: AbortSignal.timeout(20000) });
    const body = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${url.split('?')[0]}`);
    return body;
}

function uris(playlist: string, base: string): string[] {
    return playlist
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => new URL(line, base).toString());
}

async function play(stationId: string, until: number): Promise<Stats> {
    const stats: Stats = {
        stationId,
        playlists: 0,
        segments: 0,
        bytes: 0,
        errors: [],
        maxGapMs: 0,
    };
    const start = expectOk(
        'POST',
        '/livetv/playback-sessions',
        await client.POST('/api/v1/livetv/playback-sessions', { body: { stationId } }),
    );
    const playbackSessionId = String(start.playbackSessionId);
    try {
        const master = new URL(String(start.delivery.url), BASE).toString();
        const masterText = await text(master);
        const media = masterText.includes('#EXT-X-STREAM-INF')
            ? uris(masterText, master)[0]
            : master;
        const seen = new Set<string>();
        let lastSegmentAt = Date.now();
        let lastKeepalive = Date.now();
        while (Date.now() < until) {
            try {
                const list = await text(media);
                stats.playlists++;
                for (const segment of uris(list, media)) {
                    const key = segment.split('?')[0];
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const response = await request(segment, token, {
                        signal: AbortSignal.timeout(20000),
                    });
                    const body = new Uint8Array(await response.arrayBuffer());
                    if (!response.ok) throw new Error(`${response.status} segment`);
                    stats.segments++;
                    stats.bytes += body.byteLength;
                    const now = Date.now();
                    stats.maxGapMs = Math.max(stats.maxGapMs, now - lastSegmentAt);
                    lastSegmentAt = now;
                }
            } catch (error) {
                stats.errors.push(String(error));
            }
            if (Date.now() - lastKeepalive > 15000) {
                await client.POST(
                    '/api/v1/livetv/playback-sessions/{playbackSessionId}/keepalive',
                    {
                        params: { path: { playbackSessionId } },
                    },
                );
                lastKeepalive = Date.now();
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    } finally {
        await client.DELETE('/api/v1/livetv/playback-sessions/{playbackSessionId}', {
            params: { path: { playbackSessionId } },
        });
    }
    return stats;
}

test.skipIf(!seconds)(
    '99 Live TV proxy load (opt-in)',
    async () => {
        const stations = expectOk(
            'GET',
            '/livetv/stations',
            await client.GET('/api/v1/livetv/stations'),
        );
        const ids = records(stations)
            .map((r) => r.id)
            .filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id))
            .slice(0, stationCount);
        expect(ids.length).toBeGreaterThan(0);
        const until = Date.now() + seconds * 1000;
        console.log(`LOAD_START ${new Date().toISOString()} stations=${ids.length}`);
        const results = await Promise.all(ids.map((id) => play(id, until)));
        console.log(`LOAD_END ${new Date().toISOString()}`);
        console.log(`LOAD_RESULT ${JSON.stringify(results)}`);
        for (const result of results) expect(result.segments).toBeGreaterThan(0);
    },
    (seconds + 120) * 1000,
);
