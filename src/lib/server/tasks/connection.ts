// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// BullMQ connection builder for the task system.
//
// getQueueConnectionOptions() returns plain options (NOT an IORedis
// instance) — every BullMQ Queue/Worker/QueueEvents built from it opens its
// own independent connection. This is still the default path.
//
// getQueueConnection() is the flag-gated alternative: when
// FEATURE_SHARED_QUEUE_CONNECTION is on, it returns one memoized IORedis
// instance instead, which BullMQ's own isRedisInstance() check (see
// queue-base.js) marks `shared: true` — Queue instances and each Worker's
// non-blocking main connection then reuse this one socket. Worker's
// blocking pop and QueueEvents both always duplicate() regardless of what
// they're given (verified against bullmq 5.71.1's actual source, not just
// its docs) — this is a BullMQ architecture requirement, not a limitation
// of this implementation, so this change reduces but does not eliminate
// per-task connection count.
//
// Tasks always target the dedicated persistent noeviction instance.

import { logTaskConnectionLoss, noteTaskConnectionRecovered } from './queue-outage.js';
import type { ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';
import { Logger } from '../utils/logger';
import { FEATURE_SHARED_QUEUE_CONNECTION } from '$lib/server/config.js';
import { assertValkeyEndpointConfiguration } from '../config/valkey-endpoints.js';

const logger = Logger.for('TasksConnection');

export interface QueueConnectionOptions {
    host: string;
    port: number;
    password?: string;
    username?: string;
    db: number;
    maxRetriesPerRequest: null;
    enableReadyCheck: false;
    lazyConnect: false;
    /**
     * RESP2, explicitly. ioredis 6 made RESP3 its default; BullMQ's blocking
     * pops and Lua replies are written against RESP2 shapes, and leaving the
     * default in place made replica-handoff and dedup integration tests fail
     * repeatably (they pass on RESP2 and on ioredis 5). BullMQ builds its own
     * ioredis instances from this bag, so setting it here covers every
     * Queue/Worker/QueueEvents connection the task system opens.
     */
    protocol: 2;
    tls?: Record<string, never>;
}

/**
 * Get connection options object for BullMQ.
 *
 * Returns plain options — BullMQ internally creates its own IORedis instances
 * for Worker/Queue/QueueEvents from this options bag, so all connections are
 * authenticated and isolated.
 *
 * @throws When the task/cache endpoint configuration is missing, invalid or ambiguous
 */
export function getQueueConnectionOptions(): QueueConnectionOptions | null {
    const { task: config } = assertValkeyEndpointConfiguration();

    return {
        host: config.host,
        port: config.port,
        password: config.password,
        username: config.username,
        db: config.database,
        ...(config.tls ? { tls: {} } : {}),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: false,
        protocol: 2,
    };
}

let sharedConnection: IORedis | null = null;

/**
 * The connection every Queue/Worker/QueueEvents construction site should use.
 * Returns the same plain options as getQueueConnectionOptions() when the
 * flag is off (today's behavior, unchanged). When on, lazily builds and
 * memoizes one IORedis instance per process and returns that instead —
 * BullMQ shares it wherever its architecture allows (see file header).
 *
 * lazyConnect stays false (same as getQueueConnectionOptions()) so a
 * misconfigured TASK_CACHE_URL fails fast at first use rather than silently
 * queuing commands against a socket that never connects.
 *
 * Note: this shared IORedis instance is never explicitly closed on
 * runner.stop()/orchestrator.stop() — those close the BullMQ
 * Queue/Worker/QueueEvents built from it, but BullMQ never closes a
 * `shared: true` connection itself. That's intentional here: the instance
 * is meant to outlive a single task-system stop/start cycle (e.g. a
 * leader-loss/reacquire loop shouldn't pay for a fresh connection each
 * time). It's benign either way — process exit reaps the socket. The only
 * place it's explicitly closed is __resetSharedQueueConnectionForTests()
 * below, for test isolation.
 */
export function getQueueConnection(): ConnectionOptions | null {
    if (!FEATURE_SHARED_QUEUE_CONNECTION) return getQueueConnectionOptions();
    if (sharedConnection) return sharedConnection;
    const options = getQueueConnectionOptions();
    if (!options) return null;
    sharedConnection = new IORedis(options);
    sharedConnection.on('error', (err) => {
        if (logTaskConnectionLoss('shared-queue-connection', err)) return;
        logger.warn('Shared queue connection error', { err: err.message });
    });
    sharedConnection.on('ready', noteTaskConnectionRecovered);
    return sharedConnection;
}

/** Test-only: forces the next getQueueConnection() call to build a fresh instance. */
export function __resetSharedQueueConnectionForTests(): void {
    if (sharedConnection) {
        sharedConnection.disconnect();
    }
    sharedConnection = null;
}
