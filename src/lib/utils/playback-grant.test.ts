// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { playbackStartFixture } from './playback-start.fixture';
import { maintainPlaybackGrant, rotateDeliveryGrant } from './playback-grant';

const post = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiPost: post }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    post.mockReset();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('delivery grant renewal', () => {
    it('posts the existing token at renewAfter and preserves delivery secrets', async () => {
        const start = playbackStartFixture();
        start.grant.renewAfter = new Date(Date.now() + 60_000).toISOString();
        post.mockResolvedValue({
            data: {
                ...start.grant,
                token: start.grant.token,
                expiresAt: '2099-01-02T00:00:00.000Z',
                renewAfter: new Date(Date.now() + 120_000).toISOString(),
            },
        });
        const changed = vi.fn();
        const stop = maintainPlaybackGrant(start, changed);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(post).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(post).toHaveBeenCalledWith(start.grant.renewHref, expect.anything(), {
            token: start.grant.token,
        });
        expect(start.delivery).toMatchObject({
            url: '/api/v1/music/tracks/media-1/stream?grant=tok',
        });
        expect(start.grant.token).toBe('tok');
        expect(start.grant.expiresAt).toBe('2099-01-02T00:00:00.000Z');
        expect(start.playbackSessionId).toBe('sess-1');
        expect(changed).toHaveBeenCalledOnce();
        stop();
    });
    it('rotates audiobook file and HLS hrefs without changing track selection or offsets', () => {
        const start = playbackStartFixture();
        start.delivery = {
            kind: 'multipart-audio',
            startPositionMs: 17_000,
            durationMs: 60_000,
            tracks: [
                {
                    index: 4,
                    startMs: 0,
                    durationMs: 60_000,
                    mime: 'audio/mpeg',
                    url: '/api/v1/audiobooks/book/files/4?grant=old&PlaySessionId=sess-1',
                },
            ],
            chapters: [],
        };
        rotateDeliveryGrant(start, 'next');
        expect(start.delivery.tracks[0].url).toBe(
            '/api/v1/audiobooks/book/files/4?grant=next&PlaySessionId=sess-1',
        );
        expect(start.delivery.startPositionMs).toBe(17_000);
    });
    it('does not apply a renewal that resolves after disposal', async () => {
        const start = playbackStartFixture();
        start.grant.renewAfter = new Date(Date.now() + 1000).toISOString();
        let resolve!: (value: unknown) => void;
        post.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const changed = vi.fn();
        const stop = maintainPlaybackGrant(start, changed);
        await vi.advanceTimersByTimeAsync(1000);
        stop();
        resolve({ data: { ...start.grant, token: 'late' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(start.grant.token).toBe('tok');
        expect(changed).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('retries a failed renewal with bounded backoff', async () => {
        const start = playbackStartFixture();
        start.grant.renewAfter = new Date(Date.now() + 1000).toISOString();
        post.mockResolvedValue({ data: null, error: 'offline' });
        const stop = maintainPlaybackGrant(start);
        await vi.advanceTimersByTimeAsync(1000);
        expect(post).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(post).toHaveBeenCalledTimes(2);
        stop();
    });
    it('never attaches a delivery secret to a foreign URL', () => {
        const start = playbackStartFixture();
        if (start.delivery.kind !== 'file') throw new Error('Expected file');
        start.delivery.url = 'https://foreign.example/file?grant=old';
        rotateDeliveryGrant(start, 'new');
        expect(start.delivery.url).toBe('https://foreign.example/file?grant=old');
    });
});
