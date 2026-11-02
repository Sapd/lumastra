// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { login, request, redact, excerpt, BASE } from '../api-recipes/harness';
import type { Ids } from './endpoints';
export { request, redact, excerpt, BASE };
export const root = fileURLToPath(new URL('./data/', import.meta.url));
export const roles = ['user', 'admin'] as const;
export type Role = (typeof roles)[number];
export interface Snapshot {
    request: { method: 'GET'; path: string };
    status: number;
    contentType: string;
    body: unknown;
    baselineProblems?: string[];
}
export interface Index {
    ids: Ids;
    skipped: { key: string; reason: string }[];
    missingPublicOperations: string[];
}
export function only(): Set<string> | undefined {
    const at = process.argv.indexOf('--only');
    if (at < 0) return;
    const keys = process.argv
        .slice(at + 1)
        .flatMap((s) => s.split(','))
        .filter(Boolean);
    if (!keys.length) throw new Error('--only requires endpoint keys');
    return new Set(keys);
}
export async function roleLogin(role: Role): ReturnType<typeof login> {
    return login(
        role === 'admin' ? 'safetynet-admin' : 'sweepuser',
        role === 'admin' ? 'Kreditoren' : 'Users',
        role === 'admin',
    );
}
export async function save(path: string, value: unknown): Promise<void> {
    await mkdir(root, { recursive: true });
    await writeFile(path, JSON.stringify(redact(value), null, 2) + '\n');
}
export async function load<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, 'utf8')) as T;
}
// The spec reuses anchors heavily; the default alias cap treats that as an attack.
const spec = parse(await readFile(new URL('../../docs/api/api-v1.yaml', import.meta.url), 'utf8'), {
    maxAliasCount: -1,
}) as { paths: Record<string, { get?: unknown }> };
export function assertPublicGet(path: string): void {
    const pathname = new URL(path, BASE).pathname;
    if (
        !Object.entries(spec.paths).some(
            ([template, methods]) =>
                methods.get &&
                new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(pathname),
        )
    ) {
        throw new Error(`No public-spec GET operation for ${pathname}`);
    }
}
export async function capture(path: string, token: string): Promise<Snapshot> {
    assertPublicGet(path);
    const response = await request(path, token);
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    let body: unknown = text;
    if (contentType.includes('json') && text) body = JSON.parse(text);
    return { request: { method: 'GET', path }, status: response.status, contentType, body };
}
export function rows(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) return value.flatMap(rows);
    if (!value || typeof value !== 'object') return [];
    return [value as Record<string, unknown>, ...Object.values(value).flatMap(rows)];
}
export async function discover(token: string): Promise<Ids> {
    const ids: Ids = {};
    async function get(path: string): Promise<unknown> {
        const result = await capture(path, token);
        if (result.status !== 200)
            throw new Error(`Discovery GET ${path}: ${result.status} ${excerpt(result.body)}`);
        return result.body;
    }
    for (const kind of ['movie', 'series'] as const) {
        for (let offset = 0; ; offset += 100) {
            const result = (await get(`/api/v1/media?type=${kind}&limit=100&offset=${offset}`)) as {
                items: { id: string; availability?: { isAvailable?: boolean } }[];
                page: { hasMore: boolean };
            };
            if (!Array.isArray(result.items) || typeof result.page?.hasMore !== 'boolean')
                throw new Error('Media listing lacks items/page.hasMore');
            ids[kind] = result.items.find((r) => r.availability?.isAvailable)?.id;
            if (ids[kind] || !result.page.hasMore) break;
        }
    }
    if (ids.series) {
        ids.season = rows(await get(`/api/v1/series/${ids.series}/seasons`)).find(
            (r) => typeof r.id === 'string',
        )?.id as string | undefined;
        ids.episode = rows(await get(`/api/v1/series/${ids.series}/episodes`)).find(
            (r) =>
                typeof r.id === 'string' &&
                (r.availability as { hasFile?: boolean } | undefined)?.hasFile === true,
        )?.id as string | undefined;
    }
    for (const [key, path] of [
        ['album', '/api/v1/music/albums'],
        ['artist', '/api/v1/music/artists'],
        ['track', '/api/v1/music/tracks'],
        ['audiobook', '/api/v1/audiobooks'],
        ['audiobookAuthor', '/api/v1/audiobooks/authors'],
        ['audiobookSeries', '/api/v1/audiobooks/series'],
        ['channel', '/api/v1/livetv/stations'],
    ] as const) {
        // A role without access (e.g. no Live TV capability) has nothing to discover here; the
        // endpoint snapshot still records that 403 as its baseline.
        const result = await capture(path, token);
        if (result.status === 403) continue;
        if (result.status !== 200)
            throw new Error(`Discovery GET ${path}: ${result.status} ${excerpt(result.body)}`);
        ids[key] = rows(result.body).find((r) => typeof r.id === 'string')?.id as
            string | undefined;
    }
    if (ids.movie) {
        // Details are the default since package 11: credits are { cast|crew: [{ person: { id, ... } }] }.
        const detail = await get(`/api/v1/media/${ids.movie}`);
        const credited = rows(detail).filter((r) => 'character' in r || 'job' in r);
        const person = credited
            .map((r) => r.person as { id?: unknown } | undefined)
            .find((p) => typeof p?.id === 'string');
        ids.person =
            (person?.id as string | undefined) ??
            (rows(detail).find((r) => r.type === 'person' && typeof r.id === 'string')?.id as
                string | undefined);
    }
    return ids;
}
