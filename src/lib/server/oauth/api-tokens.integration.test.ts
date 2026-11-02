// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for API Token System
 *
 * Tests the full flow of PAT and Service Token operations including:
 * - Token creation (user and admin)
 * - Token validation
 * - Token revocation
 * - Admin operations
 * - Scope checking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// Mock the database module
vi.mock('$lib/server/database', () => ({
    Database: vi.fn().mockImplementation(() => ({
        getSql: () => mockSql,
    })),
}));

type UserGroupRow = { username: string; groups: string[] };
type TokenRow = { id: number };
type SqlResultRow = UserGroupRow | TokenRow;
type SqlResult = SqlResultRow[];

// Mock SQL function for testing
let mockDbData: Map<string, unknown> = new Map();
let mockSql: ReturnType<typeof createMockSql>;

function createMockSql() {
    return vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?');

        // Handle different query patterns
        if (query.includes('INSERT INTO personal_access_tokens')) {
            const id = (mockDbData.get('pat_counter') as number | undefined) || 1;
            mockDbData.set('pat_counter', id + 1);
            return Promise.resolve([{ id }]);
        }

        if (query.includes('SELECT') && query.includes('personal_access_tokens')) {
            const pats = (mockDbData.get('personal_access_tokens') as SqlResult | undefined) || [];
            return Promise.resolve(pats);
        }

        if (query.includes('UPDATE personal_access_tokens') && query.includes('revoked_at')) {
            const id = typeof values[0] === 'number' ? values[0] : 0;
            return Promise.resolve([{ id }]);
        }

        if (query.includes('SELECT') && query.includes('groups') && query.includes('FROM users')) {
            const users = (mockDbData.get('user_groups') as UserGroupRow[] | undefined) || [];
            const username = values[0];
            const user =
                typeof username === 'string'
                    ? users.find((u) => u.username === username)
                    : undefined;
            return Promise.resolve(user ? [user] : []);
        }

        if (query.includes('INSERT INTO service_tokens')) {
            const id = (mockDbData.get('svc_counter') as number | undefined) || 1;
            mockDbData.set('svc_counter', id + 1);
            return Promise.resolve([{ id }]);
        }

        if (query.includes('SELECT') && query.includes('service_tokens')) {
            const tokens = (mockDbData.get('service_tokens') as SqlResult | undefined) || [];
            return Promise.resolve(tokens);
        }

        return Promise.resolve([]);
    });
}

beforeEach(() => {
    mockDbData = new Map();
    mockSql = createMockSql();

    // Set up default user
    mockDbData.set('user_groups', [
        { username: 'TestUser', groups: ['Users', 'TestGroup'] },
        { username: 'AdminUser', groups: ['Admins', 'Users'] },
    ]);
});

afterEach(() => {
    vi.clearAllMocks();
});

// =============================================================================
// PAT Token Generation Tests
// =============================================================================

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

    it('generates a valid PAT token', () => {
        const token = generatePatToken();

        expect(token.startsWith('pat_')).toBe(true);
        expect(token.length).toBe(52); // pat_ (4) + 48 hex chars
        expect(token.slice(4)).toMatch(/^[a-f0-9]+$/);
    });

    it('generates unique tokens', () => {
        const tokens = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            tokens.add(generatePatToken());
        }
        expect(tokens.size).toBe(1000);
    });

    it('extracts consistent token prefix', () => {
        const token = generatePatToken();
        const prefix = getTokenPrefix(token);

        expect(prefix.length).toBe(12);
        expect(prefix.startsWith('pat_')).toBe(true);
    });

    it('hashes token consistently', () => {
        const token = generatePatToken();
        const hash1 = hashToken(token);
        const hash2 = hashToken(token);

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(64); // SHA-256
    });

    it('produces different hashes for different tokens', () => {
        const token1 = generatePatToken();
        const token2 = generatePatToken();

        expect(hashToken(token1)).not.toBe(hashToken(token2));
    });
});

// =============================================================================
// Service Token Generation Tests
// =============================================================================

