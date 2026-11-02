// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import createClient from 'openapi-fetch';
import type { paths } from './generated/api-v1';
import { BASE, excerpt, request, safeTarget } from './harness';
// servers is an origin; the public spec already includes /api/v1 in every resource path.
export function clientFor(token: string | undefined): ReturnType<typeof createClient<paths>> {
    return createClient<paths>({
        baseUrl: BASE,
        headers: { Authorization: `Bearer ${token}` },
        fetch: (req) => {
            const url = safeTarget(req.url);
            if (url.origin !== safeTarget().origin)
                throw new Error('Refusing cross-origin bearer request');
            return fetch(req, {
                redirect: 'manual',
                signal: AbortSignal.any([req.signal, AbortSignal.timeout(20000)]),
            });
        },
    });
}
export const client = clientFor(process.env.RECIPES_TOKEN);
/**
 * A step today's API cannot do the way a third-party client should (a finding, owned by a
 * rework package). The step must still FAIL today; once the owning package fixes it, this
 * throws and tells you to turn the step into a plain assertion.
 */
export async function knownGap(
    owner: string,
    gap: string,
    step: () => Promise<unknown>,
): Promise<void> {
    let passed = false;
    try {
        await step();
        passed = true;
    } catch (err) {
        console.warn(
            `[known gap, ${owner}] ${gap}: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (passed)
        throw new Error(
            `Known gap fixed (${owner}): "${gap}" now works — make it a normal step in this recipe.`,
        );
}
export function expectOk<T>(
    method: string,
    path: string,
    result: { response: Response; data?: T; error?: unknown },
): T {
    if (!result.response.ok)
        throw new Error(`${method} ${path}: ${result.response.status} ${excerpt(result.error)}`);
    return result.data as T;
}
export function records(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(records);
    if (!value || typeof value !== 'object') return [];
    return [value as Record<string, unknown>, ...Object.values(value).flatMap(records)];
}
export function responseUrl(value: unknown, kind: 'image' | 'stream'): string | undefined {
    for (const row of records(value))
        for (const [k, v] of Object.entries(row)) {
            if (typeof v !== 'string' || !/^(\/|https?:)/.test(v)) continue;
            if (
                kind === 'image'
                    ? /^(image|poster|posterUrl|href|thumb)$/.test(k)
                    : /stream.?(url|href)|direct.*url|hls.*url|manifest.?url/i.test(k)
            )
                return v;
        }
}
export async function reachable(
    url: string | undefined,
    kind: 'image' | 'stream',
    timeout = 20000,
    token: string | null = process.env.RECIPES_TOKEN!,
): Promise<void> {
    if (!url) throw new Error(`Response has no ready-to-use ${kind} URL`);
    const response = await request(url, token, {
        signal: AbortSignal.timeout(timeout),
        headers: kind === 'stream' ? { Range: 'bytes=0-4095' } : {},
    });
    const type = response.headers.get('content-type') ?? '';
    let playlist = false;
    if (kind === 'stream' && !/mpegurl|^audio\/|^video\//i.test(type) && response.body) {
        const reader = response.body.getReader();
        try {
            const first = await reader.read();
            const head = new TextDecoder().decode(first.value?.subarray(0, 4096));
            playlist = head.trimStart().startsWith('#EXTM3U');
            if (!response.ok)
                throw new Error(
                    `GET ${excerpt(url)}: ${response.status} ${type} ${excerpt(head.slice(0, 300))}`,
                );
        } finally {
            await reader.cancel();
        }
    } else if (response.ok) {
        await response.body?.cancel();
    } else {
        const body = await response.text().catch(() => '');
        throw new Error(
            `GET ${excerpt(url)}: ${response.status} ${type} ${excerpt(body.slice(0, 300))}`,
        );
    }
    if (
        !response.ok ||
        !(playlist || (kind === 'image' ? /^image\//i : /mpegurl|^audio\/|^video\//i).test(type))
    ) {
        throw new Error(`GET ${excerpt(url)}: ${response.status} ${type}; expected ${kind}`);
    }
}
// Finding: packages 2/14 (music) and 5/8 (audiobooks) must return delivery hrefs.
export function todayHandBuiltUrl(kind: 'track' | 'audiobook', id: string, ino?: string): string {
    if (kind === 'track') return `/api/v1/music/tracks/${encodeURIComponent(id)}/stream`;
    if (!ino) throw new Error('Audiobook start has no track ino or stream URL');
    return `/api/v1/audiobook/${encodeURIComponent(id)}/file/${encodeURIComponent(ino)}`;
}
export async function episode(): Promise<
    { id: string; seriesId: string; seasonId?: string } | undefined
> {
    // Browse supports pagination: never confuse a failed discovery call with no content.
    for (let offset = 0; ; offset += 100) {
        const data = expectOk(
            'GET',
            '/media',
            await client.GET('/api/v1/media', {
                params: { query: { type: 'series', limit: 100, offset } },
            }),
        );
        if (!data.items || typeof data.page?.hasMore !== 'boolean')
            throw new Error('Media listing lacks items/page.hasMore');
        for (const series of data.items.filter((s) => s.availability?.isAvailable)) {
            expectOk(
                'GET',
                '/series/{id}',
                await client.GET('/api/v1/series/{id}', { params: { path: { id: series.id } } }),
            );
            const seasons = expectOk(
                'GET',
                '/series/{id}/seasons',
                await client.GET('/api/v1/series/{id}/seasons', {
                    params: { path: { id: series.id } },
                }),
            );
            const eps = expectOk(
                'GET',
                '/series/{id}/episodes',
                await client.GET('/api/v1/series/{id}/episodes', {
                    params: { path: { id: series.id } },
                }),
            );
            const playable = records(eps).find(
                (r) =>
                    typeof r.id === 'string' &&
                    (r.availability as { hasFile?: boolean } | undefined)?.hasFile === true,
            );
            if (playable)
                return {
                    id: String(playable.id),
                    seriesId: series.id,
                    seasonId: records(seasons).find((r) => typeof r.id === 'string')?.id as
                        string | undefined,
                };
        }
        if (!data.page.hasMore) return;
    }
}
