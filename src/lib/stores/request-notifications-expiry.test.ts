// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * REQUEST_AVAILABLE_EXPIRE_HOURS decides how long an "available" request card
 * stays. Until 2026-10-06 the store used a literal 24 and the admin setting
 * did nothing. It now arrives through client-tuning, and the store applies it
 * both when it loads from localStorage and on every poll, because its first
 * load runs at import time, before the root layout has hydrated the tuning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true }));

vi.mock('$lib/api/content', () => ({
    dismissRequest: vi.fn(),
    getPendingRequests: vi.fn(),
    checkRequestStatuses: vi.fn(),
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { warning: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

const memoryStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryStorage.set(key, value),
    removeItem: (key: string) => void memoryStorage.delete(key),
    clear: () => memoryStorage.clear(),
});

const NOW = Date.parse('2026-10-06T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const STORAGE_KEY = 'dashboard-request-notifications-leon';

/** Persist one "available" card that was first shown `ageHours` ago. */
function seedAvailableCard(ageHours: number): void {
    memoryStorage.set(
        STORAGE_KEY,
        JSON.stringify({
            version: 8,
            lastPoll: 0,
            notifications: [
                {
                    id: 'tmdb:550:movie',
                    externalIds: { tmdb: '550' },
                    mediaType: 'movie',
                    title: 'Quiet Orbit',
                    status: 'available',
                    createdAt: NOW - 48 * HOUR,
                    shownAt: NOW - ageHours * HOUR,
                },
            ],
        }),
    );
}

function storedCount(): number {
    const raw = memoryStorage.get(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { notifications: unknown[] }).notifications.length : 0;
}

/** Fresh module graph, so the store and client-tuning share one instance. */
async function load() {
    vi.resetModules();
    const store = await import('./request-notifications.js');
    const tuning = await import('./client-tuning.js');
    return { ...store, ...tuning };
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    memoryStorage.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('REQUEST_AVAILABLE_EXPIRE_HOURS', () => {
    it('keeps a 3-hour-old available card under the shipped 24 h default', async () => {
        seedAvailableCard(3);
        const { requestNotifications } = await load();
        requestNotifications.setUser('leon');

        await requestNotifications.poll();

        expect(get(requestNotifications).notifications).toHaveLength(1);
    });

    it('drops the card on load when the server sets a shorter expiry', async () => {
        seedAvailableCard(3);
        const { requestNotifications, hydrateClientTuning } = await load();
        hydrateClientTuning({ requestAvailableExpireHours: 2 });

        requestNotifications.setUser('leon');

        expect(get(requestNotifications).notifications).toEqual([]);
    });

    it('drops it on the next poll when the tuning arrives after the load', async () => {
        seedAvailableCard(3);
        const { requestNotifications, hydrateClientTuning } = await load();
        requestNotifications.setUser('leon');
        expect(get(requestNotifications).notifications).toHaveLength(1);

        hydrateClientTuning({ requestAvailableExpireHours: 2 });
        await requestNotifications.poll();

        expect(get(requestNotifications).notifications).toEqual([]);
        expect(storedCount()).toBe(0);
    });

    it('keeps the card longer than 24 h when the server allows it', async () => {
        seedAvailableCard(30);
        const { requestNotifications, hydrateClientTuning } = await load();
        hydrateClientTuning({ requestAvailableExpireHours: 72 });

        requestNotifications.setUser('leon');
        await requestNotifications.poll();

        expect(get(requestNotifications).notifications).toHaveLength(1);
    });
});
