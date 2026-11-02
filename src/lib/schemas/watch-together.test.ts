// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { buildPublicAuthor } from '$lib/shared/public-author';

import { describe, it, expect } from 'vitest';
import { createDocument } from 'zod-openapi';
import {
    watchTogetherFrameSchema,
    WatchTogetherParticipantSchema,
    WatchTogetherResyncFrameSchema,
    createSessionSchema,
    heartbeatSchema,
    navigateSchema,
    positionUpdateSchema,
    seekSchema,
    syncStateSchema,
    watchTogetherEventInputSchema,
    WATCH_TOGETHER_HOST_ONLY_EVENTS,
} from './watch-together.js';

// Watch-together carries playback positions in SECONDS (HTMLMediaElement.currentTime),
// and the session stores `currentTime` in seconds. These request bodies were
// validated with positionMsSchema (integer milliseconds), which rejected every
// real fractional-second position with a 400 — and the heartbeat client type/caller
// omitted the required clientId. These tests lock both fixes in.

describe('watch-together playback position schemas accept fractional seconds', () => {
    it('heartbeatSchema accepts a fractional-second currentTime with clientId', () => {
        const result = heartbeatSchema.safeParse({
            currentTime: 12.5,
            clientId: 'client_abc',
            isPlaying: true,
        });
        expect(result.success).toBe(true);
    });

    it('heartbeatSchema rejects a missing clientId', () => {
        const result = heartbeatSchema.safeParse({ currentTime: 12.5, isPlaying: true });
        expect(result.success).toBe(false);
    });

    it('heartbeatSchema requires the current client play state', () => {
        const withFlag = heartbeatSchema.safeParse({
            currentTime: 12.5,
            clientId: 'c',
            isPlaying: false,
        });
        expect(withFlag.success).toBe(true);
        expect(heartbeatSchema.safeParse({ currentTime: 12.5, clientId: 'c' }).success).toBe(false);
    });

    it('positionUpdateSchema accepts a fractional-second position with clientId', () => {
        const result = positionUpdateSchema.safeParse({ position: 42.37, clientId: 'client_abc' });
        expect(result.success).toBe(true);
    });

    it('seekSchema accepts a fractional-second currentTime', () => {
        expect(
            seekSchema.safeParse({ currentTime: 3.14, clientId: 'c', isPlaying: false }).success,
        ).toBe(true);
    });

    it('syncStateSchema accepts a fractional-second currentTime', () => {
        expect(
            syncStateSchema.safeParse({ currentTime: 7.7, isPlaying: true, clientId: 'c' }).success,
        ).toBe(true);
    });

    it('still rejects negative positions', () => {
        expect(
            heartbeatSchema.safeParse({ currentTime: -1, clientId: 'c', isPlaying: true }).success,
        ).toBe(false);
    });
});

// ============================================================================
// D2: watchTogetherEventInputSchema discriminated union
// ============================================================================

