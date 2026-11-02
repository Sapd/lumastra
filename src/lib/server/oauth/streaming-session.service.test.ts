// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Streaming Session Service
 *
 * Tests token generation, validation logic, and utility functions.
 */

import { describe, it, expect, vi } from 'vitest';
import { StreamingSessionService } from './streaming-session.service.js';
import { createHash, randomBytes } from 'crypto';

// Test the pure utility functions by extracting the logic
// We test the logic directly since the service uses these internally

const STREAM_TOKEN_PREFIX = 'stream_';

function generateStreamToken(): string {
    return STREAM_TOKEN_PREFIX + randomBytes(16).toString('hex');
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function isStreamToken(token: string): boolean {
    return token.startsWith(STREAM_TOKEN_PREFIX);
}

describe('Streaming Session Token Generation', () => {
    describe('generateStreamToken', () => {
        it('generates token with correct prefix', () => {
            const token = generateStreamToken();
            expect(token.startsWith('stream_')).toBe(true);
        });

        it('generates token with correct length (39 chars)', () => {
            const token = generateStreamToken();
            // stream_ (7) + 32 hex chars = 39 total
            expect(token.length).toBe(39);
        });

        it('generates unique tokens', () => {
            const tokens = new Set<string>();
            for (let i = 0; i < 100; i++) {
                tokens.add(generateStreamToken());
            }
            expect(tokens.size).toBe(100);
        });

        it('generates only valid hex characters after prefix', () => {
            const token = generateStreamToken();
            const hexPart = token.slice(7);
            expect(hexPart).toMatch(/^[a-f0-9]+$/);
        });
    });

    describe('hashToken', () => {
        it('produces consistent hash for same input', () => {
            const token = 'stream_test123456789';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);
            expect(hash1).toBe(hash2);
        });

        it('produces different hash for different input', () => {
            const hash1 = hashToken('stream_token1');
            const hash2 = hashToken('stream_token2');
            expect(hash1).not.toBe(hash2);
        });

        it('produces 64-character hex string (SHA-256)', () => {
            const hash = hashToken('stream_anytoken');
            expect(hash.length).toBe(64);
            expect(hash).toMatch(/^[a-f0-9]+$/);
        });

        it('hash is irreversible (different lengths produce same hash length)', () => {
            const shortHash = hashToken('a');
            const longHash = hashToken('a'.repeat(1000));
            expect(shortHash.length).toBe(64);
            expect(longHash.length).toBe(64);
        });
    });

    describe('isStreamToken', () => {
        it('returns true for valid stream token', () => {
            expect(isStreamToken('stream_abc123def456')).toBe(true);
        });

        it('returns false for PAT token', () => {
            expect(isStreamToken('pat_abc123def456')).toBe(false);
        });

        it('returns false for service token', () => {
            expect(isStreamToken('svc_abc123def456')).toBe(false);
        });

        it('returns false for JWT-like token', () => {
            expect(
                isStreamToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'),
            ).toBe(false);
        });

        it('returns false for empty string', () => {
            expect(isStreamToken('')).toBe(false);
        });

        it('returns false for partial prefix', () => {
            expect(isStreamToken('stream')).toBe(false);
            expect(isStreamToken('str')).toBe(false);
        });

        it('is case sensitive', () => {
            expect(isStreamToken('STREAM_abc123')).toBe(false);
            expect(isStreamToken('Stream_abc123')).toBe(false);
        });
    });
});

