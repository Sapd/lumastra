// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/server/config.js', () => ({ FEATURE_SHARED_QUEUE_CONNECTION: false }));
import { getQueueConnectionOptions } from './connection';

afterEach(() => vi.unstubAllEnvs());

describe('task connection topology', () => {
    it('never uses CACHE_URL when TASK_CACHE_URL is absent', () => {
        vi.stubEnv('TASK_CACHE_URL', '');
        vi.stubEnv('CACHE_URL', 'redis://cache');
        expect(getQueueConnectionOptions).toThrow('TASK_CACHE_URL is required');
    });

    it('rejects a second logical database on the same instance', () => {
        vi.stubEnv('TASK_CACHE_URL', 'redis://same/1');
        vi.stubEnv('CACHE_URL', 'redis://same/0');
        expect(getQueueConnectionOptions).toThrow('distinct Valkey instances');
    });

    it('targets only the explicit task endpoint, honoring TLS, credentials and DB', () => {
        vi.stubEnv('TASK_CACHE_URL', 'rediss://user:p%40ss@tasks:6380/7');
        vi.stubEnv('CACHE_URL', 'redis://cache:6379/0');
        expect(getQueueConnectionOptions()).toMatchObject({
            host: 'tasks',
            port: 6380,
            db: 7,
            password: 'p@ss',
            username: 'user',
            tls: {},
            protocol: 2,
        });
    });
});
