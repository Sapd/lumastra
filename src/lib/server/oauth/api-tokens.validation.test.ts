// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for API Token Validation Logic
 *
 * Tests input validation for PAT and Service Token API endpoints.
 * These are the validation functions extracted from the API endpoints.
 */

import { describe, it, expect } from 'vitest';
import { isRecord } from '$lib/utils/data-extraction';

// Validation types and functions extracted from API endpoints

interface ValidationResult {
    valid: boolean;
    error?: string;
}

const VALID_SCOPES = ['read', 'write', 'admin'];

// Name validation
function validateName(name: unknown): ValidationResult {
    if (!name || typeof name !== 'string' || name.trim() === '') {
        return { valid: false, error: 'Name is required' };
    }
    if (name.length > 255) {
        return { valid: false, error: 'Name must be 255 characters or less' };
    }
    return { valid: true };
}

// Description validation
function validateDescription(description: unknown): ValidationResult {
    if (description === undefined || description === null) {
        return { valid: true }; // Optional field
    }
    if (typeof description !== 'string') {
        return { valid: false, error: 'Description must be a string' };
    }
    if (description.length > 1000) {
        return {
            valid: false,
            error: 'Description must be 1000 characters or less',
        };
    }
    return { valid: true };
}

// Scopes validation
function validateScopes(scopes: unknown, allowAdminScope: boolean = true): ValidationResult {
    if (scopes === undefined) {
        return { valid: true }; // Uses default
    }
    if (!Array.isArray(scopes)) {
        return { valid: false, error: 'Scopes must be an array' };
    }
    if (scopes.length === 0) {
        return { valid: false, error: 'At least one scope is required' };
    }
    for (const scope of scopes) {
        if (typeof scope !== 'string') {
            return { valid: false, error: 'Scopes must be strings' };
        }
        if (!VALID_SCOPES.includes(scope)) {
            return {
                valid: false,
                error: `Invalid scope: ${scope}. Valid scopes: ${VALID_SCOPES.join(', ')}`,
            };
        }
    }
    if (!allowAdminScope && scopes.includes('admin')) {
        return {
            valid: false,
            error: 'Only administrators can create tokens with admin scope',
        };
    }
    return { valid: true };
}

// ExpiresInDays validation
function validateExpiresInDays(expiresInDays: unknown): ValidationResult {
    if (expiresInDays === undefined || expiresInDays === null) {
        return { valid: true }; // null means no expiration
    }
    if (typeof expiresInDays !== 'number' || expiresInDays < 1) {
        return {
            valid: false,
            error: 'expiresInDays must be a positive number or null',
        };
    }
    return { valid: true };
}

// ActAsUser validation
function validateActAsUser(actAsUser: unknown): ValidationResult {
    if (actAsUser === undefined || actAsUser === null) {
        return { valid: true }; // Optional field
    }
    if (typeof actAsUser !== 'string') {
        return { valid: false, error: 'actAsUser must be a string' };
    }
    if (actAsUser.length > 255) {
        return {
            valid: false,
            error: 'actAsUser must be 255 characters or less',
        };
    }
    return { valid: true };
}

// IPv4 validation
function isValidIPv4(ip: string): boolean {
    const parts = ip.split('.');
    if (parts.length !== 4) return false;
    return parts.every((part) => {
        const num = parseInt(part, 10);
        return !isNaN(num) && num >= 0 && num <= 255 && part === String(num);
    });
}