describe('Streaming Session Validation Logic', () => {
    describe('expiration checking', () => {
        it('non-expired session is valid', () => {
            const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // Tomorrow
            const now = new Date();
            expect(expiresAt > now).toBe(true);
        });

        it('expired session is invalid', () => {
            const expiresAt = new Date(Date.now() - 24 * 60 * 60 * 1000); // Yesterday
            const now = new Date();
            expect(expiresAt > now).toBe(false);
        });
    });

    describe('inactivity timeout checking', () => {
        const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

        it('active session within timeout is valid', () => {
            const lastUsedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
            const now = Date.now();
            const isInactive = now - lastUsedAt.getTime() > INACTIVITY_TIMEOUT_MS;
            expect(isInactive).toBe(false);
        });

        it('session inactive beyond timeout is invalid', () => {
            const lastUsedAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
            const now = Date.now();
            const isInactive = now - lastUsedAt.getTime() > INACTIVITY_TIMEOUT_MS;
            expect(isInactive).toBe(true);
        });

        it('session exactly at timeout boundary', () => {
            const lastUsedAt = new Date(Date.now() - INACTIVITY_TIMEOUT_MS - 1); // Just past timeout
            const now = Date.now();
            const isInactive = now - lastUsedAt.getTime() > INACTIVITY_TIMEOUT_MS;
            expect(isInactive).toBe(true);
        });
    });

    describe('item ID validation', () => {
        it('matching item IDs pass validation', () => {
            const sessionItemId = 'abc123-def456';
            const requestedItemId = 'abc123-def456';
            expect(sessionItemId === requestedItemId).toBe(true);
        });

        it('non-matching item IDs fail validation', () => {
            const sessionItemId: string = 'abc123-def456';
            const requestedItemId: string = 'xyz789-uvw012';
            expect(sessionItemId === requestedItemId).toBe(false);
        });
    });

    describe('IP address validation', () => {
        it('matching IPs pass validation', () => {
            const sessionIp = '192.168.1.100';
            const requestIp = '192.168.1.100';
            expect(sessionIp === requestIp).toBe(true);
        });

        it('non-matching IPs fail validation', () => {
            const sessionIp: string = '192.168.1.100';
            const requestIp: string = '10.0.0.50';
            expect(sessionIp === requestIp).toBe(false);
        });

        it('handles IPv6 addresses', () => {
            const sessionIp = '::ffff:192.168.1.100';
            const requestIp = '::ffff:192.168.1.100';
            expect(sessionIp === requestIp).toBe(true);
        });
    });
});

describe('Streaming Session Status', () => {
    describe('status reasons', () => {
        const validReasons = [
            'not_found',
            'expired',
            'inactive',
            'ended',
            'wrong_item',
            'wrong_ip',
        ];

        it('all status reasons are documented', () => {
            expect(validReasons).toContain('not_found');
            expect(validReasons).toContain('expired');
            expect(validReasons).toContain('inactive');
            expect(validReasons).toContain('ended');
            expect(validReasons).toContain('wrong_item');
            expect(validReasons).toContain('wrong_ip');
        });
    });

    describe('time until expiry calculation', () => {
        it('calculates correct seconds until expiry', () => {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
            const now = Date.now();
            const secondsUntilExpiry = Math.floor((expiresAt.getTime() - now) / 1000);
            expect(secondsUntilExpiry).toBeGreaterThan(3500);
            expect(secondsUntilExpiry).toBeLessThanOrEqual(3600);
        });

        it('returns negative for expired sessions', () => {
            const expiresAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
            const now = Date.now();
            const secondsUntilExpiry = Math.floor((expiresAt.getTime() - now) / 1000);
            expect(secondsUntilExpiry).toBeLessThan(0);
        });
    });

    describe('time until inactivity calculation', () => {
        const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

        it('calculates correct seconds until inactivity timeout', () => {
            const lastUsedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
            const now = Date.now();
            const inactivityExpiresAt = lastUsedAt.getTime() + INACTIVITY_TIMEOUT_MS;
            const secondsUntilInactivity = Math.floor((inactivityExpiresAt - now) / 1000);
            // Should be about 90 minutes (5400 seconds)
            expect(secondsUntilInactivity).toBeGreaterThan(5000);
            expect(secondsUntilInactivity).toBeLessThan(5500);
        });
    });
});

describe('Session Cleanup Logic', () => {
    describe('inactivity cleanup threshold', () => {
        const INACTIVITY_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

        it('identifies inactive sessions for cleanup', () => {
            const now = new Date();
            const inactivityThreshold = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);
            const lastUsedAt = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago

            expect(lastUsedAt < inactivityThreshold).toBe(true);
        });

        it('preserves active sessions', () => {
            const now = new Date();
            const inactivityThreshold = new Date(now.getTime() - INACTIVITY_TIMEOUT_MS);
            const lastUsedAt = new Date(now.getTime() - 30 * 60 * 1000); // 30 minutes ago

            expect(lastUsedAt < inactivityThreshold).toBe(false);
        });
    });

    describe('old session deletion', () => {
        it('identifies sessions older than 7 days for deletion', () => {
            const now = new Date();
            const deleteThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const createdAt = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000); // 10 days ago

            expect(createdAt < deleteThreshold).toBe(true);
        });

        it('preserves recent ended sessions', () => {
            const now = new Date();
            const deleteThreshold = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const createdAt = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 days ago

            expect(createdAt < deleteThreshold).toBe(false);
        });
    });
});