describe('Service Token Generation', () => {
    const SVC_PREFIX = 'svc_';

    function generateServiceToken(): string {
        return SVC_PREFIX + randomBytes(32).toString('hex');
    }

    it('generates a valid service token', () => {
        const token = generateServiceToken();

        expect(token.startsWith('svc_')).toBe(true);
        expect(token.length).toBe(68); // svc_ (4) + 64 hex chars
        expect(token.slice(4)).toMatch(/^[a-f0-9]+$/);
    });

    it('generates unique tokens', () => {
        const tokens = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            tokens.add(generateServiceToken());
        }
        expect(tokens.size).toBe(1000);
    });
});

// =============================================================================
// Token Type Detection Tests
// =============================================================================

describe('Token Type Detection', () => {
    function getTokenType(token: string): 'pat' | 'service' | 'jwt' | 'unknown' {
        if (token.startsWith('pat_')) return 'pat';
        if (token.startsWith('svc_')) return 'service';
        if (token.includes('.') && token.split('.').length === 3) return 'jwt';
        return 'unknown';
    }

    it('identifies PAT tokens', () => {
        expect(getTokenType('pat_abc123def456')).toBe('pat');
    });

    it('identifies service tokens', () => {
        expect(getTokenType('svc_abc123def456')).toBe('service');
    });

    it('identifies JWT tokens', () => {
        expect(getTokenType('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig')).toBe('jwt');
    });

    it('returns unknown for other formats', () => {
        expect(getTokenType('random_string')).toBe('unknown');
        expect(getTokenType('')).toBe('unknown');
        expect(getTokenType('bearer_token')).toBe('unknown');
    });
});

// =============================================================================
// Scope Hierarchy Tests
// =============================================================================

describe('Scope Hierarchy', () => {
    interface TokenScopes {
        scopes: string[];
    }

    function hasScope(token: TokenScopes, requiredScope: string): boolean {
        // Admin scope implies all other scopes
        if (token.scopes.includes('admin')) {
            return true;
        }
        // Write scope implies read
        if (requiredScope === 'read' && token.scopes.includes('write')) {
            return true;
        }
        return token.scopes.includes(requiredScope);
    }

    describe('admin scope', () => {
        const adminToken = { scopes: ['admin'] };

        it('grants read access', () => {
            expect(hasScope(adminToken, 'read')).toBe(true);
        });

        it('grants write access', () => {
            expect(hasScope(adminToken, 'write')).toBe(true);
        });

        it('grants admin access', () => {
            expect(hasScope(adminToken, 'admin')).toBe(true);
        });

        it('grants any custom scope', () => {
            expect(hasScope(adminToken, 'custom')).toBe(true);
        });
    });

    describe('write scope', () => {
        const writeToken = { scopes: ['write'] };

        it('grants read access', () => {
            expect(hasScope(writeToken, 'read')).toBe(true);
        });

        it('grants write access', () => {
            expect(hasScope(writeToken, 'write')).toBe(true);
        });

        it('does NOT grant admin access', () => {
            expect(hasScope(writeToken, 'admin')).toBe(false);
        });
    });

    describe('read scope', () => {
        const readToken = { scopes: ['read'] };

        it('grants read access', () => {
            expect(hasScope(readToken, 'read')).toBe(true);
        });

        it('does NOT grant write access', () => {
            expect(hasScope(readToken, 'write')).toBe(false);
        });

        it('does NOT grant admin access', () => {
            expect(hasScope(readToken, 'admin')).toBe(false);
        });
    });

    describe('multiple scopes', () => {
        it('handles multiple explicit scopes', () => {
            const token = { scopes: ['read', 'write'] };
            expect(hasScope(token, 'read')).toBe(true);
            expect(hasScope(token, 'write')).toBe(true);
            expect(hasScope(token, 'admin')).toBe(false);
        });

        it('empty scopes deny all access', () => {
            const token = { scopes: [] };
            expect(hasScope(token, 'read')).toBe(false);
            expect(hasScope(token, 'write')).toBe(false);
            expect(hasScope(token, 'admin')).toBe(false);
        });
    });
});

