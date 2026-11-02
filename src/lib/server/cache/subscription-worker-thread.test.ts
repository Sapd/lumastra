// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * No pub/sub clients inside a worker thread.
 *
 * The worker-isolation sandbox loads the whole server graph, including modules
 * that subscribe at import time. Each isolated run opened its own pub/sub
 * clients and dropped them when the thread exited — one GLIDE ERROR line per
 * channel per run (Windows e2e 2026-09-27).
 */

import { describe, expect, test, vi } from 'vitest';

const createClient = vi.fn();
vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient },
    GlideClientConfiguration: { PubSubChannelModes: { Exact: 'exact' } },
}));
vi.mock('node:worker_threads', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:worker_threads')>()),
    isMainThread: false,
}));

process.env.CACHE_URL = 'redis://127.0.0.1:6379';

const { subscribeToChannel } = await import('./valkey');

describe('subscribeToChannel in a worker thread', () => {
    test('returns null without creating a client', async () => {
        await expect(subscribeToChannel('ch:worker', () => {})).resolves.toBeNull();
        expect(createClient).not.toHaveBeenCalled();
    });
});
