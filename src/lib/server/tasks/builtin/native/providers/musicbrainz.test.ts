// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * musicbrainz.ts `mbGet()` outage-masking regression.
 *
 * Before this fix, `mbGet()` returned `null` on ANY non-ok HTTP response
 * (429, 5xx, other 4xx) — the same value it returns for MusicBrainz's
 * genuine "no such entity" 404. `search()` then returned `[]` for a total
 * MusicBrainz outage, indistinguishable from "no matches", and auto-match
 * flows recorded the outage as a confident negative match.
 *
 * These tests lock in the fixed contract:
 *   - 404 (genuine no-data, MusicBrainz's by-id "not found" response) still
 *     resolves to `null` — search()/detail() treat it as a miss;
 *   - any other non-ok status (429, 5xx) THROWS instead of returning null,
 *     and that throw propagates out through search() and detail();
 *   - a malformed (non-UUID) mbid is rejected before any network call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: { registerProvider: vi.fn() },
}));

import { musicbrainzProvider } from './musicbrainz.js';

type MockHttp = NonNullable<PluginContext['http']> & {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
};

function makeCtx(http: MockHttp): PluginContext {
    return mockContext({ logger: mockLogger(), http, signal: new AbortController().signal });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

const VALID_MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';

describe('musicbrainzProvider — outage-masking regression', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('search() propagates a thrown error on a total outage (503) instead of returning []', async () => {
        const http: MockHttp = {
            get: vi
                .fn<(url: string, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(jsonResponse([], 503)),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(
            musicbrainzProvider.search!(ctx, { type: 'recording', query: 'Test Song' }),
        ).rejects.toThrow(/MusicBrainz request failed/i);
    });

    it('search() propagates a thrown error on rate-limiting (429)', async () => {
        const http: MockHttp = {
            get: vi
                .fn<(url: string, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(jsonResponse([], 429)),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(
            musicbrainzProvider.search!(ctx, { type: 'artist', query: 'Test Artist' }),
        ).rejects.toThrow(/MusicBrainz request failed/i);
    });

    it('search() still resolves normally (no throw) on a healthy 200 response', async () => {
        const http: MockHttp = {
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>().mockResolvedValue(
                jsonResponse({
                    count: 1,
                    offset: 0,
                    recordings: [{ id: 'r1', title: 'Test Song' }],
                }),
            ),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        const results = await musicbrainzProvider.search!(ctx, {
            type: 'recording',
            query: 'Test Song',
        });
        expect(results).toHaveLength(1);
    });

    it('detail("release:<mbid>") throws a distinguishable outage error on 500 (not "not found")', async () => {
        const http: MockHttp = {
            get: vi
                .fn<(url: string, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(jsonResponse({}, 500)),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(musicbrainzProvider.detail!(ctx, `release:${VALID_MBID}`)).rejects.toThrow(
            /MusicBrainz request failed/i,
        );
    });

    it('detail("release:<mbid>") still throws "not found" on a genuine 404 (no outage)', async () => {
        const http: MockHttp = {
            get: vi
                .fn<(url: string, opts?: RequestInit) => Promise<Response>>()
                .mockResolvedValue(jsonResponse({}, 404)),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(musicbrainzProvider.detail!(ctx, `release:${VALID_MBID}`)).rejects.toThrow(
            /not found/i,
        );
    });

    it('rejects a malformed (non-UUID) mbid before making any network call', async () => {
        const http: MockHttp = {
            get: vi.fn<(url: string, opts?: RequestInit) => Promise<Response>>(),
            post: vi.fn<(url: string, body: unknown, opts?: RequestInit) => Promise<Response>>(),
        };
        const ctx = makeCtx(http);

        await expect(musicbrainzProvider.detail!(ctx, 'release:not-a-real-mbid')).rejects.toThrow(
            /not found/i,
        );
        expect(http.get).not.toHaveBeenCalled();
    });
});
