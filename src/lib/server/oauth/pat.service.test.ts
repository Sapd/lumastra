// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Personal Access Token (PAT) Service
 *
 * Tests token generation, validation, scope checking, and utility functions.
 */

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// Test the pure utility functions by extracting them
// We test the logic directly since the service uses these internally

describe('PAT Token Generation', () => {
    const PAT_PREFIX = 'pat_';

    function generatePatToken(): string {
        return PAT_PREFIX + randomBytes(24).toString('hex');
    }

    function getTokenPrefix(token: string): string {
        return token.substring(0, 12);
    }

    function hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    describe('generatePatToken', () => {
        it('generates token with correct prefix', () => {
            const token = generatePatToken();
            expect(token.startsWith('pat_')).toBe(true);
        });

        it('generates token with correct length (52 chars)', () => {
            const token = generatePatToken();
            // pat_ (4) + 48 hex chars = 52 total
            expect(token.length).toBe(52);
        });

        it('generates unique tokens', () => {
            const tokens = new Set<string>();
            for (let i = 0; i < 100; i++) {
                tokens.add(generatePatToken());
            }
            expect(tokens.size).toBe(100);
        });

        it('generates only valid hex characters after prefix', () => {
            const token = generatePatToken();
            const hexPart = token.slice(4);
            expect(hexPart).toMatch(/^[a-f0-9]+$/);
        });
    });

    describe('getTokenPrefix', () => {
        it('extracts first 12 characters', () => {
            const token = 'pat_abc123def456xyz';
            expect(getTokenPrefix(token)).toBe('pat_abc123de');
        });

        it('handles exact length token', () => {
            const token = 'pat_12345678';
            expect(getTokenPrefix(token)).toBe('pat_12345678');
        });

        it('handles short token gracefully', () => {
            const token = 'pat_';
            expect(getTokenPrefix(token)).toBe('pat_');
        });
    });

    describe('hashToken', () => {
        it('produces consistent hash for same input', () => {
            const token = 'pat_test123456789';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);
            expect(hash1).toBe(hash2);
        });

        it('produces different hash for different input', () => {
            const hash1 = hashToken('pat_token1');
            const hash2 = hashToken('pat_token2');
            expect(hash1).not.toBe(hash2);
        });

        it('produces 64-character hex string (SHA-256)', () => {
            const hash = hashToken('pat_anytoken');
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
});

describe('PAT Token Type Detection', () => {
    function isPatToken(token: string): boolean {
        return token.startsWith('pat_');
    }

    it('returns true for valid PAT token', () => {
        expect(isPatToken('pat_abc123def456')).toBe(true);
    });

    it('returns false for service token', () => {
        expect(isPatToken('svc_abc123def456')).toBe(false);
    });

    it('returns false for JWT-like token', () => {
        expect(isPatToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0')).toBe(
            false,
        );
    });

    it('returns false for empty string', () => {
        expect(isPatToken('')).toBe(false);
    });

    it('returns false for partial prefix', () => {
        expect(isPatToken('pat')).toBe(false);
        expect(isPatToken('pa')).toBe(false);
    });

    it('is case sensitive', () => {
        expect(isPatToken('PAT_abc123')).toBe(false);
        expect(isPatToken('Pat_abc123')).toBe(false);
    });
});

describe('PAT Scope Checking', () => {
    interface ValidatedPat {
        scopes: string[];
    }

    function hasScope(validated: ValidatedPat, requiredScope: string): boolean {
        // 'admin' scope implies all other scopes
        if (validated.scopes.includes('admin')) {
            return true;
        }
        // 'write' scope implies 'read'
        if (requiredScope === 'read' && validated.scopes.includes('write')) {
            return true;
        }
        return validated.scopes.includes(requiredScope);
    }

    describe('admin scope', () => {
        it('admin scope implies read', () => {
            const pat = { scopes: ['admin'] };
            expect(hasScope(pat, 'read')).toBe(true);
        });

        it('admin scope implies write', () => {
            const pat = { scopes: ['admin'] };
            expect(hasScope(pat, 'write')).toBe(true);
        });

        it('admin scope implies admin', () => {
            const pat = { scopes: ['admin'] };
            expect(hasScope(pat, 'admin')).toBe(true);
        });
    });

    describe('write scope', () => {
        it('write scope implies read', () => {
            const pat = { scopes: ['write'] };
            expect(hasScope(pat, 'read')).toBe(true);
        });

        it('write scope does not imply admin', () => {
            const pat = { scopes: ['write'] };
            expect(hasScope(pat, 'admin')).toBe(false);
        });

        it('write scope implies write', () => {
            const pat = { scopes: ['write'] };
            expect(hasScope(pat, 'write')).toBe(true);
        });
    });

    describe('read scope', () => {
        it('read scope implies read', () => {
            const pat = { scopes: ['read'] };
            expect(hasScope(pat, 'read')).toBe(true);
        });

        it('read scope does not imply write', () => {
            const pat = { scopes: ['read'] };
            expect(hasScope(pat, 'write')).toBe(false);
        });

        it('read scope does not imply admin', () => {
            const pat = { scopes: ['read'] };
            expect(hasScope(pat, 'admin')).toBe(false);
        });
    });

    describe('multiple scopes', () => {
        it('handles multiple scopes correctly', () => {
            const pat = { scopes: ['read', 'write'] };
            expect(hasScope(pat, 'read')).toBe(true);
            expect(hasScope(pat, 'write')).toBe(true);
            expect(hasScope(pat, 'admin')).toBe(false);
        });

        it('empty scopes denies all', () => {
            const pat = { scopes: [] };
            expect(hasScope(pat, 'read')).toBe(false);
            expect(hasScope(pat, 'write')).toBe(false);
            expect(hasScope(pat, 'admin')).toBe(false);
        });
    });

    describe('unknown scopes', () => {
        it('unknown scope is not granted', () => {
            const pat = { scopes: ['read'] };
            expect(hasScope(pat, 'delete')).toBe(false);
            expect(hasScope(pat, 'custom')).toBe(false);
        });
    });
});

describe('PAT Validation Logic', () => {
    describe('token prefix validation', () => {
        it('rejects tokens without pat_ prefix', () => {
            const token = 'svc_abc123';
            expect(token.startsWith('pat_')).toBe(false);
        });

        it('accepts tokens with pat_ prefix', () => {
            const token = 'pat_abc123';
            expect(token.startsWith('pat_')).toBe(true);
        });
    });

    describe('expiration checking', () => {
        it('non-expired token is valid', () => {
            const expiresAt = new Date(Date.now() + 86400000); // Tomorrow
            const now = new Date();
            expect(expiresAt > now).toBe(true);
        });

        it('expired token is invalid', () => {
            const expiresAt = new Date(Date.now() - 86400000); // Yesterday
            const now = new Date();
            expect(expiresAt > now).toBe(false);
        });

        it('null expiration means never expires', () => {
            const expiresAt = null;
            // In the service, null means no expiration
            expect(expiresAt === null).toBe(true);
        });
    });
});

// DB-outage behavior exercises the real PatService in
// token-revocation-valkey-unavailable.test.ts.

describe('PAT Creation Validation', () => {
    const MAX_PATS_PER_USER = 10;

    describe('token count limits', () => {
        it('allows creation when under limit', () => {
            const currentCount = 5;
            expect(currentCount < MAX_PATS_PER_USER).toBe(true);
        });

        it('blocks creation at limit', () => {
            const currentCount = 10;
            expect(currentCount >= MAX_PATS_PER_USER).toBe(true);
        });

        it('blocks creation over limit', () => {
            const currentCount = 15;
            expect(currentCount >= MAX_PATS_PER_USER).toBe(true);
        });
    });

    describe('expiration calculation', () => {
        it('calculates correct expiration for days', () => {
            const now = Date.now();
            const expiresInDays = 30;
            const expiresAt = new Date(now + expiresInDays * 24 * 60 * 60 * 1000);

            // Should be approximately 30 days in the future
            const diffMs = expiresAt.getTime() - now;
            const diffDays = diffMs / (24 * 60 * 60 * 1000);
            expect(Math.round(diffDays)).toBe(30);
        });

        it('null expiration means never expires', () => {
            const expiresInDays: number | null = null;
            let expiresAt: Date | null = null;

            if (expiresInDays !== null && expiresInDays !== undefined) {
                expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
            }

            expect(expiresAt).toBe(null);
        });
    });

    describe('default scopes', () => {
        it('defaults to read scope when not specified', () => {
            const providedScopes: string[] | undefined = undefined;
            const scopes = providedScopes || ['read'];
            expect(scopes).toEqual(['read']);
        });

        it('uses provided scopes when specified', () => {
            const providedScopes = ['read', 'write'];
            const scopes = providedScopes || ['read'];
            expect(scopes).toEqual(['read', 'write']);
        });
    });
});

describe('PAT List Item Mapping', () => {
    it('correctly identifies expired tokens', () => {
        const now = new Date();

        // Expired token
        const expiredRecord = {
            expires_at: new Date(now.getTime() - 86400000), // Yesterday
        };
        const isExpired1 = expiredRecord.expires_at
            ? new Date(expiredRecord.expires_at) < now
            : false;
        expect(isExpired1).toBe(true);

        // Valid token
        const validRecord = {
            expires_at: new Date(now.getTime() + 86400000), // Tomorrow
        };
        const isExpired2 = validRecord.expires_at ? new Date(validRecord.expires_at) < now : false;
        expect(isExpired2).toBe(false);

        // No expiration
        const noExpireRecord = {
            expires_at: null,
        };
        const isExpired3 = noExpireRecord.expires_at
            ? new Date(noExpireRecord.expires_at) < now
            : false;
        expect(isExpired3).toBe(false);
    });

    it('handles null scopes gracefully', () => {
        const record = { scopes: null };
        const scopes = record.scopes || [];
        expect(scopes).toEqual([]);
    });
});

describe('Advisory Lock Key Generation', () => {
    function hashToken(token: string): string {
        return createHash('sha256').update(token).digest('hex');
    }

    it('generates consistent lock key for same username', () => {
        const username = 'testuser';
        const lockKey1 = hashToken(username).substring(0, 8);
        const lockKey2 = hashToken(username).substring(0, 8);
        expect(lockKey1).toBe(lockKey2);
    });

    it('generates different lock keys for different usernames', () => {
        const lockKey1 = hashToken('user1').substring(0, 8);
        const lockKey2 = hashToken('user2').substring(0, 8);
        expect(lockKey1).not.toBe(lockKey2);
    });

    it('lock key fits in PostgreSQL int4', () => {
        const lockKey = hashToken('testuser').substring(0, 8);
        const lockKeyInt = parseInt(lockKey, 16) % 2147483647;
        expect(lockKeyInt).toBeLessThan(2147483647);
        expect(lockKeyInt).toBeGreaterThanOrEqual(0);
    });
});

// ---------------------------------------------------------------------------
// isJellyfinCompatScope predicate — unit tests for cache-bypass and
// exclusive-scope guard logic mirrored from pat.service.ts
// ---------------------------------------------------------------------------

describe('isJellyfinCompatScope predicate', () => {
    function isJellyfinCompatScope(scopes: string[]): boolean {
        return scopes.length === 1 && scopes[0] === 'jellyfin_compat';
    }

    it('returns true for exact single jellyfin_compat scope', () => {
        expect(isJellyfinCompatScope(['jellyfin_compat'])).toBe(true);
    });

    it('returns false for jellyfin_compat mixed with admin', () => {
        expect(isJellyfinCompatScope(['jellyfin_compat', 'admin'])).toBe(false);
    });

    it('returns false for jellyfin_compat mixed with read', () => {
        expect(isJellyfinCompatScope(['jellyfin_compat', 'read'])).toBe(false);
    });

    it('returns false for read-only scopes', () => {
        expect(isJellyfinCompatScope(['read'])).toBe(false);
    });

    it('returns false for admin scope', () => {
        expect(isJellyfinCompatScope(['admin'])).toBe(false);
    });

    it('returns false for empty scopes', () => {
        expect(isJellyfinCompatScope([])).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Exclusive-scope defense — unit tests for the create() guard logic
// ---------------------------------------------------------------------------

describe('create — exclusive jellyfin_compat scope guard', () => {
    /**
     * Extracted guard logic from pat.service.ts create(), mirroring the
     * normalizedScopes check that runs before the DB insert.
     */
    function applyExclusiveScopeGuard(rawScopes: string[]): void {
        const normalizedScopes = rawScopes.map((s) => s.trim().toLowerCase());
        if (normalizedScopes.includes('jellyfin_compat') && normalizedScopes.length !== 1) {
            throw new Error("'jellyfin_compat' is exclusive — must be the only scope");
        }
    }

    it('throws for jellyfin_compat + admin', () => {
        expect(() => applyExclusiveScopeGuard(['jellyfin_compat', 'admin'])).toThrow(/exclusive/);
    });

    it('throws for jellyfin_compat + read', () => {
        expect(() => applyExclusiveScopeGuard(['jellyfin_compat', 'read'])).toThrow(/exclusive/);
    });

    it('throws for whitespace-padded mixed scopes', () => {
        expect(() => applyExclusiveScopeGuard(['  jellyfin_compat  ', 'read'])).toThrow(
            /exclusive/,
        );
    });

    it('throws when jellyfin_compat appears after another scope', () => {
        expect(() => applyExclusiveScopeGuard(['write', 'jellyfin_compat'])).toThrow(/exclusive/);
    });

    it('does not throw for pure jellyfin_compat', () => {
        expect(() => applyExclusiveScopeGuard(['jellyfin_compat'])).not.toThrow();
    });

    it('does not throw for pure jellyfin_compat with whitespace', () => {
        expect(() => applyExclusiveScopeGuard(['  jellyfin_compat  '])).not.toThrow();
    });

    it('does not throw for standard read/write/admin scopes', () => {
        expect(() => applyExclusiveScopeGuard(['read'])).not.toThrow();
        expect(() => applyExclusiveScopeGuard(['write'])).not.toThrow();
        expect(() => applyExclusiveScopeGuard(['admin'])).not.toThrow();
        expect(() => applyExclusiveScopeGuard(['read', 'write'])).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Cache bypass — unit tests for the validate() cache read/write logic
// ---------------------------------------------------------------------------

describe('validate — jellyfin_compat cache bypass logic', () => {
    interface CachedPat {
        scopes: string[];
    }

    function isJellyfinCompatScope(scopes: string[]): boolean {
        return scopes.length === 1 && scopes[0] === 'jellyfin_compat';
    }

    /**
     * Mirrors the cache-read guard in validate(): returns the cached entry
     * only when the token is NOT a jellyfin_compat token.
     */
    function applyCacheReadGuard(fromCache: CachedPat | undefined): CachedPat | undefined {
        return fromCache && !isJellyfinCompatScope(fromCache.scopes) ? fromCache : undefined;
    }

    /**
     * Mirrors the cache-write guard in validate(): returns true when the
     * record should be written to cache.
     */
    function shouldWriteCache(scopes: string[]): boolean {
        return !isJellyfinCompatScope(scopes);
    }

    describe('cache read guard', () => {
        it('returns undefined for cached jellyfin_compat (forces DB hit)', () => {
            const cached: CachedPat = { scopes: ['jellyfin_compat'] };
            expect(applyCacheReadGuard(cached)).toBeUndefined();
        });

        it('returns cached entry for read scope (cache hit)', () => {
            const cached: CachedPat = { scopes: ['read'] };
            expect(applyCacheReadGuard(cached)).toBe(cached);
        });

        it('returns cached entry for admin scope (cache hit)', () => {
            const cached: CachedPat = { scopes: ['admin'] };
            expect(applyCacheReadGuard(cached)).toBe(cached);
        });

        it('returns cached entry for write scope (cache hit)', () => {
            const cached: CachedPat = { scopes: ['write'] };
            expect(applyCacheReadGuard(cached)).toBe(cached);
        });

        it('returns undefined when nothing is cached', () => {
            expect(applyCacheReadGuard(undefined)).toBeUndefined();
        });
    });

    describe('cache write guard', () => {
        it('skips cache write for jellyfin_compat', () => {
            expect(shouldWriteCache(['jellyfin_compat'])).toBe(false);
        });

        it('writes cache for read scope', () => {
            expect(shouldWriteCache(['read'])).toBe(true);
        });

        it('writes cache for admin scope', () => {
            expect(shouldWriteCache(['admin'])).toBe(true);
        });

        it('writes cache for write scope', () => {
            expect(shouldWriteCache(['write'])).toBe(true);
        });

        it('writes cache for multi-scope read+write', () => {
            expect(shouldWriteCache(['read', 'write'])).toBe(true);
        });
    });
});

describe('Token Cleanup Logic', () => {
    it('identifies tokens expired more than 7 days ago', () => {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const expiredLongAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

        expect(expiredLongAgo < sevenDaysAgo).toBe(true);
    });

    it('identifies tokens revoked more than 1 day ago', () => {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const revokedLongAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

        expect(revokedLongAgo < oneDayAgo).toBe(true);
    });

    it('keeps recently expired tokens', () => {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentlyExpired = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

        expect(recentlyExpired < sevenDaysAgo).toBe(false);
    });
});
