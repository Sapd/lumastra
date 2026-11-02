// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ProgressTracker.
 * Uses fake timers so throttle/heartbeat intervals can be driven deterministically.
 *
 * Run with: npx vitest run src/lib/server/tasks/progress.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressTracker } from './progress.js';
import { randomUUID } from 'node:crypto';

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: vi.fn(() => null),
    getValkeyClient: vi.fn(() => ({ customCommand: vi.fn(async () => 1) })),
    publishMessage: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type Cmd = string[];

function isRegularProgressCommand(cmd: Cmd): boolean {
    return cmd[0] === 'EVALSHA' && cmd[2] === '3';
}
function isFinalProgressCommand(cmd: Cmd): boolean {
    return cmd[0] === 'EVALSHA' && cmd[2] === '4';
}

function makeFakeClient(): {
    customCommand: (cmd: Cmd) => Promise<unknown>;
    calls: Cmd[];
} {
    const calls: Cmd[] = [];
    return {
        calls,
        customCommand: async (cmd: Cmd) => {
            calls.push(cmd);
            return 1;
        },
    };
}

// ── Throttle ──────────────────────────────────────────────────────────────────

describe('ProgressTracker throttle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('three rapid reports within throttle window produce one immediate + one deferred flush', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_1');

        report(1);
        // Flush should be immediate (lastReportedAt=0, sinceLast >= throttleMs).
        await Promise.resolve();
        const firstFlushCount = client.calls.filter((c) => isRegularProgressCommand(c)).length;
        expect(firstFlushCount).toBe(1);

        // Second call within window — deferred.
        report(2);
        report(3);

        // Before timer fires — still just 1 flush.
        expect(client.calls.filter((c) => isRegularProgressCommand(c)).length).toBe(1);

        // Advance past throttle window.
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();

        const totalFlushes = client.calls.filter((c) => isRegularProgressCommand(c)).length;
        expect(totalFlushes).toBe(2);

        tracker.finalize('run_1');
    });

    it('immediate flush passes the processed value to Valkey', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_vals');

        report(42, 100, 'item-A');
        await Promise.resolve();

        const hset = client.calls.find((c) => isRegularProgressCommand(c));
        expect(hset).toBeDefined();
        // HSET key field value ...
        const argsMap: Record<string, string> = {};
        for (let i = 3 + Number(hset?.[2]); i + 1 < (hset?.length ?? 0) - 4; i += 2) {
            argsMap[hset![i]] = hset![i + 1];
        }
        expect(argsMap['stage:main:processed']).toBe('42');
        expect(argsMap['stage:main:total']).toBe('100');
        expect(argsMap['stage:main:currentItem']).toBe('item-A');

        tracker.finalize('run_vals');
    });
});

// ── Heartbeat ─────────────────────────────────────────────────────────────────

describe('ProgressTracker heartbeat', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('forces a flush every 30s even with no new reports', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        tracker.create('run_hb');

        // Advance exactly 30s — heartbeat should fire once.
        await vi.advanceTimersByTimeAsync(30_000);
        await Promise.resolve();

        const hsets = client.calls.filter((c) => isRegularProgressCommand(c));
        expect(hsets.length).toBeGreaterThanOrEqual(1);

        tracker.finalize('run_hb');
    });
});

// ── High-watermark ────────────────────────────────────────────────────────────

describe('ProgressTracker high-watermark', () => {
    it('total only increases — decrease is ignored', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        vi.useFakeTimers();

        const report = tracker.create('run_hwm');

        report(0, 100);
        await Promise.resolve();

        // Attempt to decrease total.
        report(1, 50);
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();

        // Find the last HSET and check stage:main:total.
        const hsets = client.calls.filter((c) => isRegularProgressCommand(c));
        const lastHset = hsets[hsets.length - 1];
        const argsMap: Record<string, string> = {};
        for (let i = 3 + Number(lastHset[2]); i + 1 < lastHset.length - 4; i += 2) {
            argsMap[lastHset[i]] = lastHset[i + 1];
        }
        // Total should remain 100, not drop to 50.
        expect(argsMap['stage:main:total']).toBe('100');

        tracker.finalize('run_hwm');
        vi.useRealTimers();
    });

    it('total=0 resets the high-watermark', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        vi.useFakeTimers();

        const report = tracker.create('run_reset');

        report(0, 100);
        await Promise.resolve();

        // Reset via total=0.
        report(0, 0);
        await vi.advanceTimersByTimeAsync(250);
        await Promise.resolve();

        const hsets = client.calls.filter((c) => isRegularProgressCommand(c));
        const lastHset = hsets[hsets.length - 1];
        const argsMap: Record<string, string> = {};
        for (let i = 3 + Number(lastHset[2]); i + 1 < lastHset.length - 4; i += 2) {
            argsMap[lastHset[i]] = lastHset[i + 1];
        }
        expect(argsMap['stage:main:total']).toBe('0');

        tracker.finalize('run_reset');
        vi.useRealTimers();
    });
});

