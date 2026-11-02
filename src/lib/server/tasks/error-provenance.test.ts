// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the run-wrapper writes into `last_error` when a stage fails.
 *
 * The point of these tests is not that a failure is recorded — it always was —
 * but that the recorded row can answer WHY it was classified the way it was.
 * Before this, the verdict was collapsed to a boolean and the deciding rule was
 * discarded, so a misclassification was invisible after the fact: a 429 burst
 * during a first scan turned every headline health metric red because 429 fell
 * through the classifier chain to the default and was written off as permanent,
 * and nothing on the row said "no rule matched this".
 */

import { describe, it, expect, vi } from 'vitest';
import { wrapExecute } from './run-wrapper.js';
import type { StageErrorDetail } from '$lib/types/pipeline.js';

// This suite isolates error classification; real ownership transactions are
// covered by existing-write.integration.test.ts.
// Unit queue adapters execute their in-memory RPC directly. The durable journal
// and actual BullMQ API are exercised together in queue-write.integration.test.
vi.mock('../../../task-runtime/authority/queue-write.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../task-runtime/authority/queue-write.js')>()),
    withTaskQueueWrite: async (
        _sql: unknown,
        _authority: unknown,
        _operation: unknown,
        write: () => Promise<unknown>,
    ) => write(),
}));
vi.mock('../../../task-runtime/authority/existing-write.js', () => ({
    withExistingTaskWrite: async <T>(
        sql: unknown,
        _authority: unknown,
        mutate: (sql: unknown) => Promise<T>,
    ): Promise<T> => mutate(sql),
}));

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));

const captured: StageErrorDetail[] = [];

vi.mock('$lib/server/database/queries/stage-state.queries.js', () => ({
    upsertRunningRow: vi.fn().mockResolvedValue({ attempt: 0 }),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    resetRunningToPending: vi.fn().mockResolvedValue({ count: 1, declines: 1 }),
    markFailedTransient: vi.fn(async (_sql: unknown, input: { error: StageErrorDetail }) => {
        captured.push(input.error);
    }),
    markFailedPermanent: vi.fn(async (_sql: unknown, input: { error: StageErrorDetail }) => {
        captured.push(input.error);
    }),
}));

async function failWith(
    err: unknown,
    classify?: (e: Error) => 'transient' | 'permanent' | 'fatal',
): Promise<StageErrorDetail> {
    captured.length = 0;
    await expect(
        wrapExecute({
            sql: {} as never,
            stageId: 'test-stage',
            pluginId: 'test-task',
            mediaItemId: '00000000-0000-0000-0000-000000000001',
            runId: 'run-1',
            processingVersion: 1,
            currentAttempt: 1,
            classify,
            inner: async () => {
                throw err;
            },
        }),
    ).rejects.toBeTruthy();
    expect(captured).toHaveLength(1);
    return captured[0];
}

function taskError(kind: 'transient' | 'permanent' | 'fatal', message = 'boom'): Error {
    const e = new Error(message) as Error & { name: string; kind: string };
    e.name = 'TaskError';
    e.kind = kind;
    return e;
}

describe('stage failure provenance', () => {
    it('records a TaskError kind verbatim, including fatal — which `retryable` cannot express', async () => {
        // permanent and fatal both collapse to retryable:false. Grouping dead
        // letters by verdict needs them kept apart.
        // Sequential, not Promise.all: the capture array is shared module state.
        const permanent = await failWith(taskError('permanent'));
        expect(permanent.kind).toBe('permanent');
        expect(permanent.decidedBy).toBe('task-error-kind');

        const fatal = await failWith(taskError('fatal'));
        expect(fatal.kind).toBe('fatal');
        expect(fatal.decidedBy).toBe('task-error-kind');
    });

    it('records the classifier as the decider when a rule matched', async () => {
        const d = await failWith(new Error('tmdb 404'), () => 'permanent');
        expect(d.kind).toBe('permanent');
        expect(d.decidedBy).toBe('classifier');
        expect(d.retryable).toBe(false);
    });

    /**
     * The 429 case. With no classifier, everything falls to the default — and
     * the whole value of `decidedBy` is that the row now SAYS so, instead of
     * looking identical to a rule that deliberately chose this verdict.
     */
    it('marks a fallthrough as `default`, distinguishable from a deliberate rule', async () => {
        const d = await failWith(new Error('429 Too Many Requests'));
        expect(d.decidedBy).toBe('default');
        expect(d.kind).toBe('transient');
    });

    it('records a classifier that threw, rather than silently reporting permanent', async () => {
        const d = await failWith(new Error('boom'), () => {
            throw new Error('bad rule');
        });
        expect(d.decidedBy).toBe('classifier-threw');
        expect(d.kind).toBe('permanent');
    });

    it('keeps the upstream HTTP status, spelled any of the three ways it arrives', async () => {
        const withStatus = Object.assign(new Error('rate limited'), { status: 429 });
        expect((await failWith(withStatus)).status).toBe(429);

        const withStatusCode = Object.assign(new Error('not found'), { statusCode: 404 });
        expect((await failWith(withStatusCode)).status).toBe(404);

        const withResponse = Object.assign(new Error('server error'), {
            response: { status: 503 },
        });
        expect((await failWith(withResponse)).status).toBe(503);
    });

    it('omits status entirely rather than inventing one', async () => {
        const d = await failWith(new Error('socket hang up'));
        expect(d.status).toBeUndefined();
        expect('status' in d).toBe(false);
    });

    it('ignores a nonsense status rather than storing it', async () => {
        // A vendor SDK putting a non-HTTP number on `.status` must not become a
        // fake status code that later grouping treats as real.
        const bogus = Object.assign(new Error('x'), { status: 7 });
        expect((await failWith(bogus)).status).toBeUndefined();
    });
});
