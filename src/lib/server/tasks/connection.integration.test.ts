// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Integration test requirements:
//   - CACHE_URL pointing at a Valkey instance.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = Boolean(CACHE_URL);

describe.skipIf(!RUN)('getQueueConnection', () => {
    beforeEach(async () => {
        // Config module caches its exported consts at import time, so tests
        // that need a specific flag value must re-import after setting env.
        // vi.resetModules() + dynamic import is the established pattern for
        // this in this codebase's flag-dependent tests.
    });

    afterEach(() => {
        delete process.env.FEATURE_SHARED_QUEUE_CONNECTION;
        delete process.env.LUMASTRA_LOW_RAM_MODE;
        vi.resetModules();
    });

    it('returns the same IORedis instance on repeated calls when the flag is on', async () => {
        process.env.FEATURE_SHARED_QUEUE_CONNECTION = 'true';
        vi.resetModules();
        const { getQueueConnection, __resetSharedQueueConnectionForTests } =
            await import('./connection.js');
        __resetSharedQueueConnectionForTests();
        const first = getQueueConnection();
        const second = getQueueConnection();
        expect(first).toBe(second);
        // Cast: IORedis instances expose disconnect(); plain options don't.
        (first as unknown as { disconnect: () => void }).disconnect();
    });

    it('returns plain options (a new object each call) when the flag is off', async () => {
        process.env.FEATURE_SHARED_QUEUE_CONNECTION = 'false';
        process.env.LUMASTRA_LOW_RAM_MODE = 'true';
        vi.resetModules();
        const { getQueueConnection, __resetSharedQueueConnectionForTests } =
            await import('./connection.js');
        __resetSharedQueueConnectionForTests();
        const first = getQueueConnection();
        const second = getQueueConnection();
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });

    it('shares the IORedis instance by default when low-RAM mode is enabled', async () => {
        process.env.LUMASTRA_LOW_RAM_MODE = 'true';
        vi.resetModules();
        const { getQueueConnection, __resetSharedQueueConnectionForTests } =
            await import('./connection.js');
        __resetSharedQueueConnectionForTests();
        const first = getQueueConnection();
        const second = getQueueConnection();
        expect(first).toBe(second);
        (first as unknown as { disconnect: () => void }).disconnect();
    });
});
