// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — host events reaching subscribing integrations.
 *
 * `IntegrationDefinition.sendNotification` existed as a declared contract with
 * no dispatcher behind it. These tests pin the delivery rules: opt-in only,
 * filtered by declared type, and isolated so one bad handler can neither stop
 * its peers nor propagate into the emitting path (a task run must never fail
 * because a notifier threw).
 */

import { describe, it, expect, vi } from 'vitest';
import type {
    IntegrationDefinition,
    NotificationEvent,
    PluginContext,
} from '@sapd/lumastra-plugin-sdk';
import {
    publishIntegrationEvent,
    hasIntegrationSubscribers,
    PLUGIN_EVENT_TYPES,
} from './integration-events.js';
import { authorizePlaybackViaPlugins } from './playback-authorization.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ctxStub = { logger: { warn: vi.fn(), error: vi.fn() } } as unknown as PluginContext;

function makeDeps(integrations: IntegrationDefinition[]) {
    return {
        listIntegrations: () => integrations,
        buildCtx: () => ctxStub,
    };
}

function integration(
    id: string,
    subscribes: string[] | undefined,
    sendNotification?: IntegrationDefinition['sendNotification'],
): IntegrationDefinition {
    return {
        id,
        capabilities: {},
        ...(subscribes ? { subscribes } : {}),
        ...(sendNotification ? { sendNotification } : {}),
    } as IntegrationDefinition;
}

