// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isNoScriptError } from './loader.js';

/**
 * Regression guard for the EVALSHA→EVAL fallback: if NOSCRIPT detection is too
 * narrow, a Valkey restart / failover / SCRIPT FLUSH (which evicts the script
 * cache) makes every EVALSHA throw instead of recovering, taking out enqueue /
 * rate-limit paths until the process restarts.
 */
describe('isNoScriptError', () => {
    it('matches the raw RESP NOSCRIPT reply', () => {
        expect(isNoScriptError(new Error('NOSCRIPT No matching script. Please use EVAL.'))).toBe(
            true,
        );
    });

    it('matches valkey-glide phrasing that drops the literal NOSCRIPT token', () => {
        // glide surfaces the server reply as a RequestError; "NOSCRIPT" is not
        // guaranteed to survive in `.message`, but "No matching script" is.
        expect(isNoScriptError(new Error('No matching script'))).toBe(true);
        expect(
            isNoScriptError(
                new Error(
                    'An error was signalled by the server: - NoScriptError: No matching script.',
                ),
            ),
        ).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isNoScriptError(new Error('noscript no matching script'))).toBe(true);
    });

    it('accepts a non-Error value', () => {
        expect(isNoScriptError('NOSCRIPT No matching script')).toBe(true);
    });

    it('does not match unrelated errors or nullish values', () => {
        expect(isNoScriptError(new Error('WRONGTYPE Operation against a key'))).toBe(false);
        expect(isNoScriptError(new Error('Connection refused'))).toBe(false);
        expect(isNoScriptError(null)).toBe(false);
        expect(isNoScriptError(undefined)).toBe(false);
    });
});