describe('watchTogetherEventInputSchema', () => {
    it('parses a valid seek event', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'seek',
            payload: { currentTime: 42.5, isPlaying: false },
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.type).toBe('seek');
        }
    });

    it('parses a valid sync event with optional playbackRate defaulting to 1', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'sync',
            payload: { currentTime: 10, isPlaying: true },
        });
        expect(result.success).toBe(true);
        if (result.success && result.data.type === 'sync') {
            expect(result.data.payload.playbackRate).toBe(1);
        }
    });

    it('parses a valid join event with empty payload', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'join',
            payload: {},
        });
        expect(result.success).toBe(true);
    });

    it('parses a valid navigate event', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'navigate',
            payload: {
                itemId: 'abc-123',
                mediaType: 'movie',
                title: 'Test Movie',
            },
        });
        expect(result.success).toBe(true);
    });

    it('parses a valid transfer-host event', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'transfer-host',
            payload: { newHostUserId: '11111111-1111-4111-8111-111111111456' },
        });
        expect(result.success).toBe(true);
    });

    it('rejects an unknown event type', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'unknown-verb',
            payload: {},
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing clientId', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            type: 'seek',
            payload: { currentTime: 10 },
        });
        expect(result.success).toBe(false);
    });

    it('rejects seek with missing currentTime', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'seek',
            payload: {},
        });
        expect(result.success).toBe(false);
    });

    it('rejects navigate with empty itemId', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'navigate',
            payload: { itemId: '', mediaType: 'movie', title: 'T' },
        });
        expect(result.success).toBe(false);
    });

    it('WATCH_TOGETHER_HOST_ONLY_EVENTS includes authoritative types', () => {
        for (const t of [
            'navigate',
            'version',
            'visibility',
            'transfer-host',
            'disband',
            'activity',
        ] as const) {
            expect(WATCH_TOGETHER_HOST_ONLY_EVENTS).toContain(t);
        }
    });

    it('WATCH_TOGETHER_HOST_ONLY_EVENTS does NOT include participant types', () => {
        for (const t of ['seek', 'sync', 'join', 'leave', 'stall', 'ready'] as const) {
            expect(WATCH_TOGETHER_HOST_ONLY_EVENTS).not.toContain(t);
        }
    });

    it('parses a valid disband event with empty payload', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'disband',
            payload: {},
        });
        expect(result.success).toBe(true);
    });

    it('parses a valid heartbeat event', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'heartbeat',
            payload: { currentTime: 99.9, isPlaying: true },
        });
        expect(result.success).toBe(true);
    });

    it('parses a valid visibility event', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'visibility',
            payload: { visibility: 'unlisted' },
        });
        expect(result.success).toBe(true);
    });

    it('parses a valid activity event with message', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'activity',
            payload: { activity: 'browsing', message: 'Looking for horror' },
        });
        expect(result.success).toBe(true);
    });

    it('rejects activity event with invalid activity value', () => {
        const result = watchTogetherEventInputSchema.safeParse({
            clientId: 'c1',
            type: 'activity',
            payload: { activity: 'sleeping' },
        });
        expect(result.success).toBe(false);
    });
});

// Non-Swift clients (e.g. web/JSON callers) may serialize an absent optional
// field as `null` rather than omitting the key. posterUrl/fileId used to be
// string-or-absent, so `null` produced a 422. These lock in null-tolerance
// while still normalizing to `undefined`.
describe('createSessionSchema tolerates null posterUrl/fileId', () => {
    const base = {
        itemId: 'item-1',
        mediaType: 'movie' as const,
        title: 'Movie',
        clientId: 'c1',
    };

    it('accepts explicit null posterUrl and fileId, normalizing to undefined', () => {
        const result = createSessionSchema.safeParse({
            ...base,
            posterUrl: null,
            fileId: null,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.posterUrl).toBeUndefined();
            expect(result.data.fileId).toBeUndefined();
        }
    });

    it('still accepts omitted posterUrl/fileId', () => {
        const result = createSessionSchema.safeParse(base);
        expect(result.success).toBe(true);
    });

    it('still accepts a real posterUrl string (trimmed)', () => {
        const result = createSessionSchema.safeParse({
            ...base,
            posterUrl: '  /img/poster.jpg  ',
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.posterUrl).toBe('/img/poster.jpg');
    });

    it('navigateSchema also tolerates null posterUrl/fileId', () => {
        const result = navigateSchema.safeParse({
            itemId: 'item-2',
            mediaType: 'episode',
            title: 'Ep',
            clientId: 'c1',
            posterUrl: null,
            fileId: null,
        });
        expect(result.success).toBe(true);
    });
});

describe('watch-together social contract', () => {
    it('defaults creation to unlisted and accepts an explicit listing', () => {
        const body = { itemId: 'item', mediaType: 'movie', title: 'Movie', clientId: 'client' };
        expect(createSessionSchema.parse(body).visibility).toBe('unlisted');
        expect(createSessionSchema.parse({ ...body, visibility: 'listed' }).visibility).toBe(
            'listed',
        );
    });

    it('rejects unknown command types and non-UUID host transfers', () => {
        expect(watchTogetherEventInputSchema.options).toHaveLength(17);
        expect(
            watchTogetherEventInputSchema.safeParse({ clientId: 'c', type: 'unknown', payload: {} })
                .success,
        ).toBe(false);
        expect(
            watchTogetherEventInputSchema.safeParse({
                clientId: 'c',
                type: 'transfer-host',
                payload: { newHostUserId: 'alice' },
            }).success,
        ).toBe(false);
    });
});

describe('watch-together wire identity', () => {
    it('requires a UUID userId and a displayName on participants', () => {
        const participant = {
            ...buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'Alice', 'internal'),
            clientId: 'c',
            joinedAt: 1,
        };
        expect(WatchTogetherParticipantSchema.parse(participant)).toEqual(participant);
        expect(
            WatchTogetherParticipantSchema.safeParse({ ...participant, userId: 'alice' }).success,
        ).toBe(false);
        const { displayName: _name, ...withoutName } = participant;
        expect(
            WatchTogetherParticipantSchema.safeParse({ ...withoutName, username: 'alice' }).success,
        ).toBe(false);
    });

    it('publishes the resync reason and current cursor', () => {
        for (const reason of ['gap', 'ahead']) {
            expect(
                WatchTogetherResyncFrameSchema.safeParse({
                    type: 'resync',
                    reason,
                    lastEventId: 70,
                }).success,
            ).toBe(true);
        }
    });
});

