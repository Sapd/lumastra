// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for Valkey distributed locking with real Valkey instance
 *
 * These tests require a running Valkey/Redis instance configured via CACHE_URL.
 * Tests will be skipped if Valkey is not available.
 *
 * To run: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
    acquireLock,
    releaseLock,
    expire,
    getLockMetrics,
    resetLockMetrics,
    connectValkey,
    isValkeyReady,
    disconnectValkey,
} from '../cache/valkey';

// Helper to wait for async operations
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Test key counter to avoid collisions
let testKeyCounter = 0;
const getUniqueKey = () => `test:integration:lock:${testKeyCounter++}-${Date.now()}`;

// Track whether Valkey is available
let valkeyAvailable = false;

describe('Distributed Locking Integration Tests', () => {
    beforeAll(async () => {
        // Try to connect to Valkey
        valkeyAvailable = await connectValkey();

        if (!valkeyAvailable) {
            console.warn(
                '⚠️  Valkey not available - skipping integration tests. Set CACHE_URL to run these tests.',
            );
        } else {
            console.log('✓ Valkey connected successfully for integration tests');
        }
    });

    afterAll(async () => {
        if (valkeyAvailable) {
            await disconnectValkey();
        }
    });

    beforeEach(() => {
        // Reset metrics before each test
        resetLockMetrics();
    });

    describe('Lock lifecycle with real Valkey', () => {
        it('should acquire lock with Valkey backend', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();
            const lockValue = await acquireLock(lockKey, 300);

            expect(lockValue).toBeTruthy();
            expect(lockValue).toContain(`lock-${process.pid}-`);
            expect(isValkeyReady()).toBe(true);

            // Cleanup
            if (lockValue) await releaseLock(lockKey, lockValue);
        });

        it('should prevent duplicate acquisition with same key', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // First acquisition should succeed
            const lock1 = await acquireLock(lockKey, 300);
            expect(lock1).toBeTruthy();

            // Second acquisition with same key should fail
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeNull();

            // Cleanup
            if (lock1) await releaseLock(lockKey, lock1);
        });

        it('should release lock successfully', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();
            const lockValue = (await acquireLock(lockKey, 300))!;

            expect(lockValue).toBeTruthy();

            const released = await releaseLock(lockKey, lockValue);
            expect(released).toBe(true);

            const metrics = getLockMetrics();
            expect(metrics.releaseSuccesses).toBe(1);
        });

        it('should allow re-acquisition after release', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Cycle 1
            const lock1 = await acquireLock(lockKey, 300);
            expect(lock1).toBeTruthy();
            await releaseLock(lockKey, lock1!);

            // Cycle 2 - should succeed
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeTruthy();
            expect(lock2).not.toBe(lock1); // Different lock value

            // Cleanup
            if (lock2) await releaseLock(lockKey, lock2);
        });

        it('should handle full acquire → heartbeat → release workflow', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Acquire lock
            const lockValue = await acquireLock(lockKey, 5);
            expect(lockValue).toBeTruthy();

            // Extend TTL via heartbeat
            await sleep(1000);
            const extended = await expire(lockKey, 10);
            expect(extended).toBe(true);

            // Release lock
            const released = await releaseLock(lockKey, lockValue!);
            expect(released).toBe(true);

            const metrics = getLockMetrics();
            expect(metrics.acquisitionSuccesses).toBe(1);
            expect(metrics.releaseSuccesses).toBe(1);
            expect(metrics.heartbeatAttempts).toBe(1);
        });
    });

    describe('Lock expiration via TTL', () => {
        it('should expire lock after TTL', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Acquire lock with short TTL (2 seconds)
            const lockValue = await acquireLock(lockKey, 2);
            expect(lockValue).toBeTruthy();

            // Wait for lock to expire
            await sleep(2500);

            // Try to release expired lock - should fail
            const released = await releaseLock(lockKey, lockValue!);
            expect(released).toBe(false);

            // Should be able to acquire again (lock expired)
            const lock2 = await acquireLock(lockKey, 300);
            expect(lock2).toBeTruthy();

            // Cleanup
            if (lock2) await releaseLock(lockKey, lock2);
        });

        it('should cleanup Map entry when lock expires', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Acquire lock with short TTL
            const lockValue = await acquireLock(lockKey, 1);
            expect(lockValue).toBeTruthy();

            const initialTracked = getLockMetrics().activeLocksTracked;
            expect(initialTracked).toBeGreaterThan(0);

            // Wait for expiration
            await sleep(1500);

            // Try to release expired lock - should cleanup Map entry
            await releaseLock(lockKey, lockValue!);

            const finalTracked = getLockMetrics().activeLocksTracked;
            expect(finalTracked).toBe(initialTracked - 1);
        });
    });

    describe('Heartbeat (expire) functionality', () => {
        it('should extend lock TTL via expire', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Acquire lock with short TTL
            const lockValue = await acquireLock(lockKey, 2);
            expect(lockValue).toBeTruthy();

            // Wait 1 second then extend TTL
            await sleep(1000);
            const extended = await expire(lockKey, 10);
            expect(extended).toBe(true);

            // Wait another 2 seconds (original TTL would have expired)
            await sleep(2000);

            // Lock should still be valid
            const released = await releaseLock(lockKey, lockValue!);
            expect(released).toBe(true);
        });

        it('should track heartbeat metrics', async () => {
            if (!valkeyAvailable) return;

            const lockKey1 = 'lock:test:heartbeat1';
            const lockKey2 = 'lock:cache-warming:test';

            await expire(lockKey1, 300);
            await expire(lockKey2, 300);

            const metrics = getLockMetrics();
            expect(metrics.heartbeatAttempts).toBe(2);
        });

        it('should fail expire on non-existent key', async () => {
            if (!valkeyAvailable) return;

            const nonExistentKey = 'lock:nonexistent:' + Date.now();
            const result = await expire(nonExistentKey, 300);

            expect(result).toBe(false);
            const metrics = getLockMetrics();
            expect(metrics.heartbeatFailures).toBeGreaterThan(0);
        });
    });

    describe('Concurrent lock attempts', () => {
        it('should only allow one acquisition at a time', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Attempt 10 concurrent acquisitions
            const promises = Array.from({ length: 10 }, () => acquireLock(lockKey, 300));

            const results = await Promise.all(promises);

            // Only one should succeed
            const successful = results.filter((r) => r !== null);
            const failed = results.filter((r) => r === null);

            expect(successful.length).toBe(1);
            expect(failed.length).toBe(9);

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(10);
            expect(metrics.acquisitionSuccesses).toBe(1);
            expect(metrics.acquisitionFailures).toBe(9);

            // Cleanup
            const lockValue = successful[0];
            if (lockValue) await releaseLock(lockKey, lockValue);
        });

        it('should handle race conditions correctly', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Two processes try to acquire simultaneously
            const [lock1, lock2] = await Promise.all([
                acquireLock(lockKey, 300),
                acquireLock(lockKey, 300),
            ]);

            // One should succeed, one should fail
            const successes = [lock1, lock2].filter((l) => l !== null);
            expect(successes.length).toBe(1);

            // Cleanup
            const winner = successes[0];
            if (winner) await releaseLock(lockKey, winner);
        });
    });

    describe('Metrics tracking with Valkey', () => {
        it('should track hold duration correctly', async () => {
            if (!valkeyAvailable) return;

            const key1 = getUniqueKey();
            const lock1 = (await acquireLock(key1, 300))!;
            await sleep(50);
            await releaseLock(key1, lock1);

            const metrics = getLockMetrics();
            expect(metrics.totalHoldDurationMs).toBeGreaterThan(40);
            expect(metrics.averageHoldDurationMs).toBeGreaterThan(40);
        });

        it('should track contention rate', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            await acquireLock(lockKey, 300); // Success
            await acquireLock(lockKey, 300); // Fail
            await acquireLock(lockKey, 300); // Fail
            await acquireLock(getUniqueKey(), 300); // Success - different key

            const metrics = getLockMetrics();
            expect(metrics.acquisitionAttempts).toBe(4);
            expect(metrics.acquisitionFailures).toBe(2);
            expect(metrics.contentionRate).toBe('50.00%');
        });
    });

    describe('Lock value format', () => {
        it('should generate unique values with process.pid', async () => {
            if (!valkeyAvailable) return;

            const values = await Promise.all([
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
            ]);

            // All should be unique
            const uniqueSet = new Set(values.filter((v) => v !== null));
            expect(uniqueSet.size).toBe(3);

            // All should contain process.pid
            values.forEach((val) => {
                expect(val).toContain(`lock-${process.pid}-`);
            });
        });

        it('should accept custom lock value', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();
            const customValue = `custom-${Date.now()}`;

            const lockValue = await acquireLock(lockKey, 300, customValue);
            expect(lockValue).toBe(customValue);

            // Cleanup
            if (lockValue) await releaseLock(lockKey, lockValue);
        });
    });

    describe('Error handling', () => {
        it('should handle release of non-owned lock', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();

            // Try to release lock we don't own
            const released = await releaseLock(lockKey, 'wrong-value');
            expect(released).toBe(false);

            const metrics = getLockMetrics();
            expect(metrics.releaseFailures).toBe(1);
        });

        it('should handle double release', async () => {
            if (!valkeyAvailable) return;

            const lockKey = getUniqueKey();
            const lockValue = (await acquireLock(lockKey, 300))!;

            // First release should succeed
            const released1 = await releaseLock(lockKey, lockValue);
            expect(released1).toBe(true);

            // Second release should fail
            const released2 = await releaseLock(lockKey, lockValue);
            expect(released2).toBe(false);
        });
    });

    describe('Multiple locks', () => {
        it('should handle multiple different locks simultaneously', async () => {
            if (!valkeyAvailable) return;

            const locks = await Promise.all([
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
                acquireLock(getUniqueKey(), 300),
            ]);

            // All should succeed (different keys)
            locks.forEach((lock) => expect(lock).toBeTruthy());

            const metrics = getLockMetrics();
            expect(metrics.acquisitionSuccesses).toBe(4);
            expect(metrics.activeLocksTracked).toBe(4);

            // Cleanup all locks
            await Promise.all(
                locks.map((lock, idx) =>
                    releaseLock(`test:integration:lock:${testKeyCounter - 4 + idx}-*`, lock!),
                ),
            );
        });
    });
});
