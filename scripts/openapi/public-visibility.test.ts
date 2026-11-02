// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type PathItem = Record<string, unknown>;
const load = (name: string): Record<string, PathItem> =>
    (
        parse(readFileSync(resolve(__dirname, `../../docs/api/${name}`), 'utf-8'), {
            maxAliasCount: -1,
        }) as {
            paths: Record<string, PathItem>;
        }
    ).paths;

/** Operator operations that must stay out of the public contract (shape review A2). */
const OPERATOR_OPERATIONS: Array<[string, string]> = [
    ['post', '/api/v1/lists'],
    ['put', '/api/v1/providers'],
    ['patch', '/api/v1/providers'],
    ['get', '/api/v1/providers'],
    ['get', '/api/v1/playback/capabilities'],
    ['get', '/api/v1/playback/quality'],
    ['post', '/api/v1/media/{id}/rescan'],
    ['post', '/api/v1/media/{id}/sync'],
    ['get', '/api/v1/media/{id}/streams'],
    ['get', '/api/v1/media/{id}/chapters'],
    ['get', '/api/v1/radio/stations'],
    ['get', '/api/v1/libraries/paths'],
    ['post', '/api/v1/libraries/scan'],
];

describe('public spec visibility (generated docs/api)', () => {
    const publicPaths = load('api-v1.yaml');

    it.each(OPERATOR_OPERATIONS)('%s %s is not in api-v1.yaml', (method, path) => {
        expect(publicPaths[path]?.[method]).toBeUndefined();
    });

    it('keeps the consumer reads of mixed paths public', () => {
        expect(publicPaths['/api/v1/lists']?.get).toBeDefined();
    });

    it('does not repeat a path parameter name inside one path', () => {
        for (const path of Object.keys(publicPaths)) {
            const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
            expect(new Set(names).size, path).toBe(names.length);
        }
    });
});
