// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
    matchRoute,
    validateAgainstSchema,
    validateJellyfinResponse,
    type Violation,
} from './validate';
import { getContractDigest } from './digest';

const digest = getContractDigest();

function stream(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        Index: 0,
        Type: 'Subtitle',
        IsInterlaced: false,
        IsDefault: false,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        IsExternal: true,
        IsTextSubtitleStream: true,
        SupportsExternalStream: true,
        // Required by SDK 1.6.3 only, but still part of a complete stream.
        VideoRange: 'SDR',
        VideoRangeType: 'SDR',
        ...over,
    };
}
const errors = (vs: Violation[]): Violation[] => vs.filter((v) => v.severity === 'error');

describe('validateAgainstSchema(MediaStream)', () => {
    it('accepts a complete stream', () => {
        expect(errors(validateAgainstSchema(digest, 'MediaStream', stream()))).toEqual([]);
    });
    it("leon's regression: external sub without IsInterlaced is a missing error", () => {
        const s = stream();
        delete s.IsInterlaced;
        const v = errors(validateAgainstSchema(digest, 'MediaStream', s));
        expect(v).toEqual([
            expect.objectContaining({
                property: 'IsInterlaced',
                kind: 'missing',
                pointer: '/IsInterlaced',
            }),
        ]);
        expect(v[0].versions).toContain('1.7.1');
    });
    it('IsOriginal is required by SDK 1.9.2 only', () => {
        const s = stream();
        delete s.IsOriginal;
        const v = errors(validateAgainstSchema(digest, 'MediaStream', s));
        expect(v).toEqual([
            expect.objectContaining({ property: 'IsOriginal', versions: ['1.9.2'] }),
        ]);
    });
    it('null on a required property is an error; on a defaulted one a warning', () => {
        expect(
            errors(validateAgainstSchema(digest, 'MediaStream', stream({ IsDefault: null })))[0],
        ).toMatchObject({ kind: 'null' });
        const vr = validateAgainstSchema(
            digest,
            'MediaStream',
            stream({ AudioSpatialFormat: null }),
        );
        expect(vr).toEqual([
            expect.objectContaining({ property: 'AudioSpatialFormat', severity: 'warn' }),
        ]);
    });
    it('boolean-as-string and number-as-string are type errors', () => {
        expect(
            errors(validateAgainstSchema(digest, 'MediaStream', stream({ IsForced: 'false' })))[0],
        ).toMatchObject({ kind: 'type' });
        expect(
            errors(validateAgainstSchema(digest, 'MediaStream', stream({ Index: '3' })))[0],
        ).toMatchObject({ kind: 'type' });
    });
    it('int32 overflow is an error', () => {
        expect(
            errors(validateAgainstSchema(digest, 'MediaStream', stream({ BitRate: 2 ** 31 })))[0],
        ).toMatchObject({ kind: 'int32' });
    });
    it('unknown value of a default-less enum is an error', () => {
        expect(
            errors(validateAgainstSchema(digest, 'MediaStream', stream({ Type: 'Teletext' })))[0],
        ).toMatchObject({ kind: 'enum' });
    });
    it('extra properties are fine', () => {
        expect(validateAgainstSchema(digest, 'MediaStream', stream({ LumastraOnly: 1 }))).toEqual(
            [],
        );
    });
});

describe('UUID format', () => {
    it('accepts hyphenated and 32 lowercase hex, rejects uppercase unhyphenated', () => {
        const pick = (Id: string) =>
            validateAgainstSchema(digest, 'UserDto', { Id }).filter((v) => v.property === 'Id');
        expect(pick('0f8fad5b-d9cb-469f-a165-70867728950e')).toEqual([]);
        expect(pick('0F8FAD5B-D9CB-469F-A165-70867728950E')).toEqual([]);
        expect(pick('0f8fad5bd9cb469fa16570867728950e')).toEqual([]);
        expect(pick('0F8FAD5BD9CB469FA16570867728950E')[0]).toMatchObject({
            kind: 'uuid',
            severity: 'error',
        });
    });
});

describe('route matching and nesting', () => {
    it('matches /j paths case-insensitively against spec templates', () => {
        expect(matchRoute(digest, 'POST', '/j/items/abc/playbackinfo')).toMatchObject({
            schema: 'PlaybackInfoResponse',
        });
        expect(matchRoute(digest, 'GET', '/j/Nope/Nothing')).toBeNull();
    });
    it('recurses into MediaSources[].MediaStreams[] with a JSON pointer', () => {
        const bad = stream();
        delete bad.IsHearingImpaired;
        const body = {
            PlaySessionId: 'p',
            MediaSources: [
                { Id: 'a', Protocol: 'File', Type: 'Default', MediaStreams: [stream(), bad] },
            ],
        };
        const r = validateJellyfinResponse('POST', '/j/Items/x/PlaybackInfo', body);
        expect(r.unmatched).toBe(false);
        expect(r.violations.filter((v) => v.property === 'IsHearingImpaired')[0].pointer).toBe(
            '/MediaSources/0/MediaStreams/1/IsHearingImpaired',
        );
    });
    it('allowlisted gaps are skipped only for the named client', () => {
        const src = { Id: 'a', Protocol: 'File', Type: 'Default', MediaStreams: [] };
        const pick = (clientName?: string) =>
            validateJellyfinResponse(
                'POST',
                '/j/Items/x/PlaybackInfo',
                { MediaSources: [src] },
                { clientName },
            ).violations.filter((v) => v.property === 'TranscodingSubProtocol');
        expect(pick('Streamyfin')).toEqual([]);
        expect(pick('Jellyfin Android TV').length).toBeGreaterThan(0);
    });
});

describe('array responses and schema-less routes', () => {
    it('validates each element of an X[] route with /<index> pointers', () => {
        const good = { Id: '0f8fad5b-d9cb-469f-a165-70867728950e', Type: 'Movie' };
        const bad = { ...good, Id: 'NOT-A-UUID' };
        const r = validateJellyfinResponse('GET', '/j/Items/abc/Ancestors', [good, bad]);
        expect(r.schema).toBe('BaseItemDto[]');
        const uuid = r.violations.filter((v) => v.kind === 'uuid');
        expect(uuid).toHaveLength(1);
        expect(uuid[0].pointer).toBe('/1/Id');
    });
    it('honours arrayLimit on top-level arrays', () => {
        const bad = { Id: 'nope' };
        const r = validateJellyfinResponse('GET', '/j/Items/abc/Ancestors', [bad, bad, bad], {
            arrayLimit: 1,
        });
        expect(r.violations.filter((v) => v.kind === 'uuid')).toHaveLength(1);
    });
    it('a non-array body for an X[] route is one type error at the root', () => {
        const r = validateJellyfinResponse('GET', '/j/Items/abc/Ancestors', { Id: 'x' });
        expect(r.violations).toEqual([
            expect.objectContaining({ pointer: '', kind: 'type', severity: 'error' }),
        ]);
    });
    it('a route schema without a digest entry yields no violations', () => {
        expect(digest.schemas.BasePluginConfiguration).toBeUndefined();
        const r = validateJellyfinResponse('GET', '/j/Plugins/abc/Configuration', { Any: 1 });
        expect(r).toMatchObject({ unmatched: false, schema: 'BasePluginConfiguration' });
        expect(r.violations).toEqual([]);
    });
});
