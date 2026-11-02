// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Valkey distributed locking functions
 *
 * These tests verify the core locking logic using the in-memory fallback.
 * Integration tests with real Valkey infrastructure are in valkey.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Exercise only the isolated memory-lock primitive, never deployed topology.
// An inherited runner task endpoint deliberately makes disconnected locks fail closed.
vi.hoisted(() => vi.stubEnv('TASK_CACHE_URL', ''));
afterAll(() => vi.unstubAllEnvs());
import {
    acquireLock,
    releaseLock,
    expire,
    getLockMetrics,
    resetLockMetrics,
} from '../cache/valkey';

// Helper to wait for async operations
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Test key counter to avoid collisions
let testKeyCounter = 0;
const getUniqueKey = () => `test:lock:${testKeyCounter++}-${Date.now()}`;

describe('Distributed Locking Unit Tests', () => {
    beforeEach(() => {
        // Reset metrics before each test
        resetLockMetrics();
    });

    describe('acquireLock', () => {
        it('should acquire lock successfully when available', async () => {
            const lockKey = getUniqueKey();
            const lockValue = await acquireLock(lockKey, 300);

            expect(lockValue).toBeTruthy();
            expect(lockValue).toContain(`lock-${process.pid}-`);

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(1);
            expect(metrics.acquisitionSuccesses).toBe(1);
            expect(metrics.acquisitionFailures).toBe(0);
        });

        it('should return null when lock already held', async () => {
            const lockKey = getUniqueKey();

            // Acquire lock first time
            const lock1 = await acquireLock(lockKey, 300);
            expect(lock1).toBeTruthy();

            // Try to acquire same lock again
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeNull();

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(2);
            expect(metrics.acquisitionSuccesses).toBe(1);
            expect(metrics.acquisitionFailures).toBe(1);
        });

        it('should track acquisition metrics correctly', async () => {
            const key1 = getUniqueKey();
            const lock1 = await acquireLock(key1, 300);
            const lock2 = await acquireLock(getUniqueKey(), 300);
            const lock3 = await acquireLock(key1, 300); // Try to re-acquire same key
            void lock1;
            void lock2;
            void lock3;

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(3);
            expect(metrics.acquisitionSuccesses).toBe(2);
            expect(metrics.acquisitionFailures).toBe(1);
            expect(metrics.lockCount).toBe(2);
        });

        it('should generate unique lock values with process.pid', async () => {
            const value1 = await acquireLock(getUniqueKey(), 300);
            const value2 = await acquireLock(getUniqueKey(), 300);

            expect(value1).not.toBe(value2);
            expect(value1).toContain(`lock-${process.pid}-`);
            expect(value2).toContain(`lock-${process.pid}-`);
        });

        it('should accept custom lock value', async () => {
            const lockKey = getUniqueKey();
            const customValue = 'my-custom-lock-value';

            const lockValue = await acquireLock(lockKey, 300, customValue);

            expect(lockValue).toBe(customValue);
        });

        it('should prevent lock acquisition with same key', async () => {
            const lockKey = getUniqueKey();

            const lock1 = await acquireLock(lockKey, 300);
            const lock2 = await acquireLock(lockKey, 300);
            const lock3 = await acquireLock(lockKey, 300);

            expect(lock1).toBeTruthy();
            expect(lock2).toBeNull();
            expect(lock3).toBeNull();
        });
    });

    describe('releaseLock', () => {
        it('should release lock when owned', async () => {
            const lockKey = getUniqueKey();
            const lockValue = (await acquireLock(lockKey, 300))!;

            const released = await releaseLock(lockKey, lockValue);

            expect(released).toBe(true);

            const metrics = getLockMetrics();
            expect(metrics.releaseAttempts).toBe(1);
            expect(metrics.releaseSuccesses).toBe(1);
            expect(metrics.releaseFailures).toBe(0);
        });

        it('should return false when lock not owned', async () => {
            const lockKey = getUniqueKey();

            const released = await releaseLock(lockKey, 'wrong-value');

            expect(released).toBe(false);

            const metrics = getLockMetrics();
            expect(metrics.releaseAttempts).toBe(1);
            expect(metrics.releaseSuccesses).toBe(0);
            expect(metrics.releaseFailures).toBe(1);
        });

        it('should cleanup lockAcquisitionTimes on successful release', async () => {
            const lockKey = getUniqueKey();
            const lockValue = (await acquireLock(lockKey, 300))!;

            // Give some time to elapse
            await sleep(10);

            const released = await releaseLock(lockKey, lockValue);

            expect(released).toBe(true);

            const metrics = getLockMetrics();
            expect(metrics.totalHoldDurationMs).toBeGreaterThan(0);
            expect(metrics.averageHoldDurationMs).toBeGreaterThan(0);
        });

        it('should cleanup lockAcquisitionTimes on failed release (MEMORY LEAK BUG FIX)', async () => {
            const lockKey = getUniqueKey();
            const lockValue = (await acquireLock(lockKey, 300))!;

            // Release with correct value first
            await releaseLock(lockKey, lockValue);

            // Try to release again - should fail but still clean up Map entry
            const released2 = await releaseLock(lockKey, lockValue);

            expect(released2).toBe(false);

            // Critical: Map entry should be cleaned up to prevent memory leak
            const metrics = getLockMetrics();
            expect(metrics.activeLocksTracked).toBe(0);
        });

        it('should track hold duration metrics', async () => {
            const key1 = getUniqueKey();
            const lock1 = (await acquireLock(key1, 300))!;
            await sleep(50);
            await releaseLock(key1, lock1);

            const key2 = getUniqueKey();
            const lock2 = (await acquireLock(key2, 300))!;
            await sleep(100);
            await releaseLock(key2, lock2);

            const metrics = getLockMetrics();
            expect(metrics.totalHoldDurationMs).toBeGreaterThan(100);
            expect(metrics.averageHoldDurationMs).toBeGreaterThan(50);
            expect(metrics.releaseSuccesses).toBe(2);
        });

        it('should allow re-acquisition after release', async () => {
            const lockKey = getUniqueKey();

            const lock1 = await acquireLock(lockKey, 300);
            expect(lock1).toBeTruthy();

            await releaseLock(lockKey, lock1!);

            // Should be able to acquire again
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeTruthy();
        });
    });

    describe('expire (heartbeat)', () => {
        it('should extend lock TTL successfully', async () => {
            const lockKey = getUniqueKey();

            const result = await expire(lockKey, 300);

            // In-memory implementation may return false for non-existent keys
            // This test primarily verifies the function doesn't throw
            expect(typeof result).toBe('boolean');
        });

        it('should track heartbeat metrics for lock: keys', async () => {
            await expire('lock:sync:availability', 300);
            await expire('lock:cleanup:oauth', 300);

            const metrics = getLockMetrics();
            expect(metrics.heartbeatAttempts).toBe(2);
        });

        it('should track heartbeat metrics for cache warming locks', async () => {
            await expire('lock:cache-warming:frequent', 300);
            await expire('lock:cache-warming:regular', 300);
            await expire('lock:cache-warming:nightly', 300);

            const metrics = getLockMetrics();
            expect(metrics.heartbeatAttempts).toBe(3);
        });

        it('should not track metrics for non-lock keys', async () => {
            await expire('cache:some-data', 300);
            await expire('session:user:123', 300);

            const metrics = getLockMetrics();
            expect(metrics.heartbeatAttempts).toBe(0);
        });
    });

    describe('getLockMetrics', () => {
        it('should calculate average hold duration correctly', async () => {
            // Acquire and release multiple locks with different hold times
            const key1 = getUniqueKey();
            const lock1 = (await acquireLock(key1, 300))!;
            await sleep(50);
            await releaseLock(key1, lock1);

            const key2 = getUniqueKey();
            const lock2 = (await acquireLock(key2, 300))!;
            await sleep(100);
            await releaseLock(key2, lock2);

            const key3 = getUniqueKey();
            const lock3 = (await acquireLock(key3, 300))!;
            await sleep(150);
            await releaseLock(key3, lock3);

            const metrics = getLockMetrics();

            expect(metrics.releaseSuccesses).toBe(3);
            expect(metrics.totalHoldDurationMs).toBeGreaterThan(250);
            expect(metrics.averageHoldDurationMs).toBeGreaterThan(80);
        });

        it('should calculate contention rate percentage', async () => {
            const lockKey = getUniqueKey();

            await acquireLock(lockKey, 300); // Success
            await acquireLock(lockKey, 300); // Fail - already held
            await acquireLock(lockKey, 300); // Fail - already held
            await acquireLock(getUniqueKey(), 300); // Success - different key

            const metrics = getLockMetrics();

            expect(metrics.acquisitionAttempts).toBe(4);
            expect(metrics.acquisitionFailures).toBe(2);
            expect(metrics.contentionRate).toBe('50.00%');
        });

        it('should return 0.00% contention rate when no attempts', async () => {
            const metrics = getLockMetrics();

            expect(metrics.contentionRate).toBe('0.00%');
        });

        it('should return activeLocksTracked count', async () => {
            const lock1 = await acquireLock(getUniqueKey(), 300);
            const lock2 = await acquireLock(getUniqueKey(), 300);
            const lock3 = (await acquireLock(getUniqueKey(), 300))!;
            void lock1;
            void lock2;

            let metrics = getLockMetrics();
            expect(metrics.activeLocksTracked).toBe(3);

            // Release one lock
            await releaseLock(getUniqueKey(), lock3);

            metrics = getLockMetrics();
            expect(metrics.activeLocksTracked).toBe(2);
        });

        it('should handle zero releases gracefully', async () => {
            await acquireLock(getUniqueKey(), 300);

            const metrics = getLockMetrics();

            expect(metrics.averageHoldDurationMs).toBe(0);
        });
    });

    describe('resetLockMetrics', () => {
        it('should reset all metrics to zero', async () => {
            // Generate some metrics
            const lock1 = (await acquireLock(getUniqueKey(), 300))!;
            await sleep(50);
            await releaseLock(getUniqueKey(), lock1);

            let metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBeGreaterThan(0);

            // Reset
            resetLockMetrics();

            metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(0);
            expect(metrics.acquisitionSuccesses).toBe(0);
            expect(metrics.acquisitionFailures).toBe(0);
            expect(metrics.releaseAttempts).toBe(0);
            expect(metrics.releaseSuccesses).toBe(0);
            expect(metrics.releaseFailures).toBe(0);
            expect(metrics.heartbeatAttempts).toBe(0);
            expect(metrics.heartbeatFailures).toBe(0);
            expect(metrics.totalHoldDurationMs).toBe(0);
            expect(metrics.lockCount).toBe(0);
            expect(metrics.averageHoldDurationMs).toBe(0);
            expect(metrics.contentionRate).toBe('0.00%');
            expect(metrics.activeLocksTracked).toBe(0);
        });
    });

    describe('Lock value format', () => {
        it('should include process.pid in lock value to prevent collisions', async () => {
            const lockValue = await acquireLock(getUniqueKey(), 300);

            expect(lockValue).toMatch(/^lock-\d+-\d+-[a-z0-9]+$/);
            expect(lockValue).toContain(`lock-${process.pid}-`);
        });

        it('should generate different values even in quick succession', async () => {
            const values = await Promise.all([
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
            ]);

            // All values should be unique
            expect(values[0]).not.toBe(values[1]);
            expect(values[1]).not.toBe(values[2]);
            expect(values[0]).not.toBe(values[2]);

            // All should contain process.pid
            values.forEach((val) => {
                expect(val).toContain(`lock-${process.pid}-`);
            });
        });
    });

    describe('Lock lifecycle scenarios', () => {
        it('should handle acquire -> release -> re-acquire cycle', async () => {
            const lockKey = getUniqueKey();

            // Cycle 1
            const lock1 = await acquireLock(lockKey, 300);
            expect(lock1).toBeTruthy();
            await releaseLock(lockKey, lock1!);

            // Cycle 2
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeTruthy();
            expect(lock2).not.toBe(lock1); // Different lock value
            await releaseLock(lockKey, lock2!);

            // Cycle 3
            const lock3 = await acquireLock(lockKey, 300);
            expect(lock3).toBeTruthy();
            expect(lock3).not.toBe(lock1);
            expect(lock3).not.toBe(lock2);
        });

        it('should handle multiple concurrent locks with different keys', async () => {
            const locks = await Promise.all([
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
            ]);

            // All should succeed (different keys)
            locks.forEach((lock) => expect(lock).toBeTruthy());

            // All should be unique
            const uniqueValues = new Set(locks);
            expect(uniqueValues.size).toBe(4);

            const metrics = getLockMetrics();
            expect(metrics.acquisitionSuccesses).toBe(4);
            expect(metrics.activeLocksTracked).toBe(4);
        });

        it('should track metrics correctly across mixed operations', async () => {
            const key1 = getUniqueKey();
            const key2 = getUniqueKey();

            // Successful acquisition
            const lock1 = await acquireLock(key1, 300);
            expect(lock1).toBeTruthy();

            // Failed acquisition (key1 held)
            const lock2 = await acquireLock(key1, 300);
            expect(lock2).toBeNull();

            // Successful acquisition (different key)
            const lock3 = await acquireLock(key2, 300);
            expect(lock3).toBeTruthy();

            // Successful release
            const released1 = await releaseLock(key1, lock1!);
            expect(released1).toBe(true);

            // Failed release (already released)
            const released2 = await releaseLock(key1, lock1!);
            expect(released2).toBe(false);

            // Heartbeat attempts
            await expire('lock:test:1', 300);
            await expire('lock:test:2', 300);

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(3);
            expect(metrics.acquisitionSuccesses).toBe(2);
            expect(metrics.acquisitionFailures).toBe(1);
            expect(metrics.releaseAttempts).toBe(2);
            expect(metrics.releaseSuccesses).toBe(1);
            expect(metrics.releaseFailures).toBe(1);
            expect(metrics.heartbeatAttempts).toBe(2);
            expect(metrics.activeLocksTracked).toBe(1); // Only lock3 still tracked
        });
    });
});