describe('watch-together command documentation', () => {
    it('emits 17 named command variants and the type discriminator', () => {
        const document = createDocument({
            openapi: '3.1.0',
            info: { title: 'Watch Together contract', version: '1' },
            paths: {
                '/events': {
                    post: {
                        requestBody: {
                            content: {
                                'application/json': { schema: watchTogetherEventInputSchema },
                            },
                        },
                        responses: { '204': { description: 'ok' } },
                    },
                },
            },
        });
        const body = document.paths?.['/events']?.post?.requestBody as {
            content: { 'application/json': { schema: { $ref: string } } };
        };
        const ref = body.content['application/json'].schema.$ref.split('/').pop() ?? '';
        const schema = document.components?.schemas?.[ref];
        expect(schema).toMatchObject({ discriminator: { propertyName: 'type' } });
        expect((schema as { oneOf: unknown[] }).oneOf).toHaveLength(17);
    });
});

describe('watch-together frame union', () => {
    it('accepts sync as a typed frame and strips unknown wire properties', () => {
        const frame: import('$lib/types/watch-together').SSEEventType = {
            type: 'sync',
            state: { currentTime: 42, isPlaying: true, playbackRate: 1, timestamp: 100 },
            author: buildPublicAuthor('11111111-1111-4111-8111-111111111111', 'Host', 'internal'),
            clientId: 'host-client',
        };
        const parsed = watchTogetherFrameSchema.parse({ ...frame, futureField: true });
        expect(parsed).toEqual(frame);
        if (parsed.type !== 'sync') throw new Error('Expected sync frame');
        // These typed assignments also guard discriminant narrowing of the inferred union.
        const userId: string = parsed.author.userId;
        const position: number = parsed.state.currentTime;
        expect(userId).toBe(frame.author.userId);
        expect(position).toBe(42);
    });

    it('rejects seek as an emitted frame', () => {
        expect(watchTogetherFrameSchema.safeParse({ type: 'seek', currentTime: 42 }).success).toBe(
            false,
        );
    });
});

it('trims host activity messages and enforces the 200-character limit', () => {
    const input = {
        clientId: 'c',
        type: 'activity',
        payload: { activity: 'browsing', message: '  hello  ' },
    };
    expect(watchTogetherEventInputSchema.parse(input).payload).toMatchObject({ message: 'hello' });
    expect(
        watchTogetherEventInputSchema.safeParse({
            ...input,
            payload: { ...input.payload, message: 'x'.repeat(201) },
        }).success,
    ).toBe(false);
});
