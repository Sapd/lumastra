// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../registry.js';
import { loadBuiltins, _resetLoadedForTests } from './index.js';

afterEach(() => {
    vi.restoreAllMocks();
    _resetLoadedForTests();
});

describe('builtin startup outcome', () => {
    it('retains a validation failure after real registration instead of silently accepting a retry', async () => {
        const failure = new Error('invalid builtin pipeline');
        const validate = vi.spyOn(registry, 'validateAt').mockImplementationOnce(() => {
            throw failure;
        });
        const starting = loadBuiltins();
        expect(loadBuiltins()).toBe(starting);
        await expect(starting).rejects.toBe(failure);
        expect(registry.getAllTasks().length).toBeGreaterThan(0);
        expect(validate).toHaveBeenCalledExactlyOnceWith('startup');

        // The one-shot validation throw is now exhausted: replaying the body
        // would succeed, as would returning early from an eagerly set loaded flag.
        expect(loadBuiltins()).toBe(starting);
        await expect(loadBuiltins()).rejects.toBe(failure);
        expect(validate).toHaveBeenCalledTimes(1);
    }, 60_000);

    it('shares a successful completed boot without revalidating or registering again', async () => {
        const validate = vi.spyOn(registry, 'validateAt');
        const starting = loadBuiltins();
        expect(loadBuiltins()).toBe(starting);
        await starting;
        expect(loadBuiltins()).toBe(starting);
        await loadBuiltins();
        expect(validate).toHaveBeenCalledExactlyOnceWith('startup');
    }, 60_000);
});
