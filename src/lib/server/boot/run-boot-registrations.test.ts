// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { runBootRegistrations } from './run-boot-registrations.js';

describe('runBootRegistrations', () => {
    it('waits for the migration, then loads the registrations once', async () => {
        const order: string[] = [];
        await runBootRegistrations({
            migrate: async () => void order.push('migrate'),
            loadCompat: async () => void order.push('load'),
            warn: vi.fn(),
        });
        expect(order).toEqual(['migrate', 'load']);
    });

    it('loads the registrations even when the migration rejects, and says so', async () => {
        const loadCompat = vi.fn(async () => undefined);
        const warn = vi.fn();
        await runBootRegistrations({
            migrate: async () => {
                throw new Error('db down');
            },
            loadCompat,
            warn,
        });
        expect(loadCompat).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![1].error)).toContain('db down');
    });

    it('never rejects, even when the loader does', async () => {
        const warn = vi.fn();
        await expect(
            runBootRegistrations({
                migrate: async () => undefined,
                loadCompat: async () => {
                    throw new Error('load broke');
                },
                warn,
            }),
        ).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
