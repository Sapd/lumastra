// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Service Token Service
 *
 * Tests token generation, validation, IP whitelisting, and utility functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { normalizeIp } from './ip-literal.js';

// ── Mocks for the ServiceTokenService.validate() creator-status suite below ──
// (kept at module scope so vi.mock's hoisting applies before the real class
// is imported further down in this file).
const mockSql = vi.fn();
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return mockSql;
        }
    },
}));
const mockLogWarn = vi.hoisted(() => vi.fn());
vi.mock('../utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));
vi.mock('$lib/server/utils/public-author.js', () => ({
    loadPublicAuthors: async () => new Map(),
}));

// ── Mocks for the narrowing/restore eviction suites below (fix-plan-5 Task 9,
// carried C2/C3) — assert on the observable cross-replica broadcast rather
// than reaching into the private LRU cache field.
const mockPublishAuthCacheInvalidation = vi.fn();
vi.mock('$lib/server/cache/auth-cache-bus.js', () => ({
    publishAuthCacheInvalidation: (...a: unknown[]) => mockPublishAuthCacheInvalidation(...a),
    onRemoteTokenNarrowedInvalidate: () => {},
    onAuthCacheBusResync: () => {},
}));

// Test the pure utility functions by extracting them
const SVC_PREFIX = 'svc_';

function generateServiceToken(): string {
    return SVC_PREFIX + randomBytes(24).toString('hex');
}

function getTokenPrefix(token: string): string {
    return token.substring(0, 12);
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function isServiceToken(token: string): boolean {
    return token.startsWith(SVC_PREFIX);
}

describe('Service Token Generation', () => {
    describe('generateServiceToken', () => {
        it('generates token with correct prefix', () => {
            const token = generateServiceToken();
            expect(token.startsWith('svc_')).toBe(true);
        });

        it('generates token with correct length (52 chars)', () => {
            const token = generateServiceToken();
            // svc_ (4) + 48 hex chars = 52 total
            expect(token.length).toBe(52);
        });

        it('generates unique tokens', () => {
            const tokens = new Set<string>();
            for (let i = 0; i < 100; i++) {
                tokens.add(generateServiceToken());
            }
            expect(tokens.size).toBe(100);
        });

        it('generates only valid hex characters after prefix', () => {
            const token = generateServiceToken();
            const hexPart = token.slice(4);
            expect(hexPart).toMatch(/^[a-f0-9]+$/);
        });
    });

    describe('getTokenPrefix', () => {
        it('extracts first 12 characters', () => {
            const token = 'svc_abc123def456xyz';
            expect(getTokenPrefix(token)).toBe('svc_abc123de');
        });

        it('handles exact length token', () => {
            const token = 'svc_12345678';
            expect(getTokenPrefix(token)).toBe('svc_12345678');
        });
    });

    describe('hashToken', () => {
        it('produces consistent hash for same input', () => {
            const token = 'svc_test123456789';
            const hash1 = hashToken(token);
            const hash2 = hashToken(token);
            expect(hash1).toBe(hash2);
        });

        it('produces different hash for different input', () => {
            const hash1 = hashToken('svc_token1');
            const hash2 = hashToken('svc_token2');
            expect(hash1).not.toBe(hash2);
        });

        it('produces 64-character hex string (SHA-256)', () => {
            const hash = hashToken('svc_anytoken');
            expect(hash.length).toBe(64);
            expect(hash).toMatch(/^[a-f0-9]+$/);
        });
    });
});

describe('Service Token Type Detection', () => {
    it('returns true for valid service token', () => {
        expect(isServiceToken('svc_abc123def456')).toBe(true);
    });

    it('returns false for PAT token', () => {
        expect(isServiceToken('pat_abc123def456')).toBe(false);
    });

    it('returns false for JWT-like token', () => {
        expect(
            isServiceToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0'),
        ).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isServiceToken('')).toBe(false);
    });

    it('returns false for partial prefix', () => {
        expect(isServiceToken('svc')).toBe(false);
        expect(isServiceToken('sv')).toBe(false);
    });

    it('is case sensitive', () => {
        expect(isServiceToken('SVC_abc123')).toBe(false);
        expect(isServiceToken('Svc_abc123')).toBe(false);
    });
});

describe('IP Whitelist Validation', () => {
    interface ServiceTokenWithIps {
        allowedIps: string[] | null;
    }

    function isIpAllowed(token: ServiceTokenWithIps, clientIp: string | undefined): boolean {
        // No whitelist means all IPs allowed
        if (!token.allowedIps || token.allowedIps.length === 0) {
            return true;
        }
        // If whitelist exists but no client IP, reject
        if (!clientIp) {
            return false;
        }
        // Check if client IP is in whitelist
        return token.allowedIps.includes(clientIp);
    }

    describe('empty whitelist', () => {
        it('allows any IP when whitelist is null', () => {
            const token = { allowedIps: null };
            expect(isIpAllowed(token, '192.168.1.100')).toBe(true);
        });

        it('allows any IP when whitelist is empty array', () => {
            const token = { allowedIps: [] };
            expect(isIpAllowed(token, '192.168.1.100')).toBe(true);
        });

        it('allows when no client IP and no whitelist', () => {
            const token = { allowedIps: null };
            expect(isIpAllowed(token, undefined)).toBe(true);
        });
    });

    describe('configured whitelist', () => {
        it('allows IP in whitelist', () => {
            const token = { allowedIps: ['192.168.1.100', '10.0.0.1'] };
            expect(isIpAllowed(token, '192.168.1.100')).toBe(true);
        });

        it('rejects IP not in whitelist', () => {
            const token = { allowedIps: ['192.168.1.100', '10.0.0.1'] };
            expect(isIpAllowed(token, '192.168.1.200')).toBe(false);
        });

        it('rejects when no client IP provided but whitelist exists', () => {
            const token = { allowedIps: ['192.168.1.100'] };
            expect(isIpAllowed(token, undefined)).toBe(false);
        });

        it('handles IPv6 addresses', () => {
            const token = { allowedIps: ['::1', '2001:db8::1'] };
            expect(isIpAllowed(token, '::1')).toBe(true);
            expect(isIpAllowed(token, '2001:db8::2')).toBe(false);
        });
    });

    describe('edge cases', () => {
        it('compares IPv6 addresses in canonical form, not as typed', () => {
            const token = { allowedIps: ['2001:DB8::1'].map(normalizeIp) };
            expect(isIpAllowed(token, normalizeIp('2001:db8::1'))).toBe(true);
        });

        it('handles single IP whitelist', () => {
            const token = { allowedIps: ['127.0.0.1'] };
            expect(isIpAllowed(token, '127.0.0.1')).toBe(true);
            expect(isIpAllowed(token, '127.0.0.2')).toBe(false);
        });
    });
});

describe('IP Address Validation', () => {
    // IPv4 validation function from the API endpoint
    function isValidIPv4(ip: string): boolean {
        const parts = ip.split('.');
        if (parts.length !== 4) return false;
        return parts.every((part) => {
            const num = parseInt(part, 10);
            return !isNaN(num) && num >= 0 && num <= 255 && part === String(num);
        });
    }

    // IPv6 validation function from the API endpoint
    function isValidIPv6(ip: string): boolean {
        const ipv6Regex =
            /^([a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^([a-fA-F0-9]{1,4}:){1,7}:$|^([a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}$|^([a-fA-F0-9]{1,4}:){1,5}(:[a-fA-F0-9]{1,4}){1,2}$|^([a-fA-F0-9]{1,4}:){1,4}(:[a-fA-F0-9]{1,4}){1,3}$|^([a-fA-F0-9]{1,4}:){1,3}(:[a-fA-F0-9]{1,4}){1,4}$|^([a-fA-F0-9]{1,4}:){1,2}(:[a-fA-F0-9]{1,4}){1,5}$|^[a-fA-F0-9]{1,4}:(:[a-fA-F0-9]{1,4}){1,6}$|^:(:[a-fA-F0-9]{1,4}){1,7}$|^::$/;
        return ipv6Regex.test(ip);
    }

    describe('IPv4 validation', () => {
        it('accepts valid IPv4 addresses', () => {
            expect(isValidIPv4('192.168.1.1')).toBe(true);
            expect(isValidIPv4('10.0.0.1')).toBe(true);
            expect(isValidIPv4('0.0.0.0')).toBe(true);
            expect(isValidIPv4('255.255.255.255')).toBe(true);
            expect(isValidIPv4('127.0.0.1')).toBe(true);
        });

        it('rejects invalid IPv4 addresses', () => {
            expect(isValidIPv4('256.1.1.1')).toBe(false); // Octet > 255
            expect(isValidIPv4('192.168.1')).toBe(false); // Missing octet
            expect(isValidIPv4('192.168.1.1.1')).toBe(false); // Too many octets
            expect(isValidIPv4('192.168.1.a')).toBe(false); // Non-numeric
            expect(isValidIPv4('192.168.01.1')).toBe(false); // Leading zero
            expect(isValidIPv4('')).toBe(false); // Empty
            expect(isValidIPv4('192.168.1.-1')).toBe(false); // Negative
        });

        it('rejects IPv4 with leading zeros (octal ambiguity)', () => {
            expect(isValidIPv4('192.168.001.001')).toBe(false);
            expect(isValidIPv4('01.02.03.04')).toBe(false);
        });
    });

    describe('IPv6 validation', () => {
        it('accepts valid IPv6 addresses', () => {
            expect(isValidIPv6('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(true);
            expect(isValidIPv6('2001:db8:85a3::8a2e:370:7334')).toBe(true);
            expect(isValidIPv6('::1')).toBe(true);
            expect(isValidIPv6('::')).toBe(true);
            expect(isValidIPv6('fe80::')).toBe(true);
        });

        it('rejects invalid IPv6 addresses', () => {
            expect(isValidIPv6('192.168.1.1')).toBe(false); // IPv4
            expect(isValidIPv6('2001:db8:85a3:::1')).toBe(false); // Triple colon
            expect(isValidIPv6('2001:db8:85a3:0000:0000:8a2e:0370:7334:extra')).toBe(false); // Too many groups
            expect(isValidIPv6('')).toBe(false); // Empty
        });
    });
});

describe('Service Token Validation Logic', () => {
    describe('token prefix validation', () => {
        it('rejects tokens without svc_ prefix', () => {
            const token = 'pat_abc123';
            expect(token.startsWith('svc_')).toBe(false);
        });

        it('accepts tokens with svc_ prefix', () => {
            const token = 'svc_abc123';
            expect(token.startsWith('svc_')).toBe(true);
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
            expect(expiresAt === null).toBe(true);
        });
    });
});

describe('Service Token Creation', () => {
    const MAX_SERVICE_TOKENS = 100;

    describe('token count limits', () => {
        it('allows creation when under limit', () => {
            const currentCount = 50;
            expect(currentCount < MAX_SERVICE_TOKENS).toBe(true);
        });

        it('blocks creation at limit', () => {
            const currentCount = 100;
            expect(currentCount >= MAX_SERVICE_TOKENS).toBe(true);
        });

        it('blocks creation over limit', () => {
            const currentCount = 150;
            expect(currentCount >= MAX_SERVICE_TOKENS).toBe(true);
        });
    });

    describe('default scopes', () => {
        it('defaults to admin scope when not specified', () => {
            const providedScopes: string[] | undefined = undefined;
            const scopes = providedScopes || ['admin'];
            expect(scopes).toEqual(['admin']);
        });

        it('uses provided scopes when specified', () => {
            const providedScopes = ['read', 'write'];
            const scopes = providedScopes || ['admin'];
            expect(scopes).toEqual(['read', 'write']);
        });
    });

    describe('expiration calculation', () => {
        it('calculates correct expiration for days', () => {
            const now = Date.now();
            const expiresInDays = 90;
            const expiresAt = new Date(now + expiresInDays * 24 * 60 * 60 * 1000);

            const diffMs = expiresAt.getTime() - now;
            const diffDays = diffMs / (24 * 60 * 60 * 1000);
            expect(Math.round(diffDays)).toBe(90);
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
});

describe('Service Token List Item Mapping', () => {
    it('correctly identifies expired tokens', () => {
        const now = new Date();

        // Expired token
        const expiredRecord = {
            expires_at: new Date(now.getTime() - 86400000),
        };
        const isExpired1 = expiredRecord.expires_at
            ? new Date(expiredRecord.expires_at) < now
            : false;
        expect(isExpired1).toBe(true);

        // Valid token
        const validRecord = {
            expires_at: new Date(now.getTime() + 86400000),
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

    it('handles null values gracefully', () => {
        const record = {
            scopes: null,
            allowed_ips: null,
            act_as_user: null,
            description: null,
        };

        const scopes = record.scopes || [];
        const allowedIps = record.allowed_ips || null;

        expect(scopes).toEqual([]);
        expect(allowedIps).toBe(null);
    });
});

describe('Service Token Admin Context', () => {
    it('creates admin context with correct properties', () => {
        const tokenName = 'monitoring-dashboard';
        const userContext = {
            username: `service:${tokenName}`,
            groups: 'admin',
            userGroups: ['admin'],
            hasWatchPermission: true,
            hasLiveTvPermission: true,
            isAdmin: true,
            isAgeRestricted: false,
        };

        expect(userContext.username).toBe('service:monitoring-dashboard');
        expect(userContext.isAdmin).toBe(true);
        expect(userContext.hasWatchPermission).toBe(true);
        expect(userContext.hasLiveTvPermission).toBe(true);
        expect(userContext.isAgeRestricted).toBe(false);
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

describe('Token Length Validation', () => {
    const MAX_TOKEN_LENGTH = 500;

    it('accepts tokens under limit', () => {
        const token = 'svc_' + 'a'.repeat(48);
        expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
    });

    it('rejects tokens over limit', () => {
        const token = 'a'.repeat(501);
        expect(token.length).toBeGreaterThan(MAX_TOKEN_LENGTH);
    });

    it('normal tokens are well under limit', () => {
        const patToken = generateServiceToken();
        expect(patToken.length).toBe(52);
        expect(patToken.length).toBeLessThan(MAX_TOKEN_LENGTH);
    });
});

// ---------------------------------------------------------------------------
// validate() — creator disabled/deleted gate (final fix wave, security review
// 2026-09-13). A service token acts with the authority of the admin who
// created it (non-impersonating: directly; impersonating: the creator's
// authority to impersonate). If that creator is later disabled or
// soft-deleted, the token must stop validating — mirrors PatService's owner
// check (Task 2). Implemented ONCE in validate() (not in each of forward-auth
// / mount.ts / middleware/auth.ts / tasks/api-auth.ts) so every consumer
// inherits it automatically.
// ---------------------------------------------------------------------------
import { ServiceTokenService } from './service-token.service.js';

const OWNER_ID = '0d000000-0000-4000-8000-000000000001';

interface FakeTokenRow {
    id?: number;
    token_hash?: string;
    token_prefix?: string;
    name?: string;
    description?: string | null;
    created_by?: string;
    owner_user_id?: string | null;
    act_as_user?: string | null;
    scopes?: string[];
    allowed_ips?: string[] | null;
    allowed_path_prefixes?: string[] | null;
    allowed_methods?: string[] | null;
    force_non_admin?: boolean;
    created_at?: Date;
    expires_at?: Date | null;
    revoked_at?: Date | null;
    last_used_at?: Date | null;
    last_used_ip?: string | null;
    usage_count?: number;
}

function makeTokenRow(overrides: FakeTokenRow = {}): FakeTokenRow {
    return {
        id: 1,
        token_hash: 'hash',
        token_prefix: 'svc_abcdefgh',
        name: 'ci-token',
        description: null,
        created_by: 'the-admin',
        owner_user_id: OWNER_ID,
        act_as_user: null,
        scopes: ['admin'],
        allowed_ips: null,
        allowed_path_prefixes: null,
        allowed_methods: null,
        force_non_admin: false,
        created_at: new Date(),
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
        last_used_ip: null,
        usage_count: 0,
        ...overrides,
    };
}

/**
 * Builds a fake `sql` tagged-template function that routes on the query
 * text, mirroring how `postgres`'s `sql` is invoked (`sql\`...\`` calls the
 * function with the template's strings array as the first argument).
 */
function makeFakeSql(opts: { tokenRows: FakeTokenRow[]; creatorRows: unknown[] }) {
    return vi.fn(async (strings: TemplateStringsArray) => {
        const text = strings.join('');
        if (text.includes('FROM service_tokens') && text.includes('token_hash')) {
            return opts.tokenRows;
        }
        if (text.includes('FROM users')) {
            return opts.creatorRows;
        }
        // UPDATE service_tokens (usage tracking) and anything else — no-op.
        return [];
    });
}

describe('ServiceTokenService.validate() — creator disabled/deleted gate', () => {
    beforeEach(() => {
        mockSql.mockReset();
    });

    it('denies a token whose creator is disabled (cache-miss / DB path)', async () => {
        const sql = makeFakeSql({
            tokenRows: [makeTokenRow()],
            creatorRows: [{ disabled_at: new Date(), deleted_at: null }],
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const result = await svc.validate('svc_' + 'a'.repeat(48));

        expect(result).toBeNull();
    });

    it('denies a token whose creator is soft-deleted', async () => {
        const sql = makeFakeSql({
            tokenRows: [makeTokenRow()],
            creatorRows: [{ disabled_at: null, deleted_at: new Date() }],
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const result = await svc.validate('svc_' + 'b'.repeat(48));

        expect(result).toBeNull();
    });

    it('denies a token whose creator no longer exists', async () => {
        const sql = makeFakeSql({
            tokenRows: [makeTokenRow()],
            creatorRows: [],
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const result = await svc.validate('svc_' + 'c'.repeat(48));

        expect(result).toBeNull();
    });

    it('validates a token whose creator is active', async () => {
        const sql = makeFakeSql({
            tokenRows: [makeTokenRow()],
            creatorRows: [{ disabled_at: null, deleted_at: null }],
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const result = await svc.validate('svc_' + 'd'.repeat(48));

        expect(result).not.toBeNull();
        expect(result?.createdBy).toBe('the-admin');
        expect(result?.ownerUserId).toBe(OWNER_ID);
    });

    // API package 15: the owner is `owner_user_id`, never the `created_by` label.
    it('looks the owner up by owner_user_id, not by the created_by username', async () => {
        const queries: Array<{ text: string; values: unknown[] }> = [];
        mockSql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = strings.join('');
            queries.push({ text, values });
            if (text.includes('FROM service_tokens') && text.includes('token_hash')) {
                return [makeTokenRow({ created_by: 'someone-else-now' })];
            }
            if (text.includes('FROM users')) return [{ disabled_at: null, deleted_at: null }];
            return [];
        });

        const svc = new ServiceTokenService();
        expect(await svc.validate('svc_' + '1'.repeat(48))).not.toBeNull();

        const ownerQuery = queries.find((q) => q.text.includes('FROM users'));
        expect(ownerQuery?.text).toMatch(/WHERE id =/);
        expect(ownerQuery?.text).not.toMatch(/username/i);
        expect(ownerQuery?.values).toEqual([OWNER_ID]);
    });

    it('denies a token whose owner_user_id is null without querying users', async () => {
        const queries: string[] = [];
        mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
            const text = strings.join('');
            queries.push(text);
            if (text.includes('FROM service_tokens') && text.includes('token_hash')) {
                return [makeTokenRow({ owner_user_id: null })];
            }
            if (text.includes('FROM users')) return [{ disabled_at: null, deleted_at: null }];
            return [];
        });

        const svc = new ServiceTokenService();
        expect(await svc.validate('svc_' + '2'.repeat(48))).toBeNull();
        expect(queries.some((q) => q.includes('FROM users'))).toBe(false);
    });

    it('fails closed when the creator lookup itself errors', async () => {
        mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
            const text = strings.join('');
            if (text.includes('FROM service_tokens') && text.includes('token_hash')) {
                return [makeTokenRow()];
            }
            if (text.includes('FROM users')) {
                throw Object.assign(new Error('connection reset'), { code: 'ECONNREFUSED' });
            }
            return [];
        });

        const svc = new ServiceTokenService();
        await expect(svc.validate('svc_' + 'e'.repeat(48))).rejects.toThrow(
            'Authentication temporarily unavailable',
        );
    });

    it('re-checks creator status on a CACHED token, not just first validation', async () => {
        // First call: creator active, validates and caches.
        const creatorRows: Array<{ disabled_at: Date | null; deleted_at: Date | null }> = [
            { disabled_at: null, deleted_at: null },
        ];
        const sql = makeFakeSql({ tokenRows: [makeTokenRow()], creatorRows });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const token = 'svc_' + 'f'.repeat(48);
        const first = await svc.validate(token);
        expect(first).not.toBeNull();

        // Creator is disabled AFTER the token was cached. The cache still
        // holds the token row, but every validate() call must re-check the
        // creator fresh (mirrors PatService's owner re-check).
        creatorRows[0] = { disabled_at: new Date(), deleted_at: null };

        const second = await svc.validate(token);
        expect(second).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// markAdminScopedForceNonAdminImpersonating — cache eviction (fix-plan-5
// Task 9, carried C3). Security review 5 §9: eviction used to be keyed on
// `wasUnnarrowed`, a subset derived from the earlier SELECT snapshot, not
// the narrowing UPDATE's own RETURNING — the actual source of truth for
// which rows the DB now holds as narrowed.
// ---------------------------------------------------------------------------
describe('markAdminScopedForceNonAdminImpersonating — cache eviction (carried C3)', () => {
    beforeEach(() => {
        mockSql.mockReset();
        mockPublishAuthCacheInvalidation.mockClear();
    });

    it('evicts every row the narrowing UPDATE actually touched, not just the SELECT-snapshot "newly narrowed" subset', async () => {
        // Row 1: the SELECT sees it as ALREADY force_non_admin=true (so the
        // old code's `wasUnnarrowed` subset excludes it) — modelling the
        // race the finding describes: a concurrent restore + re-cache
        // flipped it to un-narrowed and re-cached that state between the
        // SELECT and this UPDATE, and this narrowing call then re-narrows
        // it. Row 2: the ordinary, ALREADY-correctly-handled "newly
        // narrowed" case (present in `wasUnnarrowed`).
        const sql = vi.fn(async (strings: TemplateStringsArray) => {
            const text = strings.join('');
            if (text.includes('SELECT id, token_hash, scopes')) {
                return [
                    {
                        id: 1,
                        token_hash: 'hash-already-narrowed',
                        scopes: ['admin'],
                        force_non_admin: true,
                        force_non_admin_narrowed_at: new Date(),
                        matches_target: true,
                        matches_creator: false,
                    },
                    {
                        id: 2,
                        token_hash: 'hash-newly-narrowed',
                        scopes: ['admin'],
                        force_non_admin: false,
                        force_non_admin_narrowed_at: null,
                        matches_target: true,
                        matches_creator: false,
                    },
                ];
            }
            if (
                text.includes('UPDATE service_tokens') &&
                text.includes('RETURNING id, token_hash')
            ) {
                // The UPDATE's RETURNING is the source of truth: BOTH rows
                // are actually touched (matched by `WHERE id = ANY(allIds)`
                // regardless of their pre-UPDATE force_non_admin value).
                return [
                    { id: 1, token_hash: 'hash-already-narrowed' },
                    { id: 2, token_hash: 'hash-newly-narrowed' },
                ];
            }
            return [];
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const count = await svc.markAdminScopedForceNonAdminImpersonating(
            toUserId('11111111-1111-1111-1111-111111111111'),
            'demoted-admin',
        );

        const evictedHashes = mockPublishAuthCacheInvalidation.mock.calls.map(
            (c) => (c[0] as { tokenHash: string }).tokenHash,
        );
        // THE assertion for the bug: both hashes must be evicted/broadcast —
        // not just id 2 (the SELECT-snapshot's "was unnarrowed" subset).
        expect(evictedHashes).toContain('hash-already-narrowed');
        expect(evictedHashes).toContain('hash-newly-narrowed');
        // The "newly narrowed" COUNT (log/return value) is still the
        // SELECT-snapshot-based subset — this fix is about eviction only.
        expect(count).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// clearForceNonAdminForUserAndCreator — atomic restore (fix-plan-5 Task 9,
// carried C2). Security review 5 §9: the restore used to be two separate
// UPDATE statements — clear the reason flag(s), then a second UPDATE
// flipping force_non_admin when both flags read back false. A crash between
// them stranded a row (force_non_admin=true, narrowed_at set, both reason
// flags already false) that this method's own WHERE clause can never match
// again on any later call — narrowed forever, fails closed. Folded into one
// statement so a row is always either still flagged or fully restored.
// ---------------------------------------------------------------------------
describe('clearForceNonAdminForUserAndCreator — atomic restore (carried C2)', () => {
    beforeEach(() => {
        mockSql.mockReset();
        mockPublishAuthCacheInvalidation.mockClear();
    });

    it('performs the restore in a SINGLE statement — no window where a crash could strand a row narrowed forever', async () => {
        const queries: string[] = [];
        const sql = vi.fn(async (strings: TemplateStringsArray) => {
            queries.push(strings.join(''));
            return [{ id: 1, token_hash: 'hash-1', fully_restored: true }];
        });
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const count = await svc.clearForceNonAdminForUserAndCreator(
            toUserId('22222222-2222-2222-2222-222222222222'),
            'promoted-admin',
        );

        expect(count).toBe(1);
        expect(mockPublishAuthCacheInvalidation).toHaveBeenCalledWith({
            kind: 'token-narrowed',
            tokenHash: 'hash-1',
        });
        // THE assertion for the bug: exactly one round trip. The old
        // two-UPDATE shape made this method call `this.sql` twice whenever
        // it found a fully-clearable row, leaving a window between them
        // where a crash left the row's reason flags cleared but
        // force_non_admin still true — a shape no future call's WHERE
        // clause can ever match again.
        expect(queries.length).toBe(1);
    });

    it('does not evict/broadcast a row the statement returned as only PARTIALLY restored', async () => {
        const sql = vi.fn(async () => [
            { id: 1, token_hash: 'hash-partial', fully_restored: false },
        ]);
        mockSql.mockImplementation(sql);

        const svc = new ServiceTokenService();
        const count = await svc.clearForceNonAdminForUserAndCreator(
            toUserId('33333333-3333-3333-3333-333333333333'),
            'promoted-admin',
        );

        expect(count).toBe(0);
        expect(mockPublishAuthCacheInvalidation).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// allowedIps: canonical IPv6 on write and in the matcher (API package 15).
// ---------------------------------------------------------------------------
describe('ServiceTokenService: canonical IP allowlist', () => {
    beforeEach(() => {
        mockSql.mockReset();
    });

    it('normalizeIp compresses and lower-cases IPv6 and unmaps IPv4-mapped addresses', () => {
        expect(normalizeIp('2001:DB8:0:0::1')).toBe('2001:db8::1');
        expect(normalizeIp('::ffff:10.0.0.5')).toBe('10.0.0.5');
        expect(normalizeIp('::FFFF:a00:5')).toBe('10.0.0.5');
        expect(normalizeIp('10.0.0.5')).toBe('10.0.0.5');
        expect(normalizeIp('::1')).toBe('::1');
    });

    it('an allowlist entry 2001:DB8:0:0::1 admits client 2001:db8::1', async () => {
        mockSql.mockImplementation(
            makeFakeSql({
                tokenRows: [makeTokenRow({ allowed_ips: ['2001:DB8:0:0::1'] })],
                creatorRows: [{ disabled_at: null, deleted_at: null }],
            }),
        );
        const svc = new ServiceTokenService();
        expect(await svc.validate('svc_' + '3'.repeat(48), '2001:db8::1')).not.toBeNull();
        expect(await svc.validate('svc_' + '3'.repeat(48), '2001:db8::2')).toBeNull();
    });

    it('an IPv4 entry admits the IPv4-mapped client address', async () => {
        mockSql.mockImplementation(
            makeFakeSql({
                tokenRows: [makeTokenRow({ allowed_ips: ['10.0.0.5'] })],
                creatorRows: [{ disabled_at: null, deleted_at: null }],
            }),
        );
        const svc = new ServiceTokenService();
        expect(await svc.validate('svc_' + '4'.repeat(48), '::ffff:10.0.0.5')).not.toBeNull();
    });

    it('create() stores the allowlist canonical and de-duplicated', async () => {
        const inserted: unknown[][] = [];
        const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
            if (strings.join('').includes('INSERT INTO service_tokens')) {
                inserted.push(values);
                return [{ id: 9 }];
            }
            return [];
        });
        const sql = Object.assign(
            vi.fn(async (strings: TemplateStringsArray) =>
                strings.join('').includes('COUNT(*)') ? [{ count: '0' }] : [],
            ),
            { begin: async (fn: (t: unknown) => unknown) => fn(tx) },
        );
        mockSql.mockImplementation(sql);
        const svc = new ServiceTokenService();
        (svc as unknown as { sql: unknown }).sql = sql;
        await svc.create({
            name: 'ips',
            createdBy: 'the-admin',
            ownerUserId: OWNER_ID,
            scopes: ['read'],
            allowedIps: ['2001:DB8:0:0::1', '2001:db8::1', '::ffff:10.0.0.5'],
        });
        expect(inserted[0]).toContainEqual(['2001:db8::1', '10.0.0.5']);
    });
});

// ---------------------------------------------------------------------------
// Stored values outside the grant / method enums (API package 15): request
// time, the minter envelope and the API all see the same filtered view.
// ---------------------------------------------------------------------------
describe('ServiceTokenService: stored values outside the enums', () => {
    beforeEach(() => {
        mockSql.mockReset();
        mockLogWarn.mockReset();
    });

    it('validate() drops unknown stored scopes and warns once per token', async () => {
        mockSql.mockImplementation(
            makeFakeSql({
                tokenRows: [makeTokenRow({ id: 4242, scopes: ['admin', 'tasks:admin', 'legacy'] })],
                creatorRows: [{ disabled_at: null, deleted_at: null }],
            }),
        );
        const svc = new ServiceTokenService();
        const first = await svc.validate('svc_' + '5'.repeat(48));
        expect(first?.scopes).toEqual(['admin']);
        const svc2 = new ServiceTokenService();
        await svc2.validate('svc_' + '5'.repeat(48));
        const warns = mockLogWarn.mock.calls.filter(
            ([, meta]) => (meta as { tokenId?: number } | undefined)?.tokenId === 4242,
        );
        expect(warns).toHaveLength(1);
        expect(warns[0][1]).toMatchObject({ dropped: ['tasks:admin', 'legacy'] });
    });

    it('a token holding only unknown scopes is rejected (no grant left, never read+write)', async () => {
        mockSql.mockImplementation(
            makeFakeSql({
                tokenRows: [makeTokenRow({ id: 4243, scopes: ['users:admin'] })],
                creatorRows: [{ disabled_at: null, deleted_at: null }],
            }),
        );
        const svc = new ServiceTokenService();
        expect(await svc.validate('svc_' + '6'.repeat(48))).toBeNull();
    });

    it('listAll() filters scopes and methods to the enums', async () => {
        mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
            const text = strings.join('');
            if (text.includes('FROM service_tokens st')) {
                return [
                    {
                        ...makeTokenRow({
                            id: 4244,
                            scopes: ['read', 'tasks:admin'],
                            allowed_methods: ['get', 'PURGE', 'head'],
                        }),
                        created_via_token_id: null,
                        created_via_token_name: null,
                        act_as_username: null,
                    },
                ];
            }
            return [];
        });
        const svc = new ServiceTokenService();
        const [item] = await svc.listAll();
        expect(item.scopes).toEqual(['read']);
        expect(item.allowedMethods).toEqual(['GET', 'HEAD']);
    });

    it('getMinterEnvelope() hands the minting check the same filtered scopes', async () => {
        mockSql.mockImplementation(async () => [
            makeTokenRow({ id: 4245, scopes: ['admin', 'tasks:admin'] }),
        ]);
        const svc = new ServiceTokenService();
        expect((await svc.getMinterEnvelope(4245))?.scopes).toEqual(['admin']);
    });
});
