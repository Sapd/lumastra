// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
    applyLocalizedParameters,
    applyPublicTaxonomy,
    LOCALIZED_OPERATIONS,
    operationIdProblem,
    taxonomyPath,
    type TaxonomyGroup,
} from './public-taxonomy';

interface Spec {
    tags?: { name: string; description?: string }[];
    'x-tagGroups'?: { name: string; tags: string[] }[];
    paths: Record<string, Record<string, Record<string, unknown>>>;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
const STABILITY = ['stable', 'beta', 'experimental', 'protocol', 'deprecated'];

const spec = parse(readFileSync(resolve(__dirname, '../../docs/api/api-v1.yaml'), 'utf-8'), {
    maxAliasCount: -1,
}) as Spec;

const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((m) => ({
        key: `${m.toUpperCase()} ${taxonomyPath(path)}`,
        path: taxonomyPath(path),
        op: item[m],
    })),
);

describe('public API taxonomy (committed docs/api/api-v1.yaml)', () => {
    it('has operations to check', () => {
        expect(operations.length).toBeGreaterThan(300);
    });

    it('puts every operation in exactly one tag that a tag group lists', () => {
        const grouped = new Set((spec['x-tagGroups'] ?? []).flatMap((g) => g.tags));
        const bad = operations
            .filter(({ op }) => {
                const tags = op.tags as string[] | undefined;
                return !tags || tags.length !== 1 || !grouped.has(tags[0]);
            })
            .map(({ key, op }) => `${key} → ${JSON.stringify(op.tags)}`);
        expect(bad).toEqual([]);
    });

    it('lists every declared tag in exactly one group, in the same order', () => {
        const groupedTags = (spec['x-tagGroups'] ?? []).flatMap((g) => g.tags);
        expect(new Set(groupedTags).size).toBe(groupedTags.length);
        expect(groupedTags).toEqual((spec.tags ?? []).map((t) => t.name));
        for (const tag of spec.tags ?? []) expect(tag.description, tag.name).toBeTruthy();
    });

    it('gives every operation a unique, well-shaped operationId', () => {
        const seen = new Map<string, string>();
        const bad: string[] = [];
        for (const { key, path, op } of operations) {
            const id = op.operationId;
            if (typeof id !== 'string') {
                bad.push(`${key}: no operationId`);
                continue;
            }
            const other = seen.get(id);
            if (other) bad.push(`${key}: operationId ${id} also used by ${other}`);
            seen.set(id, key);
            const problem = operationIdProblem(id, path);
            if (problem) bad.push(`${key}: ${id} ${problem}`);
        }
        expect(bad).toEqual([]);
    });

    it('labels every operation with a known stability tier', () => {
        const bad = operations
            .filter(({ op }) => !STABILITY.includes(op['x-stability'] as string))
            .map(({ key, op }) => `${key} → ${String(op['x-stability'])}`);
        expect(bad).toEqual([]);
    });

    it('points every localized operation to the shared Accept-Language parameter', () => {
        const ref = '#/components/parameters/AcceptLanguage';
        const missing = LOCALIZED_OPERATIONS.filter((key) => {
            const found = operations.find((o) => o.key === key);
            return !(found?.op.parameters as { $ref?: string }[] | undefined)?.some((p) => p.$ref === ref);
        });
        expect(missing).toEqual([]);
    });

    it('marks deprecated operations the standard way, with a replacement', () => {
        const bad = operations
            .filter(({ op }) => op['x-stability'] === 'deprecated' || op.deprecated === true)
            .filter(({ op }) => {
                const d = op['x-deprecation'] as { replacement?: string } | undefined;
                return op.deprecated !== true || op['x-stability'] !== 'deprecated' || !d?.replacement;
            })
            .map(({ key }) => key);
        expect(bad).toEqual([]);
    });
});