// ── finalize ──────────────────────────────────────────────────────────────────

describe('ProgressTracker.finalize', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('clears timers so no *additional* timer-driven flush happens after finalize', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_fin');

        // Trigger deferred flush.
        report(1);
        await Promise.resolve();
        report(2); // schedules pending timer

        // Finalize flushes the buffered value synchronously (see dedicated
        // test below) — snapshot the count *after* finalize so this test
        // only asserts no *extra* flush comes from the (now-cleared) timers.
        tracker.finalize('run_fin');
        const flushCountBefore = client.calls.filter((c) => isRegularProgressCommand(c)).length;

        // Advance past throttle window — no additional flush should happen.
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();

        const flushCountAfter = client.calls.filter((c) => isRegularProgressCommand(c)).length;
        expect(flushCountAfter).toBe(flushCountBefore);
    });

    it('finalize on unknown runId is a no-op', () => {
        const tracker = new ProgressTracker(() => null);
        expect(() => tracker.finalize('run_ghost')).not.toThrow();
    });

    it('BUG FIX: flushes a value buffered within the throttle window before finalize deletes state', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_lastval');

        // Immediate flush (sinceLast >= throttleMs on first call) — writes 999/1000.
        report(999, 1000);
        await Promise.resolve();
        const afterFirst = client.calls.filter((c) => isRegularProgressCommand(c)).length;
        expect(afterFirst).toBe(1);

        // Second report lands inside the 250ms throttle window and is only
        // buffered in `lastValues` behind a pendingTimer — never written.
        report(1000, 1000);
        expect(client.calls.filter((c) => isRegularProgressCommand(c)).length).toBe(1);

        // Plugin returns immediately — runner calls finalize() before the
        // pendingTimer would have fired.
        tracker.finalize('run_lastval');

        const hsets = client.calls.filter((c) => isRegularProgressCommand(c));
        const finalFlush = client.calls.find((c) => isFinalProgressCommand(c));
        expect(hsets.length).toBe(1);
        expect(finalFlush).toBeDefined();

        // EVAL <script> 2 <active-key> <terminal-key> <field> <value> …
        const argsMap: Record<string, string> = {};
        for (let i = 3 + Number(finalFlush?.[2]); i + 1 < (finalFlush?.length ?? 0) - 4; i += 2) {
            argsMap[finalFlush![i]] = finalFlush![i + 1];
        }
        // The final buffered value (1000/1000) must have been flushed, not
        // lost — this is the exact regression this test guards against.
        expect(argsMap['stage:main:processed']).toBe('1000');
        expect(argsMap['stage:main:total']).toBe('1000');

        // Advancing time afterward must not produce a further flush — the
        // pendingTimer was cancelled and the tracker state was deleted.
        await vi.advanceTimersByTimeAsync(1_000);
        await Promise.resolve();
        expect(client.calls.filter((c) => isRegularProgressCommand(c)).length).toBe(1);
        expect(client.calls.filter((c) => isFinalProgressCommand(c)).length).toBe(1);
    });

    it('does not recreate an active hash when the terminal transition already removed it', async () => {
        const client = {
            calls: [] as Cmd[],
            customCommand: async (cmd: Cmd) => {
                client.calls.push(cmd);
                // The guarded terminal flush observes no `state` field.
                if (isFinalProgressCommand(cmd)) return 0;
                return 'OK';
            },
        };
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_terminal');

        report(1, 1);
        await Promise.resolve();
        tracker.finalize('run_terminal');
        await Promise.resolve();

        expect(client.calls.filter((c) => isFinalProgressCommand(c))).toHaveLength(1);
    });

    it('finalize flush failure is caught and does not throw or leave an unhandled rejection', async () => {
        const client = {
            customCommand: async () => {
                throw new Error('valkey down');
            },
        };
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const report = tracker.create('run_finfail');
        report(1);
        await Promise.resolve();
        report(2); // buffered, pendingTimer set

        expect(() => tracker.finalize('run_finfail')).not.toThrow();
        // Let the fire-and-forget flush's rejection be caught.
        await Promise.resolve();
        await Promise.resolve();
    });
});

// ── no client ─────────────────────────────────────────────────────────────────

