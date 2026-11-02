// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const environment = vi.hoisted(() => ({ browser: true }));
vi.mock('$app/environment', () => environment);

const key = 'admin:showAdvancedSettings';
let saved: string | null;
const storage = {
    getItem: vi.fn(() => saved),
    setItem: vi.fn((_key: string, value: string) => {
        saved = value;
    }),
};

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    environment.browser = true;
    saved = 'true';
    vi.stubGlobal('localStorage', storage);
});

afterEach(() => vi.unstubAllGlobals());

describe('advanced settings hydration and persistence', () => {
    it('starts false without reading or overwriting the saved preference on import', async () => {
        const { showAdvancedSettings } = await import('./admin-show-advanced.store');
        expect(get(showAdvancedSettings)).toBe(false);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
        expect(saved).toBe('true');
    });

    it.each(['true', 'false', null, 'invalid'])(
        'restores %s only when initialized',
        async (value) => {
            saved = value;
            const { showAdvancedSettings, initializeShowAdvancedSettings } =
                await import('./admin-show-advanced.store');
            initializeShowAdvancedSettings();
            expect(get(showAdvancedSettings)).toBe(value === 'true');
            expect(storage.getItem).toHaveBeenCalledWith(key);
            expect(saved).toBe(value === 'true' ? 'true' : 'false');
        },
    );

    it('persists toggles and initializes only once across consumers', async () => {
        const { showAdvancedSettings, initializeShowAdvancedSettings } =
            await import('./admin-show-advanced.store');
        initializeShowAdvancedSettings();
        showAdvancedSettings.set(false);
        expect(saved).toBe('false');
        initializeShowAdvancedSettings();
        showAdvancedSettings.update((value) => !value);
        expect(saved).toBe('true');
        expect(storage.getItem).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledTimes(3);
    });

    it('does nothing on the server, including when the initializer is called', async () => {
        environment.browser = false;
        const { showAdvancedSettings, initializeShowAdvancedSettings } =
            await import('./admin-show-advanced.store');
        initializeShowAdvancedSettings();
        expect(get(showAdvancedSettings)).toBe(false);
        expect(storage.getItem).not.toHaveBeenCalled();
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('falls back to false when storage reads are blocked', async () => {
        storage.getItem.mockImplementation(() => {
            throw new Error('Storage unavailable');
        });
        const { showAdvancedSettings, initializeShowAdvancedSettings } =
            await import('./admin-show-advanced.store');
        expect(initializeShowAdvancedSettings).not.toThrow();
        expect(get(showAdvancedSettings)).toBe(false);
    });

    it('keeps the in-memory preference working when storage writes fail', async () => {
        storage.setItem.mockImplementation(() => {
            throw new Error('Storage unavailable');
        });
        const { showAdvancedSettings, initializeShowAdvancedSettings } =
            await import('./admin-show-advanced.store');
        expect(initializeShowAdvancedSettings).not.toThrow();
        expect(get(showAdvancedSettings)).toBe(true);
        expect(() => showAdvancedSettings.set(false)).not.toThrow();
        expect(get(showAdvancedSettings)).toBe(false);
    });
});
