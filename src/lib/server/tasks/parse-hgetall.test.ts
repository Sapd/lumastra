// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for parseHGetAll — the decoder that normalizes the many shapes a
 * Valkey HGETALL can come back as into a flat Record<string, string>.
 *
 * Regression: @valkey/valkey-glide v2's `customCommand(['HGETALL', key])`
 * returns a JS `Map` (ReturnTypeMap). The original parser only handled flat
 * arrays, {field,value}[] arrays, and plain objects — Object.entries(map) is
 * [], so live run progress (stage:<id>:processed/total/currentItem) was
 * silently dropped and task cards never rendered progress bars.
 */

import { describe, it, expect } from 'vitest';
import { parseHGetAll } from './orchestrator.js';

describe('parseHGetAll', () => {
    it('decodes a Map (the shape glide customCommand HGETALL returns)', () => {
        const raw = new Map<string, string>([
            ['stage:main:processed', '40'],
            ['stage:main:total', '150'],
            ['stage:main:currentItem', '40/150 tracks'],
            ['state', 'active'],
        ]);

        expect(parseHGetAll(raw)).toEqual({
            'stage:main:processed': '40',
            'stage:main:total': '150',
            'stage:main:currentItem': '40/150 tracks',
            state: 'active',
        });
    });

    it('coerces Buffer values from a Map to utf-8 strings', () => {
        const raw = new Map<string, unknown>([
            ['stage:main:currentItem', Buffer.from('episode 7')],
            ['stage:main:processed', '12'],
        ]);

        expect(parseHGetAll(raw)).toEqual({
            'stage:main:currentItem': 'episode 7',
            'stage:main:processed': '12',
        });
    });

    it('still decodes a flat [k, v, …] array', () => {
        expect(parseHGetAll(['a', '1', 'b', '2'])).toEqual({ a: '1', b: '2' });
    });

    it('still decodes a {field, value}[] array', () => {
        expect(
            parseHGetAll([
                { field: 'a', value: '1' },
                { field: 'b', value: '2' },
            ]),
        ).toEqual({ a: '1', b: '2' });
    });

    it('still decodes a plain object', () => {
        expect(parseHGetAll({ a: '1', b: '2' })).toEqual({ a: '1', b: '2' });
    });

    it('returns {} for an empty Map / empty hash', () => {
        expect(parseHGetAll(new Map())).toEqual({});
        expect(parseHGetAll([])).toEqual({});
        expect(parseHGetAll(null)).toEqual({});
    });
});