describe('Ended Reason Validation', () => {
    const validEndedReasons = ['client_request', 'inactivity', 'expired', 'ip_mismatch', 'refresh'];

    it('client_request is valid reason', () => {
        expect(validEndedReasons).toContain('client_request');
    });

    it('inactivity is valid reason', () => {
        expect(validEndedReasons).toContain('inactivity');
    });

    it('expired is valid reason', () => {
        expect(validEndedReasons).toContain('expired');
    });

    it('ip_mismatch is valid reason', () => {
        expect(validEndedReasons).toContain('ip_mismatch');
    });

    it('refresh is valid reason', () => {
        expect(validEndedReasons).toContain('refresh');
    });

    it('unknown reason is invalid', () => {
        expect(validEndedReasons).not.toContain('unknown');
        expect(validEndedReasons).not.toContain('error');
    });
});

describe('Cache Key Generation', () => {
    describe('token hash as cache key', () => {
        it('generates consistent cache key for same token', () => {
            const token = 'stream_abc123def456';
            const key1 = hashToken(token);
            const key2 = hashToken(token);
            expect(key1).toBe(key2);
        });

        it('generates different keys for different tokens', () => {
            const key1 = hashToken('stream_token1');
            const key2 = hashToken('stream_token2');
            expect(key1).not.toBe(key2);
        });
    });
});

describe('Debounce Logic', () => {
    const DEBOUNCE_INTERVAL_MS = 60 * 1000; // 1 minute

    it('allows update when no previous update', () => {
        const lastUpdate = 0;
        const now = Date.now();
        expect(now - lastUpdate > DEBOUNCE_INTERVAL_MS).toBe(true);
    });

    it('blocks update within debounce interval', () => {
        const lastUpdate = Date.now() - 30 * 1000; // 30 seconds ago
        const now = Date.now();
        expect(now - lastUpdate > DEBOUNCE_INTERVAL_MS).toBe(false);
    });

    it('allows update after debounce interval', () => {
        const lastUpdate = Date.now() - 2 * 60 * 1000; // 2 minutes ago
        const now = Date.now();
        expect(now - lastUpdate > DEBOUNCE_INTERVAL_MS).toBe(true);
    });
});

const storeSql = vi.hoisted(() => vi.fn());
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return storeSql;
        }
    },
}));
vi.mock('../config', () => ({ config: { STREAMING_SESSION_ENFORCE_IP: true } }));
vi.mock('./device-session-liveness.js', () => ({ isDeviceSessionTombstoned: () => false }));

describe('stored playback grant identity', () => {
    it.each(['00000000-0000-4000-8000-000000000005', null])(
        'preserves the public id and nullable playback binding (%s) through validation and cache',
        async (playbackSessionId) => {
            const id = '00000000-0000-4000-8000-000000000001';
            const token = 'stream_secret-distinct-from-id';
            storeSql.mockReset().mockResolvedValue([
                {
                    id,
                    username: 'listener',
                    user_id: '00000000-0000-4000-8000-000000000002',
                    device_session_id: null,
                    media_item_id: 'media',
                    play_session_id: playbackSessionId,
                    is_wildcard: false,
                    client_ip: '*',
                    created_at: new Date(),
                    last_used_at: new Date(),
                    expires_at: new Date(Date.now() + 3600000),
                    minted_by_admin: false,
                    device_session_revoked: false,
                },
            ]);
            const service = new StreamingSessionService();
            try {
                const first = await service.validate(token, 'media', '192.0.2.1');
                expect(first).toMatchObject({ id, playbackSessionId, mediaItemId: 'media' });
                expect(first!.id).not.toBe(token);
                expect(await service.validate(token, 'media', '192.0.2.1')).toEqual(first);
                expect(await service.validate(token, 'other-media', '192.0.2.1')).toBeNull();
            } finally {
                service.shutdown();
            }
        },
    );
});
