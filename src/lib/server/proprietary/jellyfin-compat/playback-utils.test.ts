// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { parsePlaybackBody } from './playback-utils';
import { WATCH_COMPLETION_THRESHOLD } from '$lib/server/utils/watch-constants';

describe('WATCH_COMPLETION_THRESHOLD', () => {
    it('is 0.9', () => {
        expect(WATCH_COMPLETION_THRESHOLD).toBe(0.9);
    });
});

describe('parsePlaybackBody', () => {
    it('parses PascalCase JSON body', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ ItemId: 'abc', PositionTicks: 100_000_000 }),
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.itemId).toBe('abc');
        expect(result.positionMs).toBe(10_000);
    });

    it('raises a 413 for a body past the 1 MiB cap instead of reporting an empty one', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ ItemId: 'abc', Filler: 'x'.repeat(1024 * 1024 + 16) }),
            headers: { 'Content-Type': 'application/json' },
        });
        await expect(parsePlaybackBody(req)).rejects.toMatchObject({ status: 413 });
    });

    it('parses camelCase JSON body', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ itemId: 'xyz', positionTicks: 50_000_000 }),
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.itemId).toBe('xyz');
        expect(result.positionMs).toBe(5_000);
    });

    it('returns defaults for empty body', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: '',
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.itemId).toBeUndefined();
        expect(result.positionMs).toBe(0);
        expect(result.playSessionId).toBeUndefined();
    });

    it('returns defaults for malformed JSON', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: 'not json{',
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.itemId).toBeUndefined();
        expect(result.positionMs).toBe(0);
        expect(result.playSessionId).toBeUndefined();
    });

    it('parses PlaySessionId', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ ItemId: 'abc', PlaySessionId: 'session-1' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.playSessionId).toBe('session-1');
    });

    it('parses camelCase playSessionId', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ itemId: 'abc', playSessionId: 'session-2' }),
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.playSessionId).toBe('session-2');
    });

    it('converts PositionTicks to positionMs by dividing by 10000', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ PositionTicks: 600_000_000 }),
            headers: { 'Content-Type': 'application/json' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.positionMs).toBe(60_000);
    });

    it('parses non-JSON content type with JSON body by falling back to request.json()', async () => {
        const req = new Request('http://test', {
            method: 'POST',
            body: JSON.stringify({ ItemId: 'fallback', PositionTicks: 10_000 }),
            headers: { 'Content-Type': 'text/plain' },
        });
        const result = await parsePlaybackBody(req);
        expect(result.itemId).toBe('fallback');
        expect(result.positionMs).toBe(1);
    });
});