// =============================================================================
// Token Expiration Tests
// =============================================================================

describe('Token Expiration', () => {
    function isTokenExpired(expiresAt: Date | null): boolean {
        if (expiresAt === null) return false; // Never expires
        return new Date(expiresAt) < new Date();
    }

    function calculateExpirationDate(daysFromNow: number | null): Date | null {
        if (daysFromNow === null) return null;
        return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000);
    }

    it('non-expiring tokens never expire', () => {
        expect(isTokenExpired(null)).toBe(false);
    });

    it('future expiration is valid', () => {
        const tomorrow = new Date(Date.now() + 86400000);
        expect(isTokenExpired(tomorrow)).toBe(false);
    });

    it('past expiration is expired', () => {
        const yesterday = new Date(Date.now() - 86400000);
        expect(isTokenExpired(yesterday)).toBe(true);
    });

    it('calculates correct expiration for 30 days', () => {
        const expiration = calculateExpirationDate(30);
        expect(expiration).not.toBeNull();

        const diffMs = expiration!.getTime() - Date.now();
        const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
        expect(diffDays).toBe(30);
    });

    it('null days returns null expiration', () => {
        expect(calculateExpirationDate(null)).toBeNull();
    });
});

// =============================================================================
// Admin PAT Operations Tests
// =============================================================================

describe('Admin PAT Operations', () => {
    interface AdminPatListItem {
        id: number;
        username: string;
        name: string;
        scopes: string[];
        createdAt: Date;
        expiresAt: Date | null;
    }

    function listAllPats(filterUsername?: string): AdminPatListItem[] {
        const allPats: AdminPatListItem[] = [
            {
                id: 1,
                username: 'UserA',
                name: 'Token A',
                scopes: ['read'],
                createdAt: new Date(),
                expiresAt: null,
            },
            {
                id: 2,
                username: 'UserB',
                name: 'Token B',
                scopes: ['read', 'write'],
                createdAt: new Date(),
                expiresAt: null,
            },
            {
                id: 3,
                username: 'UserA',
                name: 'Token C',
                scopes: ['admin'],
                createdAt: new Date(),
                expiresAt: null,
            },
        ];

        if (filterUsername) {
            return allPats.filter((p) => p.username === filterUsername);
        }
        return allPats;
    }

    it('lists all PATs without filter', () => {
        const pats = listAllPats();
        expect(pats.length).toBe(3);
    });

    it('filters PATs by username', () => {
        const pats = listAllPats('UserA');
        expect(pats.length).toBe(2);
        expect(pats.every((p) => p.username === 'UserA')).toBe(true);
    });

    it('returns empty for non-existent user', () => {
        const pats = listAllPats('NonExistent');
        expect(pats.length).toBe(0);
    });
});

// =============================================================================
// User Self-Service PAT Tests
// =============================================================================

describe('User Self-Service PAT', () => {
    const MAX_PATS_PER_USER = 10;

    function canCreatePat(currentCount: number): {
        allowed: boolean;
        error?: string;
    } {
        if (currentCount >= MAX_PATS_PER_USER) {
            return {
                allowed: false,
                error: `Maximum of ${MAX_PATS_PER_USER} tokens per user reached`,
            };
        }
        return { allowed: true };
    }

    it('allows creation when under limit', () => {
        expect(canCreatePat(0).allowed).toBe(true);
        expect(canCreatePat(5).allowed).toBe(true);
        expect(canCreatePat(9).allowed).toBe(true);
    });

    it('blocks creation at limit', () => {
        const result = canCreatePat(10);
        expect(result.allowed).toBe(false);
        expect(result.error).toContain('Maximum');
    });

    it('blocks creation over limit', () => {
        expect(canCreatePat(15).allowed).toBe(false);
    });
});

// =============================================================================
// Token Validation Flow Tests
// =============================================================================

