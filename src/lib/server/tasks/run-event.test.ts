// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { RunEventSchema } from '@sapd/lumastra-plugin-sdk';
import { toRunEvent, toPublicRun } from './run-event.js';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const baseRun: Run = {
    id: 'run-1',
    taskId: 'trickplay-generation',
    label: 'Trickplay',
    state: 'failed',
    input: { mediaItemId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secret: 'x' },
    // `subjectType`/`subjectId` are added to the SDK scope object by a later
    // task; the projection must pass the scope through verbatim regardless, so
    // the fixture asserts on the shape that will land there.
    scope: {
        subjectType: 'mediaItem',
        subjectId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    } as Run['scope'],
    trigger: { kind: 'manual' },
    startedAt: '2026-08-18T10:00:00.000Z',
    executionStartedAt: '2026-08-18T10:00:03.000Z',
    completedAt: '2026-08-18T10:05:00.000Z',
    stages: [],
    result: { hugePayload: 'y'.repeat(1000) },
    error: { message: 'boom', kind: 'permanent', stack: '/srv/app/secret/path.ts:12' },
    actor: { type: 'user' },
};

function subjectIdOf(scope: unknown): string | undefined {
    return (scope as { subjectId?: string } | undefined)?.subjectId;
}

describe('toRunEvent', () => {
    it('omits result, error.stack and input', () => {
        const ev = toRunEvent(baseRun);
        expect(ev).not.toHaveProperty('result');
        expect(ev).not.toHaveProperty('input');
        expect(ev.error).toEqual({ message: 'boom', kind: 'permanent' });
    });

    it('preserves the fields the client needs, including scope', () => {
        const ev = toRunEvent(baseRun);
        expect(ev.id).toBe('run-1');
        expect(ev.state).toBe('failed');
        expect(subjectIdOf(ev.scope)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
        expect(ev.completedAt).toBe('2026-08-18T10:05:00.000Z');
        expect(ev.executionStartedAt).toBe('2026-08-18T10:00:03.000Z');
    });

    it('produces a value that RunEventSchema accepts', () => {
        expect(RunEventSchema.safeParse(toRunEvent(baseRun)).success).toBe(true);
    });

    it('handles a run with no error', () => {
        const ev = toRunEvent({ ...baseRun, state: 'completed', error: undefined });
        expect(ev.error).toBeUndefined();
    });
});

describe('bounded run count projection', () => {
    const previewResult = {
        success: false,
        itemsProcessed: 663,
        stopReason: 'budget',
        result: {
            generated: 663,
            countUnit: 'frames',
            sourcesRemaining: 1,
            skipped: 4,
        },
    };

    it('exposes the same validated frame summary through REST and the redacted event', () => {
        const run = {
            ...baseRun,
            state: 'completed' as const,
            error: undefined,
            result: previewResult,
        };
        const rest = toPublicRun(run);
        const event = toRunEvent(run);

        expect(rest.countSummary).toEqual({
            count: 663,
            unit: 'frames',
            continuation: { kind: 'source-check', remainingSources: 1 },
        });
        expect(event.countSummary).toEqual(rest.countSummary);
        expect(event).not.toHaveProperty('result');
        expect(RunEventSchema.safeParse(event).success).toBe(true);
    });

    it.each([
        {
            ...previewResult,
            result: { generated: 663, countUnit: 'untrusted', sourcesRemaining: 1 },
        },
        {
            ...previewResult,
            itemsProcessed: Number.MAX_SAFE_INTEGER + 1,
        },
    ])('does not infer continuation or frames from malformed/foreign evidence', (result) => {
        expect(toPublicRun({ ...baseRun, result }).countSummary).toBeUndefined();
    });

    it.each([
        { ...previewResult, stopReason: undefined },
        {
            ...previewResult,
            result: { generated: 663, countUnit: 'frames', sourcesRemaining: 1.5 },
        },
    ])('does not claim continuation without an explicit validated budget reason', (result) => {
        expect(toPublicRun({ ...baseRun, result }).countSummary).toEqual({
            count: 663,
            unit: 'frames',
        });
    });

    it('keeps a validated zero-frame result without claiming continuation', () => {
        const result = {
            success: false,
            itemsProcessed: 0,
            stopReason: 'aborted',
            result: { generated: 0, countUnit: 'frames', sourcesRemaining: 1 },
        };
        expect(toPublicRun({ ...baseRun, result }).countSummary).toEqual({
            count: 0,
            unit: 'frames',
        });
    });

    it.each(['failed', 'cancelled'] as const)(
        'does not claim continuation for an outer %s run',
        (state) => {
            const run = toPublicRun({
                ...baseRun,
                state,
                error: undefined,
                result: previewResult,
            });
            expect(run.countSummary).toEqual({ count: 663, unit: 'frames' });
        },
    );
});

const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const privateText = '/private/library/secret.mkv ffmpeg password=sentinel';
const recheck = { fileId: FILE, outcome: 'healthy', issues: [] };
const nativeResult = (value: unknown = recheck) => ({
    success: true,
    itemsProcessed: 1,
    result: { probed: 0, keyframed: 0, errors: 0, missing: 0, recheck: value },
});
const selectedRun = (result: unknown = nativeResult()): Run => ({
    ...baseRun,
    taskId: 'media-probe',
    state: 'completed',
    input: { fileId: FILE },
    result,
    error: undefined,
});

describe('selected native result projection', () => {
    it.each([
        [1, { ...recheck }],
        [
            1,
            {
                ...recheck,
                outcome: 'warning',
                issues: [{ type: 'video_ends_early' }],
                reason: 'warnings_remain',
            },
        ],
        [0, { ...recheck, outcome: 'busy' }],
        [0, { ...recheck, outcome: 'inconclusive', reason: 'disabled' }],
        [
            1,
            {
                ...recheck,
                outcome: 'inconclusive',
                reason: 'inconclusive',
                issues: [{ type: 'video_ends_early' }],
            },
        ],
        [1, { ...recheck, outcome: 'error', reason: 'probe_failed' }],
        // A file disappearing between retry and snapshot can yield error without a reason.
        [1, { ...recheck, outcome: 'error' }],
    ] as const)(
        'projects actual native count/outcome combinations: %j %j',
        (itemsProcessed, result) => {
            expect(
                toPublicRun(selectedRun({ ...nativeResult(result), itemsProcessed })).result,
            ).toEqual({ recheck: result });
        },
    );

    it.each([
        [0, 'warning', 'warnings_remain', [{ type: 'video_ends_early' }]],
        [1, 'warning', 'warnings_remain', []],
        [1, 'warning', undefined, [{ type: 'video_ends_early' }]],
        [1, 'warning', 'disabled', [{ type: 'video_ends_early' }]],
        [1, 'warning', 'probe_failed', [{ type: 'video_ends_early' }]],
        [1, 'busy', undefined, []],
        [0, 'busy', 'busy', []],
        [0, 'busy', undefined, [{ type: 'video_ends_early' }]],
        [1, 'inconclusive', 'disabled', []],
        [0, 'inconclusive', 'disabled', [{ type: 'video_ends_early' }]],
        [0, 'inconclusive', 'inconclusive', []],
        [1, 'inconclusive', undefined, []],
        [1, 'error', 'warnings_remain', []],
        [0, 'error', 'probe_failed', []],
        [1, 'cancelled', undefined, []],
        [2, 'healthy', undefined, []],
        [2, 'warning', 'warnings_remain', [{ type: 'video_ends_early' }]],
    ])(
        'rejects contradictory native count/outcome proof: %j %j %j %j',
        (itemsProcessed, outcome, reason, issues) => {
            expect(
                toPublicRun(
                    selectedRun({
                        ...nativeResult({ fileId: FILE, outcome, reason, issues }),
                        itemsProcessed,
                    }),
                ).result,
            ).toBeUndefined();
        },
    );

    it('does not restore a selected-file counter after its native result is rejected', () => {
        const safe = toPublicRun(selectedRun({ ...nativeResult(), itemsProcessed: 2 }));
        expect(safe.result).toBeUndefined();
        expect(safe.countSummary).toBeUndefined();
    });

    it('keeps only the selected UUID and safe enum evidence in REST, and no result in events', () => {
        const run = selectedRun({
            ...nativeResult({
                fileId: FILE,
                outcome: 'warning',
                reason: 'warnings_remain',
                rawReason: privateText,
                issues: [{ type: 'video_ends_early', detail: privateText, path: privateText }],
                nested: { password: privateText },
            }),
            raw: privateText,
        });
        run.input = { fileId: FILE, path: privateText, nested: { secret: privateText } };
        run.error = { message: privateText, stack: privateText, kind: 'permanent' };
        const safe = toPublicRun({ ...run, error: undefined });
        expect(safe.input).toEqual({ fileId: FILE });
        expect(safe.result).toEqual({
            recheck: {
                fileId: FILE,
                outcome: 'warning',
                reason: 'warnings_remain',
                issues: [{ type: 'video_ends_early' }],
            },
        });
        expect(JSON.stringify(toPublicRun(run))).not.toContain(privateText);
        expect(JSON.stringify(toRunEvent(run))).not.toContain(privateText);
        expect(toRunEvent(run)).not.toHaveProperty('result');
        const malformedError = {
            ...run,
            error: { message: privateText, kind: privateText, stack: privateText },
        };
        expect(JSON.stringify(toPublicRun(malformedError))).not.toContain(privateText);
        expect(JSON.stringify(toRunEvent(malformedError as Run))).not.toContain(privateText);
        expect(run.input).toHaveProperty('path');
    });

    it.each([
        null,
        privateText,
        { recheck },
        { success: false, itemsProcessed: 1, result: { recheck } },
        { success: true, result: { recheck } },
        { success: true, itemsProcessed: 1, result: {} },
        nativeResult({ ...recheck, fileId: OTHER }),
        nativeResult({ ...recheck, outcome: 'future' }),
        nativeResult({ ...recheck, issues: [{ type: privateText }] }),
        nativeResult({ ...recheck, reason: 'inconclusive' }),
        { ...nativeResult(), itemsProcessed: 0 },
        { ...nativeResult(), itemsProcessed: -1 },
        nativeResult({ ...recheck, issues: [{ type: 'video_ends_early' }] }),
        { ...nativeResult(), stopReason: 'aborted' },
    ])('fails closed for malformed, mismatched or unfinished proof: %j', (result) => {
        expect(toPublicRun(selectedRun(result)).result).toBeUndefined();
    });

    it.each(['pending', 'active', 'cancelling', 'failed', 'cancelled'] as const)(
        'does not publish healthy proof on a %s outer run',
        (state) => {
            expect(toPublicRun({ ...selectedRun(), state }).result).toBeUndefined();
        },
    );

    it('rejects invalid selected UUIDs and preserves broad and unrelated task results verbatim', () => {
        expect(
            toPublicRun({ ...selectedRun(), input: { fileId: privateText } }).result,
        ).toBeUndefined();
        const broad = { ...selectedRun(), input: {} };
        expect(toPublicRun(broad).result).toBe(broad.result);
        expect(toPublicRun(baseRun).result).toBe(baseRun.result);
    });
});

it.each(['media-probe', 'background-task'])(
    'preserves completed broad native success:false for %s without unwrapping',
    (taskId) => {
        const result = {
            success: false,
            itemsProcessed: 71,
            result: { seasonsProcessed: 6, segmentsProduced: 71 },
        };
        expect(
            toPublicRun({
                ...baseRun,
                taskId,
                state: 'completed',
                input: {},
                error: undefined,
                result,
            }).result,
        ).toBe(result);
    },
);
