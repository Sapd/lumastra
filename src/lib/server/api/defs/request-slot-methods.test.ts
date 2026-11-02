// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `request.queryMethods` / `request.bodyMethods`: a def that serves several
 * methods at one path can keep a GET list query and a POST/PUT body without
 * the other methods validating or documenting them.
 *
 * Part 1 drives mount() with a small def. Part 2 reads the committed public
 * spec and pins the operations that used to carry copied list params or a
 * copied request body.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { def as dismissDef } from './for-you/dismiss.js';

function event(method: string, url: string, body?: unknown): RequestEvent {
    return {
        url: new URL(url),
        request: new Request(url, {
            method,
            ...(body === undefined
                ? {}
                : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        }),
        params: {},
        route: { id: url },
        locals: {},
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

const def = defineEndpoint({
    auth: { kind: 'public' },
    request: {
        query: z.object({ limit: z.coerce.number().int().min(1) }),
        queryMethods: ['GET'],
        body: z.object({ name: z.string().min(1) }),
        bodyMethods: ['POST'],
    },
    handlers: {
        GET: async () => new Response('get'),
        POST: async () => new Response('post'),
        DELETE: async () => new Response('delete'),
    },
});

describe('request.queryMethods / bodyMethods in mount()', () => {
    const { GET, POST, DELETE } = mount(def, { surface: 'v1' });

    it('validates the query on the listed method', async () => {
        expect((await GET!(event('GET', 'http://localhost/x?limit=abc'))).status).toBe(422);
        expect((await GET!(event('GET', 'http://localhost/x?limit=3'))).status).toBe(200);
    });

    it('does not validate the query on a method it is not listed for', async () => {
        const res = await POST!(event('POST', 'http://localhost/x?limit=abc', { name: 'a' }));
        expect(res.status).toBe(200);
    });

    it('validates the body on the listed method', async () => {
        expect((await POST!(event('POST', 'http://localhost/x', {}))).status).toBe(422);
    });

    it('does not validate the body on a method it is not listed for', async () => {
        expect((await DELETE!(event('DELETE', 'http://localhost/x'))).status).toBe(200);
    });
});

interface Operation {
    parameters?: { in: string; name: string }[];
    requestBody?: unknown;
}

const spec = parse(readFileSync(resolve(process.cwd(), 'docs/api/api-v1.yaml'), 'utf8'), {
    maxAliasCount: -1,
}) as {
    paths: Record<string, Record<string, Operation>>;
};

function queryNames(path: string, method: string): string[] {
    return (spec.paths[path]?.[method]?.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => p.name);
}

describe('public spec: create operations declare no list or paging params', () => {
    it.each([
        '/api/v1/requests',
        '/api/v1/playlists',
        '/api/v1/playlists/{id}/members',
        '/api/v1/media/{id}/comments',
        '/api/v1/people/{id}/comments',
        '/api/v1/playlists/{id}/comments',
        '/api/v1/me/pats',
        '/api/v1/media/{id}/renditions',
        '/api/v1/watch-together/{code}/events',
    ])('POST %s has no query parameters', (path) => {
        expect(spec.paths[path]?.post).toBeDefined();
        expect(queryNames(path, 'post')).toEqual([]);
    });

    it('keeps the list params on the matching GET', () => {
        expect(queryNames('/api/v1/requests', 'get')).toContain('scope');
        expect(queryNames('/api/v1/media/{id}/comments', 'get')).toContain('limit');
    });
});

describe('public spec: DELETE operations take no request body', () => {
    // Genuinely body-carrying DELETEs: no path id names the target.
    const KEPT = new Set(['/api/v1/watchlist']);

    it('lists no DELETE with a requestBody beyond the kept ones', () => {
        const withBody = Object.entries(spec.paths)
            .filter(([path, item]) => item.delete?.requestBody !== undefined && !KEPT.has(path))
            .map(([path]) => path);
        expect(withBody).toEqual([]);
    });
});

describe('for-you/dismiss: DELETE identifies the flag by query, POST by body', () => {
    it('documents the DELETE fields as query parameters', () => {
        const names = queryNames('/api/v1/for-you/dismiss', 'delete');
        expect(names.sort()).toEqual(['flagType', 'targetId', 'targetType']);
        expect(dismissDef.docs?.DELETE?.body).toBeUndefined();
        expect(dismissDef.docs?.POST?.body).toBeDefined();
    });
});

describe('public spec: camelCase names', () => {
    // Native device approval deliberately shares RFC 8628's user_code spelling
    // with device-code responses and approval bodies. Keep this exception scoped
    // to its published operation, rather than permitting user_code everywhere.
    const STANDARD_QUERY_PARAMETERS = new Set(['GET /api/v1/oauth/device/approve ?user_code']);

    it('declares no snake_case query parameter beyond standards-defined names', () => {
        const snake: string[] = [];
        for (const [path, item] of Object.entries(spec.paths)) {
            for (const [method, op] of Object.entries(item)) {
                for (const p of op.parameters ?? []) {
                    if (p.in === 'query' && /^[a-z0-9]+_[a-z0-9_]+$/.test(p.name)) {
                        const parameter = `${method.toUpperCase()} ${path} ?${p.name}`;
                        if (!STANDARD_QUERY_PARAMETERS.has(parameter)) snake.push(parameter);
                    }
                }
            }
        }
        expect(snake).toEqual([]);
    });

    it('names the rendition response fields in camelCase', () => {
        const schemas = (
            spec as unknown as { components: { schemas: Record<string, { properties?: object }> } }
        ).components.schemas;
        for (const name of ['Rendition', 'RenditionList', 'DownloadRung']) {
            const keys = Object.keys(schemas[name]?.properties ?? {});
            expect(keys.length).toBeGreaterThan(0);
            expect(keys.filter((k) => k.includes('_'))).toEqual([]);
        }
    });
});