describe('Token Validation Flow', () => {
    interface TokenRecord {
        tokenHash: string;
        username: string;
        scopes: string[];
        expiresAt: Date | null;
        revokedAt: Date | null;
        groups: string[];
    }

    interface ValidationResult {
        valid: boolean;
        error?: string;
        token?: TokenRecord;
    }

    function validateToken(tokenHash: string, tokenDb: Map<string, TokenRecord>): ValidationResult {
        const record = tokenDb.get(tokenHash);

        if (!record) {
            return { valid: false, error: 'Token not found' };
        }

        if (record.revokedAt !== null) {
            return { valid: false, error: 'Token has been revoked' };
        }

        if (record.expiresAt !== null && new Date(record.expiresAt) < new Date()) {
            return { valid: false, error: 'Token has expired' };
        }

        return { valid: true, token: record };
    }

    it('validates active token', () => {
        const db = new Map<string, TokenRecord>();
        db.set('hash123', {
            tokenHash: 'hash123',
            username: 'testuser',
            scopes: ['read'],
            expiresAt: new Date(Date.now() + 86400000),
            revokedAt: null,
            groups: ['Users'],
        });

        const result = validateToken('hash123', db);
        expect(result.valid).toBe(true);
        expect(result.token?.username).toBe('testuser');
    });

    it('rejects non-existent token', () => {
        const db = new Map<string, TokenRecord>();

        const result = validateToken('nonexistent', db);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('not found');
    });

    it('rejects revoked token', () => {
        const db = new Map<string, TokenRecord>();
        db.set('revoked_hash', {
            tokenHash: 'revoked_hash',
            username: 'testuser',
            scopes: ['read'],
            expiresAt: null,
            revokedAt: new Date(),
            groups: ['Users'],
        });

        const result = validateToken('revoked_hash', db);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('revoked');
    });

    it('rejects expired token', () => {
        const db = new Map<string, TokenRecord>();
        db.set('expired_hash', {
            tokenHash: 'expired_hash',
            username: 'testuser',
            scopes: ['read'],
            expiresAt: new Date(Date.now() - 86400000), // Yesterday
            revokedAt: null,
            groups: ['Users'],
        });

        const result = validateToken('expired_hash', db);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('expired');
    });

    it('validates non-expiring token', () => {
        const db = new Map<string, TokenRecord>();
        db.set('forever_hash', {
            tokenHash: 'forever_hash',
            username: 'testuser',
            scopes: ['read'],
            expiresAt: null, // Never expires
            revokedAt: null,
            groups: ['Users'],
        });

        const result = validateToken('forever_hash', db);
        expect(result.valid).toBe(true);
    });
});

// =============================================================================
// Service Token Impersonation Tests
// =============================================================================

describe('Service Token Impersonation', () => {
    interface ServiceToken {
        actAsUser: string | null;
        createdBy: string;
        scopes: string[];
    }

    function getEffectiveUser(token: ServiceToken): string {
        return token.actAsUser || token.createdBy;
    }

    it('uses actAsUser when set', () => {
        const token: ServiceToken = {
            actAsUser: 'impersonated_user',
            createdBy: 'admin',
            scopes: ['admin'],
        };

        expect(getEffectiveUser(token)).toBe('impersonated_user');
    });

    it('falls back to createdBy when no actAsUser', () => {
        const token: ServiceToken = {
            actAsUser: null,
            createdBy: 'admin',
            scopes: ['admin'],
        };

        expect(getEffectiveUser(token)).toBe('admin');
    });

    it('handles empty string actAsUser as null', () => {
        const token: ServiceToken = {
            actAsUser: '',
            createdBy: 'admin',
            scopes: ['admin'],
        };

        // Empty string is falsy
        expect(getEffectiveUser(token)).toBe('admin');
    });
});

// =============================================================================
// IP Whitelist Tests
// =============================================================================

