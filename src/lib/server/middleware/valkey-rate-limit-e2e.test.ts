// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    dev: false,
    multiplier: '100',
    valkey: false,
    counters: new Map<string, number>(),
    keyIndex: 0,
}));
vi.mock('$app/environment', () => ({
    get dev() {
        return state.dev;
    },
}));
vi.mock('$env/dynamic/private', () => ({
    env: {
        get LUMASTRA_E2E_RATE_LIMIT_MULTIPLIER() {
            return state.multiplier;
        },
    },
}));
vi.mock('$lib/server/cache/valkey', () => ({
    getCoordinationClient: () =>
        state.valkey
            ? {
                  incr: async (key: string) => {
                      const count = (state.counters.get(key) ?? 0) + 1;
                      state.counters.set(key, count);
                      return count;
                  },
                  customCommand: vi.fn(),
              }
            : null,
    isCoordinationValkeyReady: () => state.valkey,
    connectValkey: vi.fn(),
    getKeysByPattern: vi.fn(),
    cacheGet: vi.fn(),
    del: vi.fn(),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) },
}));
import { checkRateLimit } from './valkey-rate-limit';

beforeEach(() => {
    state.dev = false;
    state.multiplier = '100';
    state.counters.clear();
});

describe.each([false, true])('E2E budgets (Valkey: %s)', (valkey) => {
    beforeEach(() => {
        state.valkey = valkey;
    });
    it('cannot raise production budgets even when the E2E variable is set', async () => {
        const key = `prod-${state.keyIndex++}`;
        expect((await checkRateLimit(key, 1, 60)).allowed).toBe(true);
        expect(await checkRateLimit(key, 1, 60)).toMatchObject({ allowed: false, total: 1 });
    });
    it('raises only the explicitly configured development budget', async () => {
        const key = `e2e-${state.keyIndex++}`;
        state.dev = true;
        state.multiplier = '2';
        expect((await checkRateLimit(key, 1, 60)).allowed).toBe(true);
        expect((await checkRateLimit(key, 1, 60)).allowed).toBe(true);
        expect(await checkRateLimit(key, 1, 60)).toMatchObject({ allowed: false, total: 2 });
    });
    it.each(['0', '-1', '1.5', 'NaN', '101'])('ignores invalid multiplier %s', async (value) => {
        const key = `invalid-${state.keyIndex++}`;
        state.dev = true;
        state.multiplier = value;
        expect((await checkRateLimit(key, 1, 60)).allowed).toBe(true);
        expect(await checkRateLimit(key, 1, 60)).toMatchObject({ allowed: false, total: 1 });
    });
});
