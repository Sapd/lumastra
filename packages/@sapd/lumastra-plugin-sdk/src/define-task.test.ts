// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

/**
 * `defineTask` must reject everything the HOST's registry would reject.
 *
 * The registry's `validateAt('startup'|'reload')` sweeps every task at once and
 * throws — so a field the SDK accepts but the registry refuses turns one
 * plugin's mistake into a failure of that whole sweep, reported against the
 * registry pass rather than against the plugin that caused it. Per-plugin
 * validation at load is the entire point of running the SDK's validators in the
 * loader, and it only holds while the two agree.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTask } from './define-task.js';

const base = {
    id: 'my-task',
    name: 'My Task',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'maintenance' as const,
    inputSchema: z.object({}),
    identityFor: () => 'global',
    execute: async () => ({ success: true, itemsProcessed: 0 }),
};

describe('processingVersion', () => {
    it('accepts a positive integer', () => {
        expect(() => defineTask({ ...base } as never)).not.toThrow();
    });

    it('rejects it missing — the registry would throw for the whole sweep later', () => {
        const { processingVersion: _drop, ...without } = base;
        expect(() => defineTask(without as never)).toThrow(/processingVersion/);
    });

    it('rejects zero and negatives', () => {
        expect(() => defineTask({ ...base, processingVersion: 0 } as never)).toThrow(
            /processingVersion/,
        );
        expect(() => defineTask({ ...base, processingVersion: -1 } as never)).toThrow(
            /processingVersion/,
        );
    });

    it('rejects a non-integer', () => {
        expect(() => defineTask({ ...base, processingVersion: 1.5 } as never)).toThrow(
            /processingVersion/,
        );
    });

    it('names the task, so an operator knows which plugin to fix', () => {
        const { processingVersion: _drop, ...without } = base;
        expect(() => defineTask(without as never)).toThrow(/my-task/);
    });
});

describe('visibility', () => {
    it('accepts user and system, and defaults to nothing', () => {
        expect(() => defineTask({ ...base } as never)).not.toThrow();
        expect(() => defineTask({ ...base, visibility: 'user' } as never)).not.toThrow();
        expect(() => defineTask({ ...base, visibility: 'system' } as never)).not.toThrow();
    });

    it('rejects a typo instead of silently listing the task', () => {
        expect(() => defineTask({ ...base, visibility: 'systme' } as never)).toThrow(
            /visibility must be 'user' or 'system'/,
        );
    });
});