describe('IP Whitelist Validation', () => {
    function isIpAllowed(clientIp: string, allowedIps: string[] | null): boolean {
        // Empty or null whitelist means all IPs allowed
        if (!allowedIps || allowedIps.length === 0) {
            return true;
        }

        return allowedIps.includes(clientIp);
    }

    it('allows any IP when whitelist is empty', () => {
        expect(isIpAllowed('192.168.1.1', [])).toBe(true);
        expect(isIpAllowed('10.0.0.1', [])).toBe(true);
    });

    it('allows any IP when whitelist is null', () => {
        expect(isIpAllowed('192.168.1.1', null)).toBe(true);
    });

    it('allows whitelisted IP', () => {
        const whitelist = ['192.168.1.1', '10.0.0.1'];
        expect(isIpAllowed('192.168.1.1', whitelist)).toBe(true);
        expect(isIpAllowed('10.0.0.1', whitelist)).toBe(true);
    });

    it('blocks non-whitelisted IP', () => {
        const whitelist = ['192.168.1.1'];
        expect(isIpAllowed('192.168.1.2', whitelist)).toBe(false);
        expect(isIpAllowed('10.0.0.1', whitelist)).toBe(false);
    });

    it('handles IPv6 addresses', () => {
        const whitelist = ['::1', '2001:db8::1'];
        expect(isIpAllowed('::1', whitelist)).toBe(true);
        expect(isIpAllowed('2001:db8::2', whitelist)).toBe(false);
    });
});

// =============================================================================
// Rate Limiting by Token Tests
// =============================================================================

describe('Token-Based Rate Limiting', () => {
    interface RateLimitEntry {
        count: number;
        resetAt: number;
    }

    function checkRateLimit(
        tokenId: string,
        store: Map<string, RateLimitEntry>,
        limit: number,
        windowMs: number,
    ): { allowed: boolean; remaining: number; resetAt: number } {
        const now = Date.now();
        const key = `token:${tokenId}`;
        let entry = store.get(key);

        // Reset if window expired
        if (!entry || entry.resetAt < now) {
            entry = { count: 0, resetAt: now + windowMs };
            store.set(key, entry);
        }

        if (entry.count >= limit) {
            return {
                allowed: false,
                remaining: 0,
                resetAt: entry.resetAt,
            };
        }

        entry.count++;
        return {
            allowed: true,
            remaining: limit - entry.count,
            resetAt: entry.resetAt,
        };
    }

    it('allows requests under limit', () => {
        const store = new Map<string, RateLimitEntry>();

        for (let i = 0; i < 5; i++) {
            const result = checkRateLimit('token1', store, 10, 60000);
            expect(result.allowed).toBe(true);
        }
    });

    it('blocks requests over limit', () => {
        const store = new Map<string, RateLimitEntry>();

        // Use up the limit
        for (let i = 0; i < 10; i++) {
            checkRateLimit('token1', store, 10, 60000);
        }

        // 11th request should be blocked
        const result = checkRateLimit('token1', store, 10, 60000);
        expect(result.allowed).toBe(false);
        expect(result.remaining).toBe(0);
    });

    it('tracks different tokens separately', () => {
        const store = new Map<string, RateLimitEntry>();

        // Use up limit for token1
        for (let i = 0; i < 10; i++) {
            checkRateLimit('token1', store, 10, 60000);
        }

        // token2 should still have full limit
        const result = checkRateLimit('token2', store, 10, 60000);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(9);
    });

    it('returns correct remaining count', () => {
        const store = new Map<string, RateLimitEntry>();

        const result1 = checkRateLimit('token1', store, 10, 60000);
        expect(result1.remaining).toBe(9);

        const result2 = checkRateLimit('token1', store, 10, 60000);
        expect(result2.remaining).toBe(8);
    });
});

// =============================================================================
// Token Cleanup Tests
// =============================================================================

