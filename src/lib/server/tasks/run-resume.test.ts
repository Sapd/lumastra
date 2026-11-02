// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

// Echo the catalogue key so the sync test below names the entry it hit.
vi.mock('$lib/paraglide/messages.js', () => {
    const mod: Record<string, (args?: Record<string, string>) => string> = {};
    for (const key of [
        'admin_run_error_resumed',
        'admin_run_error_resume_exhausted',
        'admin_run_error_resume_crash_loop',
        'admin_run_error_resume_crashed',
        'admin_run_error_resume_failed',
        'admin_run_error_orphaned',
    ]) {
        mod[key] = (args) => (args ? `${key}:${Object.values(args).join('/')}` : key);
        mod[`${key}_hint`] = () => `${key}_hint`;
    }
    return mod;
});
import {
    buildRunCheckpoint,
    CHECKPOINT_MAX_BYTES,
    checkpointKey,
    decideResume,
    isResumableRun,
    readResumeInfo,
    resumeErrorMessage,
    resumeStartFailedMessage,
    RESUME_CRASH_LOOP_WINDOW_MS,
    RESUME_MAX,
    type ResumeDecisionInput,
} from './run-resume.js';
import { explainRunError } from '$lib/utils/admin/run-error-display.js';

const NOW = new Date('2026-10-06T12:00:00Z');
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000);

function input(over: Partial<ResumeDecisionInput> = {}): ResumeDecisionInput {
    return {
        task: { resumeAfterRestart: true },
        state: 'active',
        trigger: { kind: 'manual', by: 'denis' },
        cancelRequestedAt: null,
        startedAt: minutesAgo(90),
        gracefulShutdown: true,
        now: NOW,
        ...over,
    };
}

function resumedTrigger(count: number): Record<string, unknown> {
    return {
        kind: 'manual',
        by: 'denis',
        resume: { rootRunId: 'run_root', previousRunId: 'run_prev', count, max: RESUME_MAX },
    };
}

describe('decideResume', () => {
    it('resumes an interrupted manual run of an opted-in task', () => {
        expect(decideResume(input())).toEqual({ outcome: 'resume', previousCount: 0 });
    });

    it('leaves tasks without resumeAfterRestart untouched', () => {
        expect(decideResume(input({ task: {} })).outcome).toBe('not-applicable');
        expect(decideResume(input({ task: { resumeAfterRestart: false } })).outcome).toBe(
            'not-applicable',
        );
        expect(decideResume(input({ task: undefined })).outcome).toBe('not-applicable');
    });

    it.each(['scheduled', 'webhook', 'in-process', 'pipeline-child', 'resume'])(
        'never resumes a %s run',
        (kind) => {
            expect(decideResume(input({ trigger: { kind } })).outcome).toBe('not-applicable');
        },
    );

    it('never resumes a pending run (it never started its work)', () => {
        expect(decideResume(input({ state: 'pending' })).outcome).toBe('not-applicable');
    });

    it('cancel wins: a cancelling run or one with cancel_requested_at is not resumed', () => {
        expect(decideResume(input({ state: 'cancelling' })).outcome).toBe('cancelled');
        expect(decideResume(input({ cancelRequestedAt: minutesAgo(1) })).outcome).toBe('cancelled');
        // Even without a graceful marker, cancel is reported as cancel.
        expect(decideResume(input({ state: 'cancelling', gracefulShutdown: false })).outcome).toBe(
            'cancelled',
        );
    });

    it('does not resume a run whose worker stopped without a graceful shutdown', () => {
        expect(decideResume(input({ gracefulShutdown: false })).outcome).toBe('crashed');
    });

    it(`stops after ${RESUME_MAX} resumes`, () => {
        for (let count = 1; count < RESUME_MAX; count++) {
            expect(decideResume(input({ trigger: resumedTrigger(count) }))).toEqual({
                outcome: 'resume',
                previousCount: count,
            });
        }
        expect(decideResume(input({ trigger: resumedTrigger(RESUME_MAX) }))).toEqual({
            outcome: 'exhausted',
            previousCount: RESUME_MAX,
        });
        // A corrupt / hand-edited count far past the cap is still exhausted.
        expect(decideResume(input({ trigger: resumedTrigger(99) })).outcome).toBe('exhausted');
    });

    it('fails closed on an unreadable resume block (a corrupt count never resets the cap)', () => {
        for (const resume of [
            { rootRunId: 'a', previousRunId: 'b', count: 'x' },
            { rootRunId: 'a', previousRunId: 'b' },
            { count: 0 },
            'garbage',
        ]) {
            expect(
                decideResume(input({ trigger: { kind: 'manual', resume } })).outcome,
                JSON.stringify(resume),
            ).toBe('exhausted');
        }
    });

    it('treats a resumed run interrupted again inside the window as a crash loop', () => {
        const windowMin = RESUME_CRASH_LOOP_WINDOW_MS / 60_000;
        expect(
            decideResume(
                input({ trigger: resumedTrigger(1), startedAt: minutesAgo(windowMin - 1) }),
            ).outcome,
        ).toBe('crash-loop');
        expect(
            decideResume(
                input({ trigger: resumedTrigger(1), startedAt: minutesAgo(windowMin + 1) }),
            ).outcome,
        ).toBe('resume');
    });

    it('measures the window by execution time from the marker, not queue wait', () => {
        const windowMs = RESUME_CRASH_LOOP_WINDOW_MS;
        // Started (enqueued) long ago, but executed only a minute: crash loop.
        expect(
            decideResume(
                input({
                    trigger: resumedTrigger(1),
                    startedAt: minutesAgo(120),
                    executedMs: 60_000,
                }),
            ).outcome,
        ).toBe('crash-loop');
        // Executed past the window: resumed, however recent the enqueue.
        expect(
            decideResume(
                input({
                    trigger: resumedTrigger(1),
                    startedAt: minutesAgo(1),
                    executedMs: windowMs + 1,
                }),
            ).outcome,
        ).toBe('resume');
    });

    it('applies the window only to resumed runs, not the original run', () => {
        expect(decideResume(input({ startedAt: minutesAgo(1) })).outcome).toBe('resume');
    });

    it('exhaustion beats the crash-loop rule (the final message names the limit)', () => {
        expect(
            decideResume(input({ trigger: resumedTrigger(RESUME_MAX), startedAt: minutesAgo(1) }))
                .outcome,
        ).toBe('exhausted');
    });
});