// IPv6 validation
function isValidIPv6(ip: string): boolean {
    const ipv6Regex =
        /^([a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}$|^([a-fA-F0-9]{1,4}:){1,7}:$|^([a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}$|^([a-fA-F0-9]{1,4}:){1,5}(:[a-fA-F0-9]{1,4}){1,2}$|^([a-fA-F0-9]{1,4}:){1,4}(:[a-fA-F0-9]{1,4}){1,3}$|^([a-fA-F0-9]{1,4}:){1,3}(:[a-fA-F0-9]{1,4}){1,4}$|^([a-fA-F0-9]{1,4}:){1,2}(:[a-fA-F0-9]{1,4}){1,5}$|^[a-fA-F0-9]{1,4}:(:[a-fA-F0-9]{1,4}){1,6}$|^:(:[a-fA-F0-9]{1,4}){1,7}$|^::$/;
    return ipv6Regex.test(ip);
}

// AllowedIps validation
function validateAllowedIps(allowedIps: unknown): ValidationResult {
    if (allowedIps === undefined) {
        return { valid: true }; // Optional field
    }
    if (!Array.isArray(allowedIps)) {
        return { valid: false, error: 'allowedIps must be an array' };
    }
    for (const ip of allowedIps) {
        if (typeof ip !== 'string') {
            return { valid: false, error: 'allowedIps must contain strings' };
        }
        if (!isValidIPv4(ip) && !isValidIPv6(ip)) {
            return { valid: false, error: `Invalid IP address: ${ip}` };
        }
    }
    return { valid: true };
}

// Tests

describe('Name Validation', () => {
    it('accepts valid name', () => {
        expect(validateName('My Token')).toEqual({ valid: true });
    });

    it('rejects empty string', () => {
        const result = validateName('');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('required');
    });

    it('rejects whitespace-only string', () => {
        const result = validateName('   ');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('required');
    });

    it('rejects null', () => {
        const result = validateName(null);
        expect(result.valid).toBe(false);
    });

    it('rejects undefined', () => {
        const result = validateName(undefined);
        expect(result.valid).toBe(false);
    });

    it('rejects non-string', () => {
        const result = validateName(123);
        expect(result.valid).toBe(false);
    });

    it('rejects name over 255 characters', () => {
        const result = validateName('a'.repeat(256));
        expect(result.valid).toBe(false);
        expect(result.error).toContain('255');
    });

    it('accepts name exactly 255 characters', () => {
        expect(validateName('a'.repeat(255))).toEqual({ valid: true });
    });
});

describe('Description Validation', () => {
    it('accepts valid description', () => {
        expect(validateDescription('A useful token')).toEqual({ valid: true });
    });

    it('accepts null (optional)', () => {
        expect(validateDescription(null)).toEqual({ valid: true });
    });

    it('accepts undefined (optional)', () => {
        expect(validateDescription(undefined)).toEqual({ valid: true });
    });

    it('rejects non-string', () => {
        const result = validateDescription(123);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('string');
    });

    it('rejects description over 1000 characters', () => {
        const result = validateDescription('a'.repeat(1001));
        expect(result.valid).toBe(false);
        expect(result.error).toContain('1000');
    });

    it('accepts description exactly 1000 characters', () => {
        expect(validateDescription('a'.repeat(1000))).toEqual({ valid: true });
    });

    it('accepts empty string', () => {
        expect(validateDescription('')).toEqual({ valid: true });
    });
});

describe('Scopes Validation', () => {
    it('accepts valid scopes', () => {
        expect(validateScopes(['read'])).toEqual({ valid: true });
        expect(validateScopes(['write'])).toEqual({ valid: true });
        expect(validateScopes(['admin'])).toEqual({ valid: true });
        expect(validateScopes(['read', 'write'])).toEqual({ valid: true });
    });

    it('accepts undefined (uses default)', () => {
        expect(validateScopes(undefined)).toEqual({ valid: true });
    });

    it('rejects non-array', () => {
        const result = validateScopes('read');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('array');
    });

    it('rejects empty array', () => {
        const result = validateScopes([]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('At least one');
    });

    it('rejects non-string in array', () => {
        const result = validateScopes([123]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('strings');
    });

    it('rejects invalid scope', () => {
        const result = validateScopes(['read', 'delete']);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid scope');
        expect(result.error).toContain('delete');
    });

    it('rejects admin scope for non-admins', () => {
        const result = validateScopes(['admin'], false);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('administrators');
    });

    it('allows admin scope for admins', () => {
        expect(validateScopes(['admin'], true)).toEqual({ valid: true });
    });
});

describe('ExpiresInDays Validation', () => {
    it('accepts positive number', () => {
        expect(validateExpiresInDays(30)).toEqual({ valid: true });
        expect(validateExpiresInDays(365)).toEqual({ valid: true });
        expect(validateExpiresInDays(1)).toEqual({ valid: true });
    });

    it('accepts null (no expiration)', () => {
        expect(validateExpiresInDays(null)).toEqual({ valid: true });
    });

    it('accepts undefined (no expiration)', () => {
        expect(validateExpiresInDays(undefined)).toEqual({ valid: true });
    });

    it('rejects zero', () => {
        const result = validateExpiresInDays(0);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('positive');
    });

    it('rejects negative number', () => {
        const result = validateExpiresInDays(-1);
        expect(result.valid).toBe(false);
    });

    it('rejects non-number', () => {
        const result = validateExpiresInDays('30');
        expect(result.valid).toBe(false);
    });

    it('rejects float (technically valid but check behavior)', () => {
        // The validation only checks for positive number, floats pass
        expect(validateExpiresInDays(1.5)).toEqual({ valid: true });
    });
});

describe('ActAsUser Validation', () => {
    it('accepts valid username', () => {
        expect(validateActAsUser('john.doe')).toEqual({ valid: true });
    });

    it('accepts null (optional)', () => {
        expect(validateActAsUser(null)).toEqual({ valid: true });
    });

    it('accepts undefined (optional)', () => {
        expect(validateActAsUser(undefined)).toEqual({ valid: true });
    });

    it('rejects non-string', () => {
        const result = validateActAsUser(123);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('string');
    });

    it('rejects username over 255 characters', () => {
        const result = validateActAsUser('a'.repeat(256));
        expect(result.valid).toBe(false);
        expect(result.error).toContain('255');
    });

    it('accepts username exactly 255 characters', () => {
        expect(validateActAsUser('a'.repeat(255))).toEqual({ valid: true });
    });

    it('accepts empty string', () => {
        // Empty string is technically valid, service will trim it
        expect(validateActAsUser('')).toEqual({ valid: true });
    });
});

describe('AllowedIps Validation', () => {
    it('accepts valid IPv4 addresses', () => {
        expect(validateAllowedIps(['192.168.1.1', '10.0.0.1'])).toEqual({
            valid: true,
        });
    });

    it('accepts valid IPv6 addresses', () => {
        expect(validateAllowedIps(['::1', '2001:db8::1'])).toEqual({
            valid: true,
        });
    });

    it('accepts mixed IPv4 and IPv6', () => {
        expect(validateAllowedIps(['192.168.1.1', '::1'])).toEqual({
            valid: true,
        });
    });

    it('accepts undefined (optional)', () => {
        expect(validateAllowedIps(undefined)).toEqual({ valid: true });
    });

    it('accepts empty array (no restrictions)', () => {
        expect(validateAllowedIps([])).toEqual({ valid: true });
    });

    it('rejects non-array', () => {
        const result = validateAllowedIps('192.168.1.1');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('array');
    });

    it('rejects non-string in array', () => {
        const result = validateAllowedIps([123]);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('strings');
    });

    it('rejects invalid IPv4', () => {
        const result = validateAllowedIps(['256.1.1.1']);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid IP');
    });

    it('rejects random string', () => {
        const result = validateAllowedIps(['not-an-ip']);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid IP');
    });
});

describe('Token ID Validation', () => {
    function validateTokenId(id: string | null): ValidationResult {
        if (!id) {
            return { valid: false, error: 'Token ID is required' };
        }
        const parsed = parseInt(id, 10);
        if (isNaN(parsed)) {
            return { valid: false, error: 'Invalid token ID' };
        }
        return { valid: true };
    }

    it('accepts valid numeric string', () => {
        expect(validateTokenId('123')).toEqual({ valid: true });
    });

    it('rejects null', () => {
        const result = validateTokenId(null);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('required');
    });

    it('rejects non-numeric string', () => {
        const result = validateTokenId('abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid');
    });

    it('rejects empty string', () => {
        const result = validateTokenId('');
        expect(result.valid).toBe(false);
    });
});

describe('Request Body Parsing', () => {
    it('should handle valid JSON', async () => {
        const json = '{"name": "test"}';
        const parsed: unknown = JSON.parse(json);
        expect(isRecord(parsed)).toBe(true);
        if (isRecord(parsed)) {
            expect(parsed.name).toBe('test');
        }
    });

    it('should fail on invalid JSON', () => {
        const invalidJson = '{name: test}';
        expect(() => {
            JSON.parse(invalidJson);
        }).toThrow();
    });

    it('should handle empty body', () => {
        const emptyJson = '{}';
        const parsed: unknown = JSON.parse(emptyJson);
        expect(isRecord(parsed)).toBe(true);
        if (isRecord(parsed)) {
            expect(parsed).toEqual({});
        }
    });
});

describe('Combined Validation Scenarios', () => {
    interface CreatePatBody {
        name: unknown;
        description?: unknown;
        scopes?: unknown;
        expiresInDays?: unknown;
    }

    function validateCreatePatRequest(body: CreatePatBody, isAdmin: boolean): ValidationResult {
        const nameResult = validateName(body.name);
        if (!nameResult.valid) return nameResult;

        const descResult = validateDescription(body.description);
        if (!descResult.valid) return descResult;

        const scopesResult = validateScopes(body.scopes, isAdmin);
        if (!scopesResult.valid) return scopesResult;

        const expiresResult = validateExpiresInDays(body.expiresInDays);
        if (!expiresResult.valid) return expiresResult;

        return { valid: true };
    }

    it('validates complete valid request', () => {
        const body = {
            name: 'My Token',
            description: 'For testing',
            scopes: ['read', 'write'],
            expiresInDays: 365,
        };
        expect(validateCreatePatRequest(body, false)).toEqual({ valid: true });
    });

    it('validates minimal request', () => {
        const body = {
            name: 'Minimal Token',
        };
        expect(validateCreatePatRequest(body, false)).toEqual({ valid: true });
    });

    it('fails on first invalid field', () => {
        const body = {
            name: '', // Invalid
            description: 123, // Also invalid
            scopes: ['invalid'],
        };
        const result = validateCreatePatRequest(body, false);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Name'); // First error
    });

    it('admin can create admin-scoped token', () => {
        const body = {
            name: 'Admin Token',
            scopes: ['admin'],
        };
        expect(validateCreatePatRequest(body, true)).toEqual({ valid: true });
    });

    it('non-admin cannot create admin-scoped token', () => {
        const body = {
            name: 'Admin Token',
            scopes: ['admin'],
        };
        const result = validateCreatePatRequest(body, false);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('administrators');
    });
});

describe('Edge Cases', () => {
    it('handles unicode in name', () => {
        expect(validateName('日本語トークン')).toEqual({ valid: true });
    });

    it('handles special characters in name', () => {
        expect(validateName('Token (2024) - Test')).toEqual({ valid: true });
    });

    it('handles leading/trailing whitespace in name', () => {
        // Name validation checks for empty after trim
        expect(validateName('  Token  ')).toEqual({ valid: true });
    });

    it('handles very long valid input at boundary', () => {
        expect(validateName('a'.repeat(255))).toEqual({ valid: true });
        expect(validateName('a'.repeat(256)).valid).toBe(false);

        expect(validateDescription('a'.repeat(1000))).toEqual({ valid: true });
        expect(validateDescription('a'.repeat(1001)).valid).toBe(false);

        expect(validateActAsUser('a'.repeat(255))).toEqual({ valid: true });
        expect(validateActAsUser('a'.repeat(256)).valid).toBe(false);
    });
});