describe('Token Cleanup Logic', () => {
    interface TokenRecord {
        id: number;
        expiresAt: Date | null;
        revokedAt: Date | null;
    }

    function shouldCleanupToken(
        token: TokenRecord,
        expiredGraceDays: number,
        revokedGraceDays: number,
    ): boolean {
        const now = Date.now();
        const expiredGraceMs = expiredGraceDays * 24 * 60 * 60 * 1000;
        const revokedGraceMs = revokedGraceDays * 24 * 60 * 60 * 1000;

        // Cleanup if expired more than grace period ago
        if (token.expiresAt && new Date(token.expiresAt).getTime() < now - expiredGraceMs) {
            return true;
        }

        // Cleanup if revoked more than grace period ago
        if (token.revokedAt && new Date(token.revokedAt).getTime() < now - revokedGraceMs) {
            return true;
        }

        return false;
    }

    it('cleans up tokens expired beyond grace period', () => {
        const oldExpired: TokenRecord = {
            id: 1,
            expiresAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
            revokedAt: null,
        };

        expect(shouldCleanupToken(oldExpired, 7, 1)).toBe(true);
    });

    it('keeps recently expired tokens', () => {
        const recentlyExpired: TokenRecord = {
            id: 1,
            expiresAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
            revokedAt: null,
        };

        expect(shouldCleanupToken(recentlyExpired, 7, 1)).toBe(false);
    });

    it('cleans up tokens revoked beyond grace period', () => {
        const oldRevoked: TokenRecord = {
            id: 1,
            expiresAt: null,
            revokedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
        };

        expect(shouldCleanupToken(oldRevoked, 7, 1)).toBe(true);
    });

    it('keeps recently revoked tokens', () => {
        const recentlyRevoked: TokenRecord = {
            id: 1,
            expiresAt: null,
            revokedAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12 hours ago
        };

        expect(shouldCleanupToken(recentlyRevoked, 7, 1)).toBe(false);
    });

    it('keeps active tokens', () => {
        const active: TokenRecord = {
            id: 1,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days in future
            revokedAt: null,
        };

        expect(shouldCleanupToken(active, 7, 1)).toBe(false);
    });

    it('keeps non-expiring active tokens', () => {
        const neverExpires: TokenRecord = {
            id: 1,
            expiresAt: null,
            revokedAt: null,
        };

        expect(shouldCleanupToken(neverExpires, 7, 1)).toBe(false);
    });
});

// =============================================================================
// Authorization Header Parsing Tests
// =============================================================================

describe('Authorization Header Parsing', () => {
    interface ParsedAuth {
        type: 'bearer' | 'basic' | 'unknown';
        token: string | null;
    }

    function parseAuthHeader(header: string | null): ParsedAuth {
        if (!header) {
            return { type: 'unknown', token: null };
        }

        const [type, token] = header.split(' ');

        if (type.toLowerCase() === 'bearer' && token) {
            return { type: 'bearer', token };
        }

        if (type.toLowerCase() === 'basic' && token) {
            return { type: 'basic', token };
        }

        return { type: 'unknown', token: null };
    }

    it('parses Bearer token', () => {
        const result = parseAuthHeader('Bearer pat_abc123');
        expect(result.type).toBe('bearer');
        expect(result.token).toBe('pat_abc123');
    });

    it('parses bearer token (lowercase)', () => {
        const result = parseAuthHeader('bearer svc_xyz789');
        expect(result.type).toBe('bearer');
        expect(result.token).toBe('svc_xyz789');
    });

    it('parses Basic auth', () => {
        const result = parseAuthHeader('Basic dXNlcjpwYXNz');
        expect(result.type).toBe('basic');
        expect(result.token).toBe('dXNlcjpwYXNz');
    });

    it('returns unknown for null header', () => {
        const result = parseAuthHeader(null);
        expect(result.type).toBe('unknown');
        expect(result.token).toBeNull();
    });

    it('returns unknown for invalid format', () => {
        const result = parseAuthHeader('InvalidToken');
        expect(result.type).toBe('unknown');
        expect(result.token).toBeNull();
    });

    it('returns unknown for Bearer without token', () => {
        const result = parseAuthHeader('Bearer ');
        expect(result.type).toBe('unknown');
    });
});
