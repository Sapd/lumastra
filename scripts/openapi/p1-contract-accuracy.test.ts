// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
interface Operation {
    operationId: string;
    tags: string[];
    security: Record<string, string[]>[];
    parameters?: { name: string; in: string; required?: boolean }[];
    requestBody?: {
        required?: boolean;
        content: Record<string, { schema: { required?: string[] } }>;
    };
    responses: Record<string, { content?: Record<string, unknown> }>;
}
interface Spec {
    paths: Record<string, Record<string, Operation>>;
    components: {
        securitySchemes: Record<string, unknown>;
        schemas: Record<string, { properties: Record<string, unknown> }>;
    };
}
const root = resolve(__dirname, '../..');
const spec = parse(readFileSync(resolve(root, 'docs/api/api-v1.yaml'), 'utf8'), {
    maxAliasCount: -1,
}) as Spec;
const operation = (path: string, method = 'get'): Operation => spec.paths[`/api/v1${path}`][method];

describe('P1 generated contract acceptance', () => {
    it.each([
        '/music/tracks/{id}/stream',
        '/audiobooks/{mediaId}/files/{trackIndex}',
        '/audiobooks/{mediaId}/remux/{trackIndex}',
        '/playback/{id}/file',
        '/playback/{id}/hls',
        '/playback/{id}/hls/{path}',
    ])('%s declares Bearer OR query grant, with no anonymous alternative', (path) => {
        expect(operation(path).security).toEqual([{ bearerAuth: [] }, { grant: [] }]);
        expect(spec.components.securitySchemes.grant).toMatchObject({
            type: 'apiKey',
            in: 'query',
            name: 'grant',
        });
        expect(operation(path).responses['401']).toBeDefined();
    });
    it('keeps the file selector required and binary success documented', () => {
        expect(operation('/playback/{id}/file').parameters).toContainEqual(
            expect.objectContaining({ name: 'fileId', in: 'query', required: true }),
        );
        expect(operation('/playback/{id}/file').responses['206'].content).toHaveProperty(
            'application/octet-stream',
        );
        expect(
            operation('/audiobooks/{mediaId}/remux/{trackIndex}').responses['200'].content,
        ).toHaveProperty('audio/aac');
    });
    it('documents required password and webhook POST bodies', () => {
        for (const [path, field] of [
            ['/users/{id}/password', 'newPassword'],
            ['/me/notification-webhook', 'url'],
        ]) {
            const body = operation(path, 'post').requestBody;
            expect(body?.required).toBe(true);
            expect(body?.content['application/json'].schema.required).toContain(field);
        }
    });
    it('narrows EpisodeNode without altering general discovery cards', () => {
        const episode = spec.components.schemas.EpisodeNode.properties;
        expect(episode).toHaveProperty('context');
        expect(episode).toHaveProperty('overview');
        for (const field of ['audiobook', 'score', 'reason']) {
            expect(episode).not.toHaveProperty(field);
            expect(spec.components.schemas.MediaPreview.properties).toHaveProperty(field);
        }
    });
    it.each([
        ['/playback/{id}/subtitles/{index}', 'getSubtitleTrack'],
        ['/playback/{id}/subtitles/external/{subtitleId}', 'getExternalSubtitle'],
        ['/playback/{id}/subtitles/{index}/rendered', 'getRenderedSubtitleManifest'],
        ['/playback/{id}/subtitles/{index}/rendered/{image}', 'getRenderedSubtitleImage'],
    ])('retains subtitle generation operation %s with its stable ID', (path, id) => {
        expect(operation(path)).toMatchObject({ tags: ['Subtitles'], operationId: id });
        const generated = readFileSync(
            resolve(root, 'tests/api-recipes/generated/api-v1.d.ts'),
            'utf8',
        );
        expect(generated).toContain(`operations["${id}"]`);
    });
    it('places series release follows under Notifications and retains useful task resources', () => {
        expect(operation('/me/series-follows').tags).toEqual(['Notifications']);
        expect(operation('/me/series-follows/{seriesId}', 'put').tags).toEqual(['Notifications']);
        expect(operation('/me/series-follows/{seriesId}', 'delete').tags).toEqual([
            'Notifications',
        ]);
        expect(operation('/tasks/{taskId}')).toBeDefined();
        expect(operation('/tasks/{taskId}/state')).toBeDefined();
        expect(operation('/tasks/{taskId}/triggers')).toBeDefined();
    });
    it.each(['capabilities', 'quality'])(
        'removes hidden v1 %s tooling while retaining its admin resource',
        (tool) => {
            expect(spec.paths[`/api/v1/playback/${tool}`]).toBeUndefined();
            expect(existsSync(resolve(root, `src/routes/api/v1/playback/${tool}/+server.ts`))).toBe(
                false,
            );
            const admin = tool === 'capabilities' ? 'transcode-capabilities' : 'playback-quality';
            expect(existsSync(resolve(root, `src/routes/api/admin/${admin}/+server.ts`))).toBe(
                true,
            );
        },
    );
    it('publishes no unimplemented keyword modes', () => {
        expect(
            operation('/keywords')
                .parameters?.filter((p) => p.in === 'query')
                .map((p) => p.name),
        ).toEqual(['limit', 'offset']);
    });
});
