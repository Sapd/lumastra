// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    AVAILABILITY_EXISTS,
    AVAILABILITY_SELECT_FIELDS,
    AVAILABILITY_FILTER,
    isAvailable,
    batchGetAvailability,
    getAvailability,
} from './availability.queries.js';

describe('AVAILABILITY_EXISTS', () => {
    it('contains has_files column reference', () => {
        expect(AVAILABILITY_EXISTS).toContain('has_files');
    });

    it('does not contain external_ids jellyfin provider check', () => {
        expect(AVAILABILITY_EXISTS).not.toContain("provider = 'jellyfin'");
    });
});

describe('AVAILABILITY_SELECT_FIELDS', () => {
    it('contains AS is_available alias', () => {
        expect(AVAILABILITY_SELECT_FIELDS).toContain('AS is_available');
    });

    it('does not select a Jellyfin id', () => {
        expect(AVAILABILITY_SELECT_FIELDS).not.toContain('jellyfin');
    });

    it('contains AS can_request alias', () => {
        expect(AVAILABILITY_SELECT_FIELDS).toContain('AS can_request');
    });

    it('contains NOT expression for can_request', () => {
        expect(AVAILABILITY_SELECT_FIELDS).toContain('NOT mi.has_files');
    });
});

describe('AVAILABILITY_FILTER', () => {
    it('equals AVAILABILITY_EXISTS (mi.has_files)', () => {
        expect(AVAILABILITY_FILTER).toBe('mi.has_files');
    });

    it('does not contain AS alias', () => {
        expect(AVAILABILITY_FILTER).not.toContain('AS ');
    });
});

describe('exports', () => {
    it('exports isAvailable as a function', () => {
        expect(typeof isAvailable).toBe('function');
    });

    it('exports batchGetAvailability as a function', () => {
        expect(typeof batchGetAvailability).toBe('function');
    });

    it('exports getAvailability as a function', () => {
        expect(typeof getAvailability).toBe('function');
    });
});
