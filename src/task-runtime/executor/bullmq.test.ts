// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { DelayedError, UnrecoverableError, WaitingChildrenError } from 'bullmq';
import { executionFailureOutcome } from './bullmq.js';
import { AuthorityError } from '../authority/store.js';

describe('executor queue-control exception translation only', () => {
    it.each([
        [new WaitingChildrenError(), 'waiting_children'],
        [new DelayedError(), 'delayed'],
        [new UnrecoverableError('private plugin diagnostic'), 'unrecoverable'],
        [new Error('private plugin diagnostic'), 'failed'],
        [new AuthorityError('stale_authority'), 'unknown'],
        [new AuthorityError('draining'), 'unknown'],
        [new Error('TASK_AUTHORITY_EXPIRED'), 'unknown'],
    ] as const)('preserves %s without leaking plugin error details', (error, status) => {
        expect(executionFailureOutcome(error, false)).toEqual({ status });
        expect(executionFailureOutcome(error, true)).toEqual({ status: 'unknown' });
    });
});
