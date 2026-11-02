// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isTransientPgError } from './transient-pg.js';

describe('isTransientPgError', () => {
    it('classifies a postgres.js CONNECT_TIMEOUT as transient', () => {
        // postgres.js raises this (code CONNECT_TIMEOUT, no SQLSTATE) when it
        // can't establish a connection in time — a transient infra blip that was
        // previously mis-classified permanent and dead-lettered the item.
        expect(isTransientPgError(new Error('write CONNECT_TIMEOUT ai-postgres:5432'))).toBe(true);
        expect(isTransientPgError({ code: 'CONNECT_TIMEOUT', message: 'connect timeout' })).toBe(
            true,
        );
    });

    it('still classifies SQLSTATE connection/serialization codes as transient', () => {
        expect(isTransientPgError({ code: '40001' })).toBe(true); // serialization failure
        expect(isTransientPgError({ code: '08006' })).toBe(true); // connection failure
    });

    it('still classifies message-only connection errors as transient', () => {
        expect(isTransientPgError(new Error('Connection terminated unexpectedly'))).toBe(true);
        expect(isTransientPgError(new Error('write EPIPE'))).toBe(true);
    });

    it('does not classify a genuine query error as transient', () => {
        expect(isTransientPgError({ code: '23503', message: 'foreign key violation' })).toBe(false);
        expect(isTransientPgError(new Error('syntax error at or near "SELCT"'))).toBe(false);
    });
});
