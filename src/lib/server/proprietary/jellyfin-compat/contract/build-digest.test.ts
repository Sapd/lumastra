// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
import { describe, expect, it } from 'vitest';
import { buildDigest, type OpenApiDoc } from './build-digest';

function spec(
    version: string,
    ms: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): OpenApiDoc {
    return {
        info: { version },
        paths: {
            '/Items/{itemId}/PlaybackInfo': {
                post: {
                    responses: {
                        '200': {
                            content: {
                                'application/json': {
                                    schema: { $ref: '#/components/schemas/PlaybackInfoResponse' },
                                },
                            },
                        },
                    },
                },
            },
            '/Items/Latest': {
                get: {
                    responses: {
                        '200': {
                            content: {
                                'application/json': {
                                    schema: {
                                        type: 'array',
                                        items: { $ref: '#/components/schemas/BaseItemDto' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
            '/Sessions/Playing': { post: { responses: { '204': { description: 'ok' } } } },
        },
        components: {
            schemas: {
                PlaybackInfoResponse: {
                    type: 'object',
                    properties: {
                        MediaSources: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/MediaSourceInfo' },
                            nullable: true,
                        },
                    },
                },
                MediaSourceInfo: {
                    type: 'object',
                    properties: {
                        MediaStreams: {
                            type: 'array',
                            nullable: true,
                            items: { $ref: '#/components/schemas/MediaStream' },
                        },
                    },
                },
                BaseItemDto: {
                    type: 'object',
                    properties: { Name: { type: 'string', nullable: true } },
                },
                MediaStream: { type: 'object', properties: ms },
                MediaStreamType: { enum: ['Audio', 'Video', 'Subtitle', 'Lyric'], type: 'string' },
                ...extra,
            },
        },
    } as OpenApiDoc;
}

describe('buildDigest', () => {
    const v1 = spec(
        '10.10.7',
        {
            IsInterlaced: { type: 'boolean' },
            Codec: { type: 'string', nullable: true },
            VideoRange: {
                allOf: [{ $ref: '#/components/schemas/VideoRange' }],
                default: 'Unknown',
            },
            Type: { allOf: [{ $ref: '#/components/schemas/MediaStreamType' }] },
            Index: { type: 'integer', format: 'int32' },
        },
        { VideoRange: { enum: ['Unknown', 'SDR', 'HDR'], type: 'string' } },
    );
    const v2 = spec(
        '12.2.0',
        {
            IsInterlaced: { type: 'boolean' },
            IsOriginal: { type: 'boolean' },
            Codec: { type: 'string', nullable: true },
            VideoRange: {
                allOf: [{ $ref: '#/components/schemas/VideoRange' }],
                default: 'Unknown',
            },
            Type: { allOf: [{ $ref: '#/components/schemas/MediaStreamType' }] },
            Index: { type: 'integer', format: 'int32' },
        },
        {
            VideoRange: { enum: ['Unknown', 'SDR', 'HDR', 'DOVI'], type: 'string' },
            MediaStreamType: { enum: ['Audio', 'Video', 'Subtitle'], type: 'string' },
        },
    );
    const d = buildDigest([
        { sdk: '1.7.1', spec: v1 },
        { sdk: '1.9.2', spec: v2 },
    ]);
    const ms = d.schemas.MediaStream;

    it('non-nullable without default is required, tagged per SDK version', () => {
        expect(ms.IsInterlaced.required).toEqual(['1.7.1', '1.9.2']);
        expect(ms.IsOriginal.required).toEqual(['1.9.2']);
    });
    it('nullable and defaulted properties are not required', () => {
        expect(ms.Codec.required).toEqual([]);
        expect(ms.Codec.nullable).toBe(true);
        expect(ms.VideoRange.required).toEqual([]);
        expect(ms.VideoRange.hasDefault).toBe(true);
    });
    it('enum values are the intersection across versions', () => {
        expect(ms.Type.enum).toEqual(['Audio', 'Video', 'Subtitle']);
        expect(ms.VideoRange.enum).toEqual(['Unknown', 'SDR', 'HDR']);
    });
    it('records type, format and nested schema refs', () => {
        expect(ms.Index).toMatchObject({ type: 'integer', format: 'int32' });
        expect(d.schemas.PlaybackInfoResponse.MediaSources).toMatchObject({
            type: 'array',
            child: 'MediaSourceInfo',
        });
        expect(d.schemas.MediaSourceInfo.MediaStreams.child).toBe('MediaStream');
    });
    it('maps routes to their 200 response schema (204 = null)', () => {
        expect(d.routes).toContainEqual({
            method: 'POST',
            path: '/Items/{itemId}/PlaybackInfo',
            schema: 'PlaybackInfoResponse',
        });
        expect(d.routes).toContainEqual({
            method: 'POST',
            path: '/Sessions/Playing',
            schema: null,
        });
        expect(d.versions).toEqual([
            { sdk: '1.7.1', spec: '10.10.7' },
            { sdk: '1.9.2', spec: '12.2.0' },
        ]);
    });
    it('records array responses with a [] suffix on the item schema', () => {
        expect(d.routes).toContainEqual({
            method: 'GET',
            path: '/Items/Latest',
            schema: 'BaseItemDto[]',
        });
    });
});