describe('ProgressTracker no client', () => {
    it('does not throw when Valkey client is null', async () => {
        const tracker = new ProgressTracker(() => null);
        const report = tracker.create('run_nc');
        expect(() => report(1, 10)).not.toThrow();
        await Promise.resolve();
        tracker.finalize('run_nc');
    });
});

describe('ProgressTracker authority capture', () => {
    it('retains the original token through delayed and final progress', async () => {
        vi.useFakeTimers();
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client, 250, 30_000);
        const originalOwner = randomUUID();
        const authority = { partition: 'tasks', generation: '1', ownerId: originalOwner };
        const report = tracker.create('captured', 'main', authority);
        report(1, 2);
        authority.generation = '2';
        authority.ownerId = randomUUID();
        report(2, 2);
        await vi.advanceTimersByTimeAsync(250);
        tracker.finalize('captured', {
            partition: 'tasks',
            generation: '1',
            ownerId: originalOwner,
        });
        for (const command of client.calls) {
            expect(command.slice(-4)).toEqual(['tasks', '1', originalOwner, '1']);
        }
        vi.useRealTimers();
    });

    it('an old callback cannot update a replacement tracker for the same run', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client);
        const oldReport = tracker.create('replaced');
        tracker.create('replaced');
        const count = client.calls.length;
        oldReport(999, 999);
        await Promise.resolve();
        expect(client.calls).toHaveLength(count);
        tracker.finalize('replaced');
    });
});

describe('ProgressTracker delayed finalize', () => {
    it('an old generation cannot flush or remove a replacement tracker', async () => {
        const client = makeFakeClient();
        const tracker = new ProgressTracker(() => client);
        const original = { partition: 'tasks', generation: '1', ownerId: randomUUID() };
        const next = { partition: 'tasks', generation: '2', ownerId: randomUUID() };
        tracker.create('handoff', 'main', original);
        const report = tracker.create('handoff', 'main', next);
        const count = client.calls.length;
        tracker.finalize('handoff', original);
        tracker.finalize('handoff');
        expect(client.calls).toHaveLength(count);
        report(2, 2);
        expect(client.calls.at(-1)?.slice(-4)).toEqual(['tasks', '2', next.ownerId, '1']);
        tracker.finalize('handoff', next);
    });
});

describe('ProgressTracker bound publication', () => {
    it('fences the cache publication with the original token and includes it in diagnostics', async () => {
        const coordination = makeFakeClient();
        const publisher = makeFakeClient();
        const authority = { partition: 'tasks', generation: '1', ownerId: randomUUID() };
        const tracker = new ProgressTracker(
            () => coordination,
            250,
            30_000,
            () => publisher,
        );
        const report = tracker.create('published', 'main', authority);
        report(2, 3);
        await vi.waitFor(() => expect(publisher.calls).toHaveLength(1));
        const command = publisher.calls[0];
        expect(command[0]).toBe('EVALSHA');
        expect(command.slice(-4)).toEqual(['tasks', '1', authority.ownerId, '1']);
        const argvStart = 3 + Number(command[2]);
        expect(command[argvStart]).toBe('task:events:progress');
        expect(JSON.parse(command[argvStart + 1])).toMatchObject({
            authority,
            processed: 2,
            total: 3,
        });
        tracker.finalize('published', authority);
    });

    it('also fences unmanaged publication and preserves the ordinary payload', async () => {
        const coordination = makeFakeClient();
        const publisher = makeFakeClient();
        const tracker = new ProgressTracker(
            () => coordination,
            250,
            30_000,
            () => publisher,
        );
        tracker.create('unmanaged-published')(4, 5);
        await vi.waitFor(() => expect(publisher.calls).toHaveLength(1));
        const command = publisher.calls[0];
        expect(command.slice(-4)).toEqual(['', '', '', '1']);
        const payload = JSON.parse(command[4 + Number(command[2])]);
        expect(payload).toMatchObject({ runId: 'unmanaged-published', processed: 4, total: 5 });
        expect(payload).not.toHaveProperty('authority');
        tracker.finalize('unmanaged-published');
    });

    it('does not publish through the legacy fallback if the bound cache client is missing', async () => {
        const { publishMessage } = await import('$lib/server/cache/valkey.js');
        const before = vi.mocked(publishMessage).mock.calls.length;
        const coordination = makeFakeClient();
        const authority = { partition: 'tasks', generation: '1', ownerId: randomUUID() };
        const tracker = new ProgressTracker(
            () => coordination,
            250,
            30_000,
            () => null,
        );
        tracker.create('missing-cache', 'main', authority)(1, 1);
        await Promise.resolve();
        await Promise.resolve();
        expect(vi.mocked(publishMessage).mock.calls).toHaveLength(before);
        tracker.finalize('missing-cache', authority);
    });
});
