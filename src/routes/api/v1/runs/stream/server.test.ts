// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the SSE meta-event wrap in `/api/v1/runs/stream`.
 *
 * The handler subscribes to `task:events:<class>` pubsub channels and
 * forwards messages as CloudEvent frames. The `meta` channel publishes
 * a thin `{type, data?, ts?}` shape — without a CloudEvent envelope —
 * which previously failed `CloudEventSchema.safeParse` on the client.
 *
 * F12 wraps meta messages server-side into a full CloudEvent envelope
 * and skips them from the replay buffer (which is sized for transition
 * events and should not be evicted by self-observability meta).
 *
 * These tests exercise the pure `prepareFrame` helper plus the
 * `CloudEventSchema` round-trip so we know the admin client will parse
 * the wrapped frame.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

// `subscribeToChannel` opens a Valkey subscription at module load — stub
// it out so the test doesn't try to connect to a real broker. Importing
// `+server.ts` would otherwise schedule a real Valkey subscribe call.
vi.mock('$lib/server/cache/valkey.js', () => ({
    subscribeToChannel: vi.fn().mockResolvedValue(null),
    getValkeyClient: vi.fn(() => null),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
    _prepareFrame as prepareFrame,
    _metaCloudEventType as metaCloudEventType,
    _consumersForTest as consumersForTest,
    _broadcastToConsumersForTest as broadcastToConsumersForTest,
    type Consumer,
} from './+server.js';
import { CloudEventSchema } from '$lib/schemas/cloud-events.schema.js';

// ── metaCloudEventType ────────────────────────────────────────────────────────

describe('metaCloudEventType', () => {
    it('maps known meta subtypes to their org.lumastra.task.meta.* form', () => {
        expect(metaCloudEventType('leader-elected')).toBe('org.lumastra.task.meta.leader-elected');
        expect(metaCloudEventType('node-registered')).toBe(
            'org.lumastra.task.meta.node-registered',
        );
        expect(metaCloudEventType('scheduler-tick')).toBe('org.lumastra.task.meta.scheduler-tick');
        expect(metaCloudEventType('recovery-reclaimed')).toBe(
            'org.lumastra.task.meta.recovery-reclaimed',
        );
        expect(metaCloudEventType('pipeline-when-skip')).toBe(
            'org.lumastra.task.meta.pipeline-when-skip',
        );
    });

    it('strips a fully-qualified prefix before matching the subtype', () => {
        // Publishers occasionally pre-qualify the type — the helper should
        // accept that form too rather than fall through to `unknown`.
        expect(metaCloudEventType('org.lumastra.task.meta.leader-elected')).toBe(
            'org.lumastra.task.meta.leader-elected',
        );
    });

    it('falls back to org.lumastra.task.meta.unknown for unknown subtypes', () => {
        expect(metaCloudEventType('made-up-event')).toBe('org.lumastra.task.meta.unknown');
        expect(metaCloudEventType('')).toBe('org.lumastra.task.meta.unknown');
    });
});

// ── prepareFrame: meta channel ────────────────────────────────────────────────

describe('prepareFrame (meta channel)', () => {
    it('wraps a {type,data,ts} publisher payload in a CloudEvent envelope', () => {
        const ts = '2026-05-15T12:00:00.000Z';
        const msg = JSON.stringify({
            type: 'leader-elected',
            data: { cls: 'io', instanceId: 'web-1' },
            ts,
        });

        const prepared = prepareFrame('meta', msg);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        expect(prepared.type).toBe('org.lumastra.task.meta.leader-elected');
        expect(prepared.shouldPushToReplay).toBe(false);

        // The frame data is the CloudEvent envelope itself.
        const envelope = prepared.data as Record<string, unknown>;
        expect(envelope.specversion).toBe('1.0');
        expect(envelope.type).toBe('org.lumastra.task.meta.leader-elected');
        expect(envelope.subject).toBe('meta');
        expect(envelope.datacontenttype).toBe('application/json');
        expect(envelope.source).toBe('/lumastra/orchestrator');
        expect(typeof envelope.id).toBe('string');
        // Preserves the publisher's timestamp rather than overwriting with `now`.
        expect(envelope.time).toBe(ts);
        expect(envelope.data).toEqual({ cls: 'io', instanceId: 'web-1' });
    });

    it('produces an envelope that CloudEventSchema.safeParse accepts', () => {
        const msg = JSON.stringify({
            type: 'scheduler-tick',
            data: { taskId: 'embed-metadata' },
            ts: '2026-05-15T12:00:00.000Z',
        });
        const prepared = prepareFrame('meta', msg);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const parsed = CloudEventSchema.safeParse(prepared.data);
        expect(parsed.success).toBe(true);
    });

    it('falls back to "unknown" type for malformed meta type strings', () => {
        const msg = JSON.stringify({
            type: 'wat-is-this',
            data: { foo: 'bar' },
            ts: '2026-05-15T12:00:00.000Z',
        });
        const prepared = prepareFrame('meta', msg);
        expect(prepared?.type).toBe('org.lumastra.task.meta.unknown');

        const parsed = CloudEventSchema.safeParse(prepared?.data);
        expect(parsed.success).toBe(true);
    });

    it('handles flat publisher payloads (boot-recovery) by hoisting fields into data', () => {
        // boot-recovery emits `{type, count, runIds}` — no nested `data`, no `ts`.
        const msg = JSON.stringify({
            type: 'recovery-reclaimed',
            count: 3,
            runIds: ['run-a', 'run-b', 'run-c'],
        });
        const prepared = prepareFrame('meta', msg);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const envelope = prepared.data as Record<string, unknown>;
        expect(envelope.type).toBe('org.lumastra.task.meta.recovery-reclaimed');
        // Fields other than type/ts get folded into `data`.
        expect(envelope.data).toEqual({
            count: 3,
            runIds: ['run-a', 'run-b', 'run-c'],
        });
        // No publisher ts → envelope.time falls back to a valid ISO string.
        expect(typeof envelope.time).toBe('string');
        expect(() => new Date(envelope.time as string).toISOString()).not.toThrow();
    });

    it('returns null for a malformed JSON payload (drops, does not throw)', () => {
        expect(prepareFrame('meta', 'this is not json')).toBeNull();
        expect(prepareFrame('meta', '')).toBeNull();
        expect(prepareFrame('meta', '{"unterminated":')).toBeNull();
    });

    it('returns null for a JSON payload that is not a plain object', () => {
        expect(prepareFrame('meta', 'null')).toBeNull();
        expect(prepareFrame('meta', '42')).toBeNull();
        expect(prepareFrame('meta', '"a string"')).toBeNull();
        expect(prepareFrame('meta', '[1,2,3]')).toBeNull();
    });

    it('uses a fresh timestamp when the publisher omits ts', () => {
        const before = Date.now();
        const prepared = prepareFrame(
            'meta',
            JSON.stringify({ type: 'node-registered', data: {} }),
        );
        const after = Date.now();
        const t = (prepared?.data as Record<string, unknown>).time as string;
        const parsedT = Date.parse(t);
        // The synthesised time should be within the test's window — proves
        // the fallback path executed (no `ts` in payload).
        expect(parsedT).toBeGreaterThanOrEqual(before);
        expect(parsedT).toBeLessThanOrEqual(after);
    });

    it('Critical-3 (F12): {type, data: null} falls through to flat-fold and produces valid envelope', () => {
        // Previously the check was `evt.data !== undefined`, which lets `null`
        // through and stamps `envelope.data = null`, breaking CloudEventSchema
        // on the client. The fix tightens to `data != null && typeof === object`.
        const msg = JSON.stringify({
            type: 'leader-elected',
            data: null, // <-- the bad shape
            ts: '2026-05-15T12:00:00.000Z',
            cls: 'io',
        });
        const prepared = prepareFrame('meta', msg);
        expect(prepared).not.toBeNull();
        if (!prepared) return;

        const envelope = prepared.data as Record<string, unknown>;
        // envelope.data must NOT be null — it should be the flat-fold object.
        expect(envelope.data).not.toBeNull();
        expect(typeof envelope.data).toBe('object');
        // The flat-fold path should hoist publisher-side custom fields (like cls).
        expect(envelope.data).toEqual({ cls: 'io' });

        // And the resulting envelope must still parse cleanly.
        const parsed = CloudEventSchema.safeParse(prepared.data);
        expect(parsed.success).toBe(true);
    });

    it('Important-4 (F12): META_TYPES whitelist covers subscription-lost', () => {
        expect(metaCloudEventType('subscription-lost')).toBe(
            'org.lumastra.task.meta.subscription-lost',
        );
        const msg = JSON.stringify({
            type: 'subscription-lost',
            data: { cls: 'io', error: 'Valkey hiccup' },
            ts: '2026-05-15T12:00:00.000Z',
        });
        const prepared = prepareFrame('meta', msg);
        expect(prepared?.type).toBe('org.lumastra.task.meta.subscription-lost');
        // Not demoted to .unknown — proves the whitelist entry exists.
        const envelope = prepared?.data as Record<string, unknown>;
        expect(envelope.type).toBe('org.lumastra.task.meta.subscription-lost');
    });

    it('Important-4 (F12): META_TYPES whitelist covers leader-reacquired and transition-conflict', () => {
        for (const sub of ['leader-reacquired', 'transition-conflict']) {
            expect(metaCloudEventType(sub)).toBe(`org.lumastra.task.meta.${sub}`);
            const prepared = prepareFrame(
                'meta',
                JSON.stringify({
                    type: sub,
                    data: { detail: 'x' },
                    ts: new Date().toISOString(),
                }),
            );
            // Must NOT fall back to .unknown — these are emitted by orchestrator.ts
            // and the SSE bridge needs to forward them with their proper type.
            expect(prepared?.type).toBe(`org.lumastra.task.meta.${sub}`);
        }
    });

    it('never marks meta events as eligible for the replay buffer', () => {
        // Replay-buffer slots are sized for transition events. Meta is
        // best-effort live-only — pushing it would evict real transitions.
        for (let i = 0; i < 50; i++) {
            const prepared = prepareFrame(
                'meta',
                JSON.stringify({
                    type: 'scheduler-tick',
                    data: { i },
                    ts: new Date().toISOString(),
                }),
            );
            expect(prepared?.shouldPushToReplay).toBe(false);
        }
    });
});

// ── prepareFrame: transition channels ─────────────────────────────────────────

describe('prepareFrame (transition channels)', () => {
    it('forwards a transition message verbatim and marks it replayable', () => {
        const evt = {
            specversion: '1.0',
            id: 'ulid-1',
            source: 'lumastra://task-orchestrator/web-1',
            type: 'org.lumastra.task.run.started',
            subject: 'embed-metadata/run-1',
            time: '2026-05-15T12:00:00.000Z',
            datacontenttype: 'application/json',
            data: { id: 'run-1', taskId: 'embed-metadata', state: 'active' },
        };
        const prepared = prepareFrame('io', JSON.stringify(evt));
        expect(prepared).not.toBeNull();
        expect(prepared?.type).toBe('org.lumastra.task.run.started');
        expect(prepared?.data).toEqual(evt);
        expect(prepared?.shouldPushToReplay).toBe(true);
    });

    it('falls back to a stable type label when the message has no type field', () => {
        const prepared = prepareFrame('cpu', JSON.stringify({ foo: 'bar' }));
        expect(prepared?.type).toBe('task.cpu.event');
        expect(prepared?.shouldPushToReplay).toBe(true);
    });

    it('drops malformed transition payloads without throwing', () => {
        expect(prepareFrame('io', 'not json')).toBeNull();
        expect(prepareFrame('embedding', '[1,2,3]')).toBeNull();
        expect(prepareFrame('maintenance', 'null')).toBeNull();
    });
});

// ── Bootstrap-race: consumer buffer behaviour ────────────────────────────────
//
// Race: between `consumers.add(consumer)` and the end of `await
// readReplaySince(sinceId)`, the live pubsub subscription can broadcast new
// frames. Those frames must NOT be lost to a connecting consumer. The fix
// is to register the consumer first with a `replayDone=false` flag and a
// `localBuffer[]`; broadcasts during the bootstrap window get appended to
// the buffer; after the route handler drains the replay it flips the flag
// and flushes the buffer (filtering anything ≤ maxReplayId so we don't
// double-send frames already in the replay).
describe('consumer bootstrap-race buffering', () => {
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

    it('frames broadcast while replayDone=false land in localBuffer (not controller)', () => {
        // Clean slate so other tests' consumers don't pollute the broadcast loop.
        consumersForTest.clear();
        const { controller, enqueued } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: false,
        };
        consumersForTest.add(consumer);

        // Frame arrives during the bootstrap window.
        broadcastToConsumersForTest({
            id: 42,
            type: 'task.run.started',
            data: { x: 1 },
        });

        // Should have been buffered, not enqueued.
        expect(enqueued).toHaveLength(0);
        expect(consumer.localBuffer).toHaveLength(1);
        expect(consumer.localBuffer[0].id).toBe(42);

        consumersForTest.delete(consumer);
    });

    it('once replayDone=true, broadcasts go directly to controller', () => {
        consumersForTest.clear();
        const { controller, enqueued } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: true,
        };
        consumersForTest.add(consumer);

        broadcastToConsumersForTest({
            id: 7,
            type: 'task.run.completed',
            data: {},
        });

        expect(consumer.localBuffer).toHaveLength(0);
        expect(enqueued).toHaveLength(1);
        const text = decodeFrames(enqueued)[0];
        expect(text).toContain('id: 7');
        expect(text).toContain('event: task.run.completed');

        consumersForTest.delete(consumer);
    });

    it('end-to-end: bootstrap window buffer flush is deduped against maxReplayId', () => {
        // Simulate the full sequence the route handler runs:
        //   1. consumers.add(consumer)
        //   2. <broadcast arrives during await>  → goes to localBuffer
        //   3. readReplaySince() returns frames up to id=100
        //   4. enqueue replay frames
        //   5. replayDone=true; drain localBuffer skipping id ≤ 100
        consumersForTest.clear();
        const { controller, enqueued } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: false,
        };
        consumersForTest.add(consumer);

        // (2) A broadcast that was ALSO in the replay LIST (id=99) plus a
        // genuinely-new broadcast (id=101) both arrive during the await.
        broadcastToConsumersForTest({
            id: 99,
            type: 'task.run.started',
            data: {},
        });
        broadcastToConsumersForTest({
            id: 101,
            type: 'task.run.completed',
            data: {},
        });

        // (3) Simulated replay batch ending at id=100.
        const replay = [
            { id: 98, type: 'task.run.started', data: {} },
            { id: 99, type: 'task.run.progress', data: {} },
            { id: 100, type: 'task.run.progress', data: {} },
        ];
        // (4) Enqueue replay manually (mirroring the route handler).
        for (const f of replay) {
            controller.enqueue(
                new TextEncoder().encode(
                    `id: ${f.id}\nevent: ${f.type}\ndata: ${JSON.stringify(f.data)}\n\n`,
                ),
            );
        }
        const maxReplayId = replay[replay.length - 1].id;

        // (5) Flip + drain — same shape as the route handler.
        consumer.replayDone = true;
        for (const frame of consumer.localBuffer) {
            if (frame.id > maxReplayId) {
                controller.enqueue(
                    new TextEncoder().encode(
                        `id: ${frame.id}\nevent: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`,
                    ),
                );
            }
        }
        consumer.localBuffer.length = 0;

        // Verify: replay frames + only the bootstrap-window frame with id>100.
        // id=99 was deduped (≤ maxReplayId=100); id=101 made it through.
        const decoded = decodeFrames(enqueued);
        const ids = decoded.map((s) => {
            const m = s.match(/id: (\d+)/);
            return m ? Number(m[1]) : NaN;
        });
        expect(ids).toEqual([98, 99, 100, 101]);

        consumersForTest.delete(consumer);
    });

    it('caps localBuffer at MAX_LOCAL_BUFFER and evicts the oldest frame (finding #10)', () => {
        // Pathological slow-replay + broadcast burst would otherwise grow
        // localBuffer without bound and exhaust memory. The cap evicts the
        // oldest frame so the newest still lands; clients can fill gaps
        // via reconnection with Last-Event-ID.
        consumersForTest.clear();
        const { controller } = makeFakeController();
        const consumer: Consumer = {
            controller,
            localBuffer: [],
            replayDone: false,
        };
        consumersForTest.add(consumer);

        // Push 1500 frames (well above MAX_LOCAL_BUFFER=1000).
        for (let i = 1; i <= 1500; i++) {
            broadcastToConsumersForTest({
                id: i,
                type: 'task.run.progress',
                data: {},
            });
        }

        // Buffer is capped at 1000.
        expect(consumer.localBuffer.length).toBe(1000);
        // Oldest frames have been evicted — the buffer holds the most
        // recent 1000 ids (501..1500).
        expect(consumer.localBuffer[0].id).toBe(501);
        expect(consumer.localBuffer[consumer.localBuffer.length - 1].id).toBe(1500);

        consumersForTest.delete(consumer);
    });

    it('multiple consumers in different states: live one delivers immediately, bootstrapping one buffers', () => {
        consumersForTest.clear();
        const live = makeFakeController();
        const liveConsumer: Consumer = {
            controller: live.controller,
            localBuffer: [],
            replayDone: true,
        };
        const boot = makeFakeController();
        const bootConsumer: Consumer = {
            controller: boot.controller,
            localBuffer: [],
            replayDone: false,
        };
        consumersForTest.add(liveConsumer);
        consumersForTest.add(bootConsumer);

        broadcastToConsumersForTest({
            id: 1,
            type: 'task.run.started',
            data: {},
        });

        expect(live.enqueued).toHaveLength(1);
        expect(boot.enqueued).toHaveLength(0);
        expect(bootConsumer.localBuffer).toHaveLength(1);

        consumersForTest.delete(liveConsumer);
        consumersForTest.delete(bootConsumer);
    });
});
