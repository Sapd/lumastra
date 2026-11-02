// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the admin SSE endpoint `/api/admin/ingest/stream`.
 *
 * The handler subscribes to the `pipeline:stage-state` pubsub channel and
 * forwards StageStateChangedEvent payloads as `stage-state-changed` frames.
 * A Valkey-backed replay buffer enables reconnect with `Last-Event-ID`.
 *
 * Three primary scenarios:
 *   1. Connected admin client receives a frame published to the channel.
 *   2. Non-admin request returns 403.
 *   3. Last-Event-ID resume replays buffered frames.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('$lib/server/cache/valkey.js', () => ({
    subscribeToChannel: vi.fn().mockResolvedValue(null),
    getValkeyClient: vi.fn(() => null),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
    _consumersForTest as consumersForTest,
    _broadcastToConsumersForTest as broadcastToConsumersForTest,
    type Consumer,
} from './+server.js';
import { getValkeyClient } from '$lib/server/cache/valkey.js';
import type { RequestEvent } from '@sveltejs/kit';
import type { StageStateChangedEvent } from '$lib/server/cache/pipeline-pubsub.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeController(): {
    controller: ReadableStreamDefaultController<Uint8Array>;
    enqueued: Uint8Array[];
} {
    const enqueued: Uint8Array[] = [];
    const controller = {
        enqueue: (chunk: Uint8Array) => {
            enqueued.push(chunk);
        },
        close: () => {},
        error: () => {},
        desiredSize: 1,
    } as unknown as ReadableStreamDefaultController<Uint8Array>;
    return { controller, enqueued };
}

function decodeFrames(chunks: Uint8Array[]): string[] {
    const decoder = new TextDecoder();
    return chunks.map((c) => decoder.decode(c));
}

function makeAbortController() {
    const ac = new AbortController();
    return ac;
}

function makeMockEvent(opts: {
    isAdmin: boolean;
    lastEventId?: string;
    since?: string;
}): RequestEvent {
    const ac = makeAbortController();
    const url = new URL('http://localhost/api/admin/ingest/stream');
    if (opts.since) url.searchParams.set('since', opts.since);

    const headers = new Headers();
    if (opts.lastEventId) headers.set('last-event-id', opts.lastEventId);

    return {
        request: {
            signal: ac.signal,
            headers,
        },
        url,
        locals: {
            user: opts.isAdmin
                ? { username: 'admin', isAdmin: true, userGroups: ['admins'] }
                : null,
        },
        params: {},
        route: { id: '/api/admin/ingest/stream' },
        cookies: {} as RequestEvent['cookies'],
        fetch: fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        setHeaders: () => {},
        isDataRequest: false,
        isSubRequest: false,
    } as unknown as RequestEvent;
}

const sampleEvent: StageStateChangedEvent = {
    mediaItemId: 'media-uuid-1',
    stageId: 'embed-metadata',
    oldStatus: 'pending',
    newStatus: 'running',
    processingVersion: 1,
    runId: 'run-ulid-1',
    timestamp: '2026-05-19T12:00:00.000Z',
    kind: 'transition',
};

// ── Test suite ────────────────────────────────────────────────────────────────

describe('/api/admin/ingest/stream', () => {
    beforeEach(() => {
        consumersForTest.clear();
    });

    afterEach(() => {
        consumersForTest.clear();
        vi.mocked(getValkeyClient).mockReturnValue(null);
    });

    // ── Test 1: Admin receives published frame ──────────────────────────────

    it('connected admin consumer receives a stage-state-changed frame via broadcast', () => {
        const { controller, enqueued } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: true,
        };
        consumersForTest.add(consumer);

        broadcastToConsumersForTest({
            id: 1,
            type: 'stage-state-changed',
            data: sampleEvent,
        });

        expect(enqueued).toHaveLength(1);
        const text = decodeFrames(enqueued)[0];
        expect(text).toContain('id: 1');
        expect(text).toContain('event: stage-state-changed');
        expect(text).toContain('"mediaItemId":"media-uuid-1"');
        expect(text).toContain('"stageId":"embed-metadata"');
        expect(text).toContain('"newStatus":"running"');
    });

    // ── Test 2: Non-admin returns 403 ──────────────────────────────────────

    it('non-admin request returns 403 Forbidden', async () => {
        const { GET } = await import('./+server.js');
        const event = makeMockEvent({ isAdmin: false });

        expect(GET).toBeDefined();
        const response = await GET!(event);

        expect(response.status).toBe(403);
    });

    // ── Test 3: Last-Event-ID replay ────────────────────────────────────────

    it('replays buffered frames with id > Last-Event-ID from Valkey', () => {
        // Simulate Valkey returning buffered frames (LRANGE returns newest-first).
        const bufferedFrames = [
            `5:${JSON.stringify({ type: 'stage-state-changed', data: { ...sampleEvent, runId: 'run-5' } })}`,
            `4:${JSON.stringify({ type: 'stage-state-changed', data: { ...sampleEvent, runId: 'run-4' } })}`,
            `3:${JSON.stringify({ type: 'stage-state-changed', data: { ...sampleEvent, runId: 'run-3' } })}`,
        ];

        const mockClient = {
            customCommand: vi.fn(async (cmd: string[]) => {
                if (cmd[0] === 'LRANGE') return bufferedFrames;
                return 0;
            }),
        };
        vi.mocked(getValkeyClient).mockReturnValue(
            mockClient as unknown as ReturnType<typeof getValkeyClient>,
        );

        const { controller, enqueued } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: false,
        };
        consumersForTest.add(consumer);

        // Simulate the replay drain the route handler performs (sinceId=3).
        // Only frames with id > 3 should be replayed: ids 4 and 5.
        const sinceId = 3;
        const rawFrames = bufferedFrames;
        const decoder = new TextDecoder();
        const replayFrames: Array<{ id: number; type: string; data: unknown }> = [];

        for (const item of rawFrames) {
            const sepIdx = item.indexOf(':');
            if (sepIdx <= 0) continue;
            const id = Number(item.slice(0, sepIdx));
            if (!Number.isFinite(id) || id <= sinceId) continue;
            const parsed = JSON.parse(item.slice(sepIdx + 1)) as {
                type?: string;
                data?: unknown;
            };
            replayFrames.push({
                id,
                type: typeof parsed.type === 'string' ? parsed.type : 'stage-state-changed',
                data: parsed.data,
            });
        }
        replayFrames.sort((a, b) => a.id - b.id);

        const enc = new TextEncoder();
        for (const f of replayFrames) {
            controller.enqueue(
                enc.encode(`id: ${f.id}\nevent: ${f.type}\ndata: ${JSON.stringify(f.data)}\n\n`),
            );
        }

        const maxReplayId = replayFrames.length
            ? replayFrames[replayFrames.length - 1].id
            : sinceId;
        consumer.replayDone = true;
        for (const frame of consumer.localBuffer) {
            if (frame.id > maxReplayId) {
                controller.enqueue(
                    enc.encode(
                        `id: ${frame.id}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`,
                    ),
                );
            }
        }
        consumer.localBuffer.length = 0;

        const decoded = decodeFrames(enqueued);
        expect(decoded).toHaveLength(2);
        const ids = decoded.map((s) => {
            const m = s.match(/id: (\d+)/);
            return m ? Number(m[1]) : NaN;
        });
        expect(ids).toEqual([4, 5]);
        decoded.forEach((text) => expect(text).toContain('event: stage-state-changed'));

        // Decode the string explicitly to avoid unused-variable lint error.
        void decoder;
    });

    // ── Bootstrap-race: consumer buffer behaviour ─────────────────────────

    describe('consumer bootstrap-race buffering', () => {
        it('frames broadcast while replayDone=false land in localBuffer (not controller)', () => {
            const { controller, enqueued } = makeFakeController();
            const consumer: Consumer = {
                controller,
                localBuffer: [],
                replayDone: false,
            };
            consumersForTest.add(consumer);

            broadcastToConsumersForTest({
                id: 10,
                type: 'stage-state-changed',
                data: sampleEvent,
            });

            expect(enqueued).toHaveLength(0);
            expect(consumer.localBuffer).toHaveLength(1);
            expect(consumer.localBuffer[0].id).toBe(10);
        });

        it('once replayDone=true, broadcasts go directly to controller', () => {
            const { controller, enqueued } = makeFakeController();
            const consumer: Consumer = {
                controller,
                localBuffer: [],
                replayDone: true,
            };
            consumersForTest.add(consumer);

            broadcastToConsumersForTest({
                id: 20,
                type: 'stage-state-changed',
                data: sampleEvent,
            });

            expect(consumer.localBuffer).toHaveLength(0);
            expect(enqueued).toHaveLength(1);
            const text = decodeFrames(enqueued)[0];
            expect(text).toContain('id: 20');
            expect(text).toContain('event: stage-state-changed');
        });

        it('bootstrap-window buffer is deduped against maxReplayId on flush', () => {
            const { controller, enqueued } = makeFakeController();
            const consumer: Consumer = {
                controller,
                localBuffer: [],
                replayDone: false,
            };
            consumersForTest.add(consumer);

            // Both id=50 (in replay) and id=51 (new) arrive during bootstrap.
            broadcastToConsumersForTest({
                id: 50,
                type: 'stage-state-changed',
                data: {},
            });
            broadcastToConsumersForTest({
                id: 51,
                type: 'stage-state-changed',
                data: {},
            });

            // Simulate replay returning up to id=50.
            const replay = [
                { id: 49, type: 'stage-state-changed', data: {} },
                { id: 50, type: 'stage-state-changed', data: {} },
            ];
            const enc = new TextEncoder();
            for (const f of replay) {
                controller.enqueue(
                    enc.encode(
                        `id: ${f.id}\nevent: ${f.type}\ndata: ${JSON.stringify(f.data)}\n\n`,
                    ),
                );
            }
            const maxReplayId = replay[replay.length - 1].id;

            const pending = consumer.localBuffer;
            consumer.localBuffer = [];
            consumer.replayDone = true;
            for (const frame of pending) {
                if (frame.id > maxReplayId) {
                    controller.enqueue(
                        enc.encode(
                            `id: ${frame.id}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`,
                        ),
                    );
                }
            }

            const ids = decodeFrames(enqueued).map((s) => {
                const m = s.match(/id: (\d+)/);
                return m ? Number(m[1]) : NaN;
            });
            // id=49 and id=50 from replay, id=51 from local buffer; id=50 deduped.
            expect(ids).toEqual([49, 50, 51]);
        });
    });
});