describe('applyPublicTaxonomy', () => {
    const taxonomy: TaxonomyGroup[] = [
        {
            name: 'Library',
            tags: [{ name: 'Media', description: 'm', operations: { 'GET /media/{id}': 'getMediaItem' } }],
        },
        { name: 'Music', tags: [{ name: 'Music', description: 'x', operations: { 'GET /music/albums': 'listAlbums' } }] },
        { name: 'Empty', tags: [{ name: 'Unused', description: 'u', operations: {} }] },
    ];

    it('sets tag and operationId and emits only used tags and groups', () => {
        const paths = {
            '/api/v1/media/{id}': { get: { tags: ['Old'], operationId: 'getMediaId', 'x-stability': 'stable' } },
            '/api/v1/music/albums': { get: { tags: ['Old'], 'x-stability': 'beta' } },
        };
        const result = applyPublicTaxonomy(paths, taxonomy);
        expect(result.problems).toEqual([]);
        expect(paths['/api/v1/media/{id}'].get).toEqual({
            tags: ['Media'],
            operationId: 'getMediaItem',
            'x-stability': 'stable',
        });
        expect(paths['/api/v1/music/albums'].get.tags).toEqual(['Music']);
        expect(result.tagGroups).toEqual([
            { name: 'Library', tags: ['Media'] },
            { name: 'Music', tags: ['Music'] },
        ]);
        expect(result.tags.map((t) => t.name)).toEqual(['Media', 'Music']);
    });

    it('reports an unregistered operation and a stale entry', () => {
        const result = applyPublicTaxonomy({ '/api/v1/media': { get: {} } }, taxonomy);
        expect(result.problems).toEqual([
            expect.stringContaining('GET /media: not in scripts/openapi/public-taxonomy.ts'),
            expect.stringContaining('GET /media/{id}: listed in public-taxonomy.ts but no such'),
            expect.stringContaining('GET /music/albums: listed in public-taxonomy.ts but no such'),
        ]);
    });

    it('rejects a badly shaped or duplicated operationId', () => {
        const bad: TaxonomyGroup[] = [
            {
                name: 'G',
                tags: [
                    {
                        name: 'T',
                        description: 'd',
                        operations: { 'GET /a/{id}': 'getMediaIdImages', 'GET /b': 'getThing', 'GET /c': 'getThing' },
                    },
                ],
            },
        ];
        const result = applyPublicTaxonomy(
            {
                '/api/v1/a/{id}': { get: { 'x-stability': 'beta' } },
                '/api/v1/b': { get: { 'x-stability': 'beta' } },
                '/api/v1/c': { get: { 'x-stability': 'beta' } },
            },
            bad,
        );
        expect(result.problems).toEqual([
            'GET /a/{id}: operationId "getMediaIdImages" contains the path-param name "id"',
            'operationId "getThing" used by GET /b and GET /c',
        ]);
    });
});

describe('applyPublicTaxonomy guards', () => {
    const one = (ops: Record<string, string>): TaxonomyGroup[] => [
        { name: 'G', tags: [{ name: 'T', description: 'd', operations: ops }] },
    ];

    it('reports an operation without x-stability', () => {
        const result = applyPublicTaxonomy({ '/api/v1/x': { get: {} } }, one({ 'GET /x': 'getThing' }));
        expect(result.problems).toEqual(['GET /x: no x-stability (set an explicit stability on the operation)']);
    });

    it('covers OPTIONS operations too', () => {
        const result = applyPublicTaxonomy({ '/api/v1/x': { options: { 'x-stability': 'beta' } } }, one({}));
        expect(result.problems).toEqual([expect.stringContaining('OPTIONS /x: not in')]);
    });

    it('refuses a tag listed twice', () => {
        const twice: TaxonomyGroup[] = [
            { name: 'A', tags: [{ name: 'T', description: 'd', operations: {} }] },
            { name: 'B', tags: [{ name: 'T', description: 'd', operations: {} }] },
        ];
        expect(() => applyPublicTaxonomy({}, twice)).toThrow('tag "T" is listed twice');
    });
});

describe('applyLocalizedParameters', () => {
    it('adds the shared parameter once, even when run twice or already declared', () => {
        const doc = {
            paths: {
                '/api/v1/media/{id}': { get: { parameters: [] as unknown[] } },
                '/api/v1/search': {
                    get: { parameters: [{ name: 'accept-language', in: 'header' }] as unknown[] },
                },
            },
        };
        applyLocalizedParameters(doc);
        applyLocalizedParameters(doc);
        expect(doc.paths['/api/v1/media/{id}'].get.parameters).toEqual([
            { $ref: '#/components/parameters/AcceptLanguage' },
        ]);
        expect(doc.paths['/api/v1/search'].get.parameters).toHaveLength(1);
    });
});

describe('operationIdProblem', () => {
    it.each([
        ['getMediaItem', '/media/{id}'],
        ['keepAliveLiveTvSession', '/livetv/playback-sessions/{playbackSessionId}/keepalive'],
        ['signOut', '/auth/logout'],
        ['listUserIdentities', '/users/{id}/identities'],
        ['getAndroidTvChannel', '/x/{id}'],
        ['streamLiveTv', '/livetv/channels/{id}/stream/{path}'],
        ['unpinGenre', '/me/music/pinned-genres/{genre}'],
    ])('accepts %s for %s', (id, path) => {
        expect(operationIdProblem(id, path)).toBeNull();
    });

    it.each([
        ['getMediaId', '/media/{id}', 'contains the path-param name "id"'],
        ['getMediaIdImages', '/media/{id}/images', 'contains the path-param name "id"'],
        ['postLivetvPlaybackSessionsSessionidKeepalive', '/x', 'does not start with a known verb'],
        ['getLivetvSessionsSessionid', '/livetv/sessions/{sessionId}', 'contains the path-param name "sessionId"'],
        ['getStationStationId', '/livetv/stations/{stationId}', 'contains the path-param name "stationId"'],
        ['get_media', '/x', 'not verbNoun camelCase'],
        ['getStream.m3u8', '/x', 'not verbNoun camelCase'],
        ['media', '/x', 'not verbNoun camelCase'],
    ])('rejects %s for %s', (id, path, problem) => {
        expect(operationIdProblem(id, path)).toBe(problem);
    });
});