describe('readResumeInfo / isResumableRun', () => {
    it('reads a valid resume block and rejects malformed ones', () => {
        expect(readResumeInfo(resumedTrigger(2))).toEqual({
            rootRunId: 'run_root',
            previousRunId: 'run_prev',
            count: 2,
            max: RESUME_MAX,
        });
        expect(readResumeInfo({ kind: 'manual' })).toBeNull();
        expect(readResumeInfo(null)).toBeNull();
        expect(readResumeInfo({ resume: { rootRunId: 'a', previousRunId: 'b', count: 0 } })).toBe(
            null,
        );
        expect(
            readResumeInfo({ resume: { rootRunId: 'a', previousRunId: 'b', count: '1' } }),
        ).toBeNull();
    });

    it('is resumable only for manual runs of opted-in tasks', () => {
        expect(isResumableRun({ resumeAfterRestart: true }, { kind: 'manual' })).toBe(true);
        expect(isResumableRun({ resumeAfterRestart: true }, { kind: 'scheduled' })).toBe(false);
        expect(isResumableRun({}, { kind: 'manual' })).toBe(false);
    });
});

describe('resume messages', () => {
    it('keeps the orphan prefix for a resumed run (failure counts exclude it)', () => {
        const msg = resumeErrorMessage('resume', { resumedAs: 'run_X', count: 2 });
        // task-failure.fragments.ts: NOT LIKE '%orphan%_at_recovery%'
        expect(msg).toMatch(/orphan.*_at_recovery/);
    });

    it('gives terminal outcomes a plain message that counts as a failure', () => {
        for (const outcome of ['exhausted', 'crash-loop', 'crashed'] as const) {
            expect(resumeErrorMessage(outcome)).not.toMatch(/orphan.*_at_recovery/);
        }
        expect(resumeErrorMessage('exhausted')).toBe(
            `Stopped after ${RESUME_MAX} restarts: resume limit reached`,
        );
    });

    it('every server message is explained by the admin UI (wording stays in sync)', () => {
        const resumed = explainRunError(
            resumeErrorMessage('resume', { resumedAs: 'run_01ABC', count: 2 }),
        );
        expect(resumed?.severity).toBe('expected');
        expect(resumed?.summary).toBe(`admin_run_error_resumed:2/${RESUME_MAX}`);

        for (const msg of [
            resumeErrorMessage('exhausted'),
            resumeErrorMessage('crash-loop'),
            resumeErrorMessage('crashed'),
            resumeStartFailedMessage('quota exceeded'),
        ]) {
            const explained = explainRunError(msg);
            expect(explained?.summary, msg).toMatch(/^admin_run_error_resume_/);
            expect(explained?.severity, msg).toBe('operator');
        }
    });
});

describe('buildRunCheckpoint', () => {
    function fakeClient() {
        const store = new Map<string, string>();
        const customCommand = vi.fn(async (cmd: string[]) => {
            if (cmd[0] === 'SET') {
                store.set(cmd[1], cmd[2]);
                return 'OK';
            }
            if (cmd[0] === 'GET') return store.get(cmd[1]) ?? null;
            return null;
        });
        return { store, client: { customCommand } };
    }
    const logger = { warn: vi.fn() };

    it('round-trips a value under the chain key with a TTL', async () => {
        const { store, client } = fakeClient();
        const cp = buildRunCheckpoint(() => client, 'run_root', logger);
        expect(await cp.load()).toBeNull();
        await cp.save({ cursor: 'seg-9', n: 3 });
        expect(await cp.load()).toEqual({ cursor: 'seg-9', n: 3 });
        expect(store.has(checkpointKey('run_root'))).toBe(true);
        const setCall = client.customCommand.mock.calls.find((c) => c[0][0] === 'SET');
        expect(setCall?.[0].slice(3, 4)).toEqual(['PX']);
    });

    it('refuses oversized values and survives Valkey errors', async () => {
        const { store, client } = fakeClient();
        const cp = buildRunCheckpoint(() => client, 'run_big', logger);
        await cp.save({ blob: 'x'.repeat(CHECKPOINT_MAX_BYTES + 1) });
        expect(store.size).toBe(0);

        const broken = {
            customCommand: vi.fn(async () => {
                throw new Error('valkey down');
            }),
        };
        const cp2 = buildRunCheckpoint(() => broken, 'run_x', logger);
        await expect(cp2.save({ a: 1 })).resolves.toBeUndefined();
        await expect(cp2.load()).resolves.toBeNull();
    });
});
