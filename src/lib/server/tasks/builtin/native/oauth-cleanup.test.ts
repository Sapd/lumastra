// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the oauth-cleanup native task.
 *
 * Verifies that when Jellyfin is disabled (standalone mode),
 * getJellyfinTokenService() is never called during cleanup.
 *
 * Also verifies the total-failure escalation: when every per-service
 * cleanup call errors AND nothing was cleaned up, the task must THROW a
 * transient TaskError (a bare `success:false` return is never surfaced to
 * the circuit breaker / task_history state — only a thrown error is). A
 * partial failure (some services succeed, some don't) must keep returning
 * normally with the errors recorded, per per-item isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock refs so they can be reconfigured per-test.
const oauthMocks = vi.hoisted(() => ({
    isDeviceAuthEnabled: vi.fn(() => true),
    deviceCodesCleanup: vi.fn().mockResolvedValue(0),
    refreshTokensCleanup: vi.fn().mockResolvedValue(0),
    patsCleanup: vi.fn().mockResolvedValue(0),
    serviceTokensCleanup: vi.fn().mockResolvedValue(0),
    jellyfinTokensCleanup: vi.fn().mockResolvedValue(0),
}));

const streamingMocks = vi.hoisted(() => ({
    cleanup: vi.fn().mockResolvedValue({
        inactiveEnded: 0,
        expiredEnded: 0,
        orphanedParentsEnded: 0,
        oldDeleted: 0,
    }),
}));

vi.mock('../../registry.js', () => ({
    registry: { registerTask: vi.fn() },
}));

// Simulate standalone mode: Jellyfin not configured
vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: {
        isJellyfinEnabled: false,
    },
}));

// Mock the OAuth module with tracked, per-test-overridable cleanup calls.
vi.mock('$lib/server/oauth/index.js', () => ({
    isDeviceAuthEnabled: oauthMocks.isDeviceAuthEnabled,
    getDeviceCodeService: () => ({ cleanupExpired: oauthMocks.deviceCodesCleanup }),
    getRefreshTokenService: () => ({ cleanup: oauthMocks.refreshTokensCleanup }),
    getPatService: () => ({ cleanup: oauthMocks.patsCleanup }),
    getServiceTokenService: () => ({ cleanup: oauthMocks.serviceTokensCleanup }),
    getJellyfinTokenService: () => ({ cleanup: oauthMocks.jellyfinTokensCleanup }),
}));

// Mock streaming session service
vi.mock('$lib/server/oauth/streaming-session.service.js', () => ({
    getStreamingSessionService: () => ({ cleanup: streamingMocks.cleanup }),
}));

import { oauthCleanupTask } from './oauth-cleanup.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

type OAuthCleanupInput = Record<string, unknown>;

/** Minimal TaskContext for tests */
function makeContext(): TaskContext<OAuthCleanupInput> {
    const ac = new AbortController();
    return {
        sql: {} as never,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            child: vi.fn(),
        },
        signal: ac.signal,
        input: {},
        reportProgress: vi.fn(),
    } as unknown as TaskContext<OAuthCleanupInput>;
}

describe('oauth-cleanup task — standalone mode (Jellyfin disabled)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        oauthMocks.isDeviceAuthEnabled.mockReturnValue(true);
        oauthMocks.deviceCodesCleanup.mockResolvedValue(0);
        oauthMocks.refreshTokensCleanup.mockResolvedValue(0);
        oauthMocks.patsCleanup.mockResolvedValue(0);
        oauthMocks.serviceTokensCleanup.mockResolvedValue(0);
        oauthMocks.jellyfinTokensCleanup.mockResolvedValue(0);
        streamingMocks.cleanup.mockResolvedValue({
            inactiveEnded: 0,
            expiredEnded: 0,
            orphanedParentsEnded: 0,
            oldDeleted: 0,
        });
    });

    it('does not call getJellyfinTokenService() when isJellyfinEnabled is false', async () => {
        const result = await oauthCleanupTask.execute(makeContext());

        expect(oauthMocks.jellyfinTokensCleanup).not.toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    it('still cleans up non-Jellyfin OAuth tokens in standalone mode', async () => {
        const result = await oauthCleanupTask.execute(makeContext());

        expect(result.success).toBe(true);
        expect(result.result?.jellyfinTokensDeleted).toBe(0);
    });
});

describe('oauth-cleanup task — total-failure escalation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        oauthMocks.isDeviceAuthEnabled.mockReturnValue(true);
    });

    it('throws a transient TaskError when every service cleanup fails and nothing was cleaned', async () => {
        oauthMocks.deviceCodesCleanup.mockRejectedValue(new Error('device-code table unreachable'));
        oauthMocks.refreshTokensCleanup.mockRejectedValue(new Error('db down'));
        oauthMocks.patsCleanup.mockRejectedValue(new Error('db down'));
        oauthMocks.serviceTokensCleanup.mockRejectedValue(new Error('db down'));
        streamingMocks.cleanup.mockRejectedValue(new Error('streaming session service down'));

        await expect(oauthCleanupTask.execute(makeContext())).rejects.toThrow(/total failure/i);
    });

    it('does NOT throw when at least one service succeeds (partial failure)', async () => {
        oauthMocks.patsCleanup.mockResolvedValue(3);
        oauthMocks.deviceCodesCleanup.mockRejectedValue(new Error('device-code table unreachable'));
        oauthMocks.refreshTokensCleanup.mockRejectedValue(new Error('db down'));
        oauthMocks.serviceTokensCleanup.mockResolvedValue(0);
        streamingMocks.cleanup.mockResolvedValue({
            inactiveEnded: 0,
            expiredEnded: 0,
            orphanedParentsEnded: 0,
            oldDeleted: 0,
        });

        const result = await oauthCleanupTask.execute(makeContext());

        expect(result.success).toBe(false);
        expect(result.itemsProcessed).toBe(3);
        expect(result.result?.errors.length).toBeGreaterThan(0);
    });

    it('does NOT throw when everything fails but the run was already aborted', async () => {
        oauthMocks.deviceCodesCleanup.mockRejectedValue(new Error('device-code table unreachable'));
        oauthMocks.refreshTokensCleanup.mockRejectedValue(new Error('db down'));
        oauthMocks.patsCleanup.mockRejectedValue(new Error('db down'));
        oauthMocks.serviceTokensCleanup.mockRejectedValue(new Error('db down'));
        streamingMocks.cleanup.mockRejectedValue(new Error('streaming session service down'));

        const ac = new AbortController();
        const ctx = {
            sql: {} as never,
            logger: {
                info: vi.fn(),
                debug: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                child: vi.fn(),
            },
            signal: ac.signal,
            input: {},
            reportProgress: vi.fn(),
        } as unknown as TaskContext<OAuthCleanupInput>;
        ac.abort();

        const result = await oauthCleanupTask.execute(ctx);

        expect(result.success).toBe(true);
        expect(result.stopReason).toBe('aborted');
    });
});
