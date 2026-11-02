// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse } from 'yaml';

interface Schema {
    $ref?: string;
    required?: string[];
    properties?: Record<string, Schema>;
}
interface Operation {
    operationId: string;
    requestBody?: { content: Record<string, { schema: Schema }> };
}
interface Spec {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, Schema> };
}
const root = resolve(__dirname, '../..');
const spec = parse(readFileSync(resolve(root, 'docs/api/api-v1.yaml'), 'utf8'), {
    maxAliasCount: -1,
}) as Spec;
spec.paths = Object.fromEntries(
    Object.entries(spec.paths).map(([path, value]) => [path.replace(/^\/api\/v1/, ''), value]),
);
const methods = ['get', 'post', 'put', 'patch', 'delete'];
const matrix: Array<[string, string]> = [
    ['/me', 'get'],
    ['/me/stats', 'get'],
    ['/me/playback-preferences', 'get,patch'],
    ['/me/links', 'get'],
    ['/me/links/{provider}', 'delete,get'],
    ['/me/links/{provider}/authorize', 'post'],
    ['/me/pats', 'get,post'],
    ['/me/pats/{id}', 'delete'],
    ['/me/notification-forwarding', 'get,put'],
    ['/me/notification-webhook', 'delete,get,post'],
    ['/me/series-follows', 'get'],
    ['/me/series-follows/{seriesId}', 'delete,put'],
    ['/me/music/recently-played', 'get'],
    ['/me/music/top-tracks', 'get'],
    ['/me/music/top-artists', 'get'],
    ['/me/music/taste-stations', 'get'],
    ['/me/music/taste-stations/{id}/tracks', 'get'],
    ['/me/music/pinned-genres', 'get,post'],
    ['/me/music/pinned-genres/{genre}', 'delete'],
    ['/me/music/tracks/{id}/feedback', 'delete,put'],
    ['/watch-state/{id}', 'get,patch'],
    ['/tasks/{taskId}/state', 'get,patch'],
    ['/playlists/{id}', 'delete,get,patch'],
    ['/users/{id}/password', 'post'],
];
function dereference(schema: Schema): Schema {
    return schema.$ref ? spec.components.schemas[schema.$ref.split('/').pop()!] : schema;
}

describe('P3 self resources and PATCH cutover', () => {
    it.each(matrix)('%s publishes only %s', (path, expected) => {
        expect(spec.paths[path], path).toBeDefined();
        expect(
            Object.keys(spec.paths[path])
                .filter((m) => methods.includes(m))
                .sort()
                .join(','),
        ).toBe(expected);
    });
    it('removes every published /user resource and /stats/me without aliases', () => {
        expect(Object.keys(spec.paths).filter((p) => p.startsWith('/user/'))).toEqual([]);
        expect(spec.paths['/stats/me']).toBeUndefined();
        for (const [path] of matrix.filter(([p]) => p.startsWith('/me'))) {
            const old = path === '/me' ? '/user/profile' : path.replace('/me/', '/user/');
            const route = old.replace(/\{([^}]+)\}/g, '[$1]');
            for (const prefix of ['src/routes/api/v1', 'src/routes/api']) {
                expect(existsSync(resolve(root, prefix + route, '+server.ts')), route).toBe(false);
            }
        }
        expect(existsSync(resolve(root, 'src/routes/api/v1/stats/me/+server.ts'))).toBe(false);
    });
    it.each([
        '/me/playback-preferences',
        '/watch-state/{id}',
        '/tasks/{taskId}/state',
        '/playlists/{id}',
    ])('%s has zero required PATCH fields and no PUT', (path) => {
        const op = spec.paths[path].patch;
        const schema = dereference(op.requestBody!.content['application/json'].schema);
        expect(schema.required ?? []).toEqual([]);
        expect(spec.paths[path].put).toBeUndefined();
    });
    it.each([
        ['/me/notification-webhook', 'url'],
        ['/users/{id}/password', 'newPassword'],
    ])('%s keeps POST with required %s', (path, field) => {
        const schema = dereference(
            spec.paths[path].post.requestBody!.content['application/json'].schema,
        );
        expect(schema.required).toContain(field);
    });
    it('keeps full replacement methods and the internal-only account resource', () => {
        for (const path of ['/tasks/{taskId}/triggers', '/playlists/{id}/items/order']) {
            expect(spec.paths[path].put).toBeDefined();
        }
        expect(existsSync(resolve(root, 'src/routes/api/user/+server.ts'))).toBe(true);
    });
});