const RUN_FAILED = { type: 'org.lumastra.task.run.failed', payload: { taskId: 'scan' } };

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('publishIntegrationEvent', () => {
    it('delivers to an integration subscribing to the event type', async () => {
        const send = vi.fn(async (_ctx: PluginContext, _event: NotificationEvent) => undefined);
        const deps = makeDeps([integration('notifier', ['org.lumastra.task.run.failed'], send)]);

        await publishIntegrationEvent(RUN_FAILED, deps);

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][1]).toEqual(RUN_FAILED);
    });

    it('skips an integration subscribing only to other event types', async () => {
        const send = vi.fn(async () => undefined);
        const deps = makeDeps([integration('notifier', ['org.lumastra.media.item.added'], send)]);

        await publishIntegrationEvent(RUN_FAILED, deps);

        expect(send).not.toHaveBeenCalled();
    });

    it('delivers every event type to a wildcard subscriber', async () => {
        const send = vi.fn(async () => undefined);
        const deps = makeDeps([integration('firehose', ['*'], send)]);

        await publishIntegrationEvent(RUN_FAILED, deps);

        expect(send).toHaveBeenCalledTimes(1);
    });

    it('delivers nothing to an integration that declares no subscription', async () => {
        // Opt-in matters: eight builtin integrations already implement a no-op
        // sendNotification. None of them declares `subscribes`, and none should
        // start receiving traffic because a dispatcher appeared.
        const send = vi.fn(async () => undefined);
        const deps = makeDeps([integration('legacy', undefined, send)]);

        await publishIntegrationEvent(RUN_FAILED, deps);

        expect(send).not.toHaveBeenCalled();
    });

    it('skips a subscriber that implements no sendNotification', async () => {
        const deps = makeDeps([integration('declaring-only', ['*'])]);

        await expect(publishIntegrationEvent(RUN_FAILED, deps)).resolves.toBeUndefined();
    });

    it('still delivers to later subscribers when an earlier one throws', async () => {
        const bad = vi.fn(async () => {
            throw new Error('handler exploded');
        });
        const good = vi.fn(async () => undefined);
        const deps = makeDeps([integration('bad', ['*'], bad), integration('good', ['*'], good)]);

        await publishIntegrationEvent(RUN_FAILED, deps);

        expect(bad).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(1);
    });

    it('never rejects, so a throwing handler cannot fail the emitting path', async () => {
        const deps = makeDeps([
            integration('bad', ['*'], async () => {
                throw new Error('handler exploded');
            }),
        ]);

        await expect(publishIntegrationEvent(RUN_FAILED, deps)).resolves.toBeUndefined();
    });

    it('does not wait forever on a handler that never settles', async () => {
        vi.useFakeTimers();
        try {
            const never = vi.fn(() => new Promise<void>(() => {}));
            const after = vi.fn(async () => undefined);
            const deps = makeDeps([
                integration('hung', ['*'], never),
                integration('after', ['*'], after),
            ]);

            const done = publishIntegrationEvent(RUN_FAILED, deps);
            await vi.advanceTimersByTimeAsync(60_000);
            await done;

            // The hung handler must not strand the ones behind it.
            expect(after).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('hasIntegrationSubscribers', () => {
    it('is true when some integration subscribes to the type', () => {
        const deps = makeDeps([
            integration('notifier', ['org.lumastra.media.item.added'], async () => undefined),
        ]);

        expect(hasIntegrationSubscribers('org.lumastra.media.item.added', deps)).toBe(true);
    });

    it('is false when nothing subscribes to the type', () => {
        const deps = makeDeps([
            integration('notifier', ['org.lumastra.task.run.failed'], async () => undefined),
        ]);

        expect(hasIntegrationSubscribers('org.lumastra.media.item.added', deps)).toBe(false);
    });

    it('is false for a subscriber that implements no sendNotification', () => {
        // Callers use this to decide whether to do expensive work BEFORE
        // publishing. A subscriber that could never receive the event must not
        // make them do it.
        const deps = makeDeps([integration('declaring-only', ['*'])]);

        expect(hasIntegrationSubscribers('org.lumastra.media.item.added', deps)).toBe(false);
    });

    it('is false rather than throwing when the registry is unavailable', () => {
        const deps = {
            listIntegrations: () => {
                throw new Error('registry not ready');
            },
            buildCtx: () => ctxStub,
        };

        expect(hasIntegrationSubscribers('org.lumastra.task.run.failed', deps)).toBe(false);
    });
});

describe('PLUGIN_EVENT_TYPES', () => {
    it('is the published catalogue an author writes `subscribes` against', () => {
        // A plugin's `subscribes` array is matched by exact string, so this list
        // IS the contract. A typo here silently means "you receive nothing" —
        // pinning it makes a rename show up as a failing test rather than as a
        // notifier that quietly stopped firing.
        expect([...PLUGIN_EVENT_TYPES].sort()).toEqual([
            'org.lumastra.media.item.added',
            'org.lumastra.playback.paused',
            'org.lumastra.playback.resumed',
            'org.lumastra.playback.started',
            'org.lumastra.playback.stopped',
            'org.lumastra.task.cost.threshold.exceeded',
            'org.lumastra.task.run.cancelled',
            'org.lumastra.task.run.cancelling',
            'org.lumastra.task.run.completed',
            'org.lumastra.task.run.failed',
            'org.lumastra.task.run.progress',
            'org.lumastra.task.run.stage.completed',
            'org.lumastra.task.run.started',
        ]);
    });
});

describe('authorizePlaybackViaPlugins', () => {
    const REQ = {
        userId: 'u1',
        username: 'alice',
        mediaId: 'm1',
        playMethod: 'transcode',
        deviceId: 'd1',
        ipAddress: '10.0.0.1',
    };

    function withIntegrations(defs: IntegrationDefinition[]) {
        return { listIntegrations: () => defs, buildCtx: () => ctxStub };
    }

    function gate(
        id: string,
        authorizePlayback: (...args: never[]) => Promise<{ allow: boolean; reason?: string }>,
    ): IntegrationDefinition {
        return { id, capabilities: {}, authorizePlayback } as unknown as IntegrationDefinition;
    }

    it('allows when no integration implements the hook', async () => {
        const verdict = await authorizePlaybackViaPlugins(
            REQ,
            withIntegrations([{ id: 'plain', capabilities: {} } as IntegrationDefinition]),
        );
        expect(verdict.allow).toBe(true);
    });

    it('denies with the plugin reason when one refuses', async () => {
        const verdict = await authorizePlaybackViaPlugins(
            REQ,
            withIntegrations([
                gate('limiter', async () => ({ allow: false, reason: 'too many streams' })),
            ]),
        );
        expect(verdict).toEqual({
            allow: false,
            reason: 'too many streams',
            deniedBy: 'limiter',
        });
    });

    it('lets any single integration veto, even when others allow', async () => {
        const verdict = await authorizePlaybackViaPlugins(
            REQ,
            withIntegrations([
                gate('permissive', async () => ({ allow: true })),
                gate('strict', async () => ({ allow: false, reason: 'nope' })),
            ]),
        );
        expect(verdict.allow).toBe(false);
    });

    it('FAILS OPEN when a gate throws', async () => {
        // A broken third-party policy must not make the server unwatchable. A
        // policy that stops being enforced is a policy failure; a media server
        // that refuses every stream is an outage.
        const verdict = await authorizePlaybackViaPlugins(
            REQ,
            withIntegrations([
                gate('broken', async () => {
                    throw new Error('boom');
                }),
            ]),
        );
        expect(verdict.allow).toBe(true);
    });

    it('FAILS OPEN when a gate hangs', async () => {
        vi.useFakeTimers();
        try {
            const verdict = authorizePlaybackViaPlugins(
                REQ,
                withIntegrations([gate('hung', () => new Promise(() => {}))]),
            );
            await vi.advanceTimersByTimeAsync(30_000);
            expect((await verdict).allow).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('treats a malformed verdict as an allow rather than guessing', async () => {
        const verdict = await authorizePlaybackViaPlugins(
            REQ,
            withIntegrations([gate('sloppy', async () => 'no' as unknown as { allow: boolean })]),
        );
        expect(verdict.allow).toBe(true);
    });
});
