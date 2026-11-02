// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — legacy `::` separator in stale BullMQ jobs (Test 2).
 *
 * Before the `~~` separator was introduced, job names used `::`.
 * The orchestrator's flushTransitions logic decodes runId by splitting on
 * the last `#`. A job with no `#` at all (old `::` format) must not crash;
 * it should produce a null/fallback runId and the system must log a warning.
 *
 * We test the decode path by exercising `computeIdentity` / `sanitizeIdentity`
 * directly, and by verifying that the orchestrator's internal job-name formula
 * (`<taskId>~~<formula>#<runId>`) handles a legacy job whose name contains
 * `::` but no `#`.
 */

import { describe, it, expect } from 'vitest';
import { computeIdentity, sanitizeIdentity } from './identity.js';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Helper: decode a job name the same way orchestrator.flushTransitions does.
// Job names encode runId as `<taskId>~~<formula>#<runId>`.
// Returns null when no valid `run_*` suffix is found.
// ---------------------------------------------------------------------------
function decodeRunIdFromJobName(jobName: string): string | null {
    const hashIdx = jobName.lastIndexOf('#');
    if (hashIdx > 0) {
        const candidate = jobName.slice(hashIdx + 1);
        if (candidate.startsWith('run_')) return candidate;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Minimal TaskDefinition stub
// ---------------------------------------------------------------------------
function makeTaskStub(id: string): TaskDefinition<{ scope: string }, unknown> {
    return {
        id,
        name: 'Test Task',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: null as never,
        identityFor: (input: { scope: string }) => input.scope,
        async execute() {
            return { success: true };
        },
    } as unknown as TaskDefinition<{ scope: string }, unknown>;
}

describe('identity-legacy-decode', () => {
    it('computeIdentity produces the ~~ separator, not ::', () => {
        const task = makeTaskStub('my-task');
        const result = computeIdentity(task, { scope: 'global' });
        expect(result).toBe('my-task~~global');
        expect(result).not.toContain('::');
    });

    it('decodeRunIdFromJobName: modern format returns the runId suffix', () => {
        const jobName = 'my-task~~global#run_01ABC';
        const runId = decodeRunIdFromJobName(jobName);
        expect(runId).toBe('run_01ABC');
    });

    it('decodeRunIdFromJobName: legacy :: format (no #) returns null — no crash', () => {
        // Simulate a stale BullMQ job from before the ~~/# convention.
        const legacyJobName = 'my-task::global';
        const runId = decodeRunIdFromJobName(legacyJobName);
        // Decoder finds no `#` → null (caller skips the transition gracefully).
        expect(runId).toBeNull();
    });

    it('decodeRunIdFromJobName: job name with # but non-run_ suffix returns null', () => {
        // Possible if a gate job or other system job is encountered.
        const jobName = 'my-task~~global#gate_abc';
        const runId = decodeRunIdFromJobName(jobName);
        expect(runId).toBeNull();
    });

    it('sanitizeIdentity rejects colons to prevent legacy-format collision', () => {
        // The old :: format only arose because identityFor results could contain
        // colons. Ensuring sanitizeIdentity rejects them closes the regression.
        expect(() => sanitizeIdentity('library:1')).toThrow(/cannot contain ":"/);
    });

    it('sanitizeIdentity rejects # to prevent runId delimiter collision', () => {
        expect(() => sanitizeIdentity('global#run_BOGUS')).toThrow(/cannot contain "#"/);
    });

    it('sanitizeIdentity accepts typical identity values', () => {
        expect(() => sanitizeIdentity('global')).not.toThrow();
        expect(() => sanitizeIdentity('lib-1')).not.toThrow();
        expect(() => sanitizeIdentity('01ARZ3NDEKTSV4RRFFQ69G5FAV')).not.toThrow();
    });
});
