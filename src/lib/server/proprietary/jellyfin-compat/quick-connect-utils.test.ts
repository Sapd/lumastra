// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { QC_SECRET_PREFIX, QC_CODE_PREFIX, QC_TTL_SECONDS } from './quick-connect-utils';
import type { QuickConnectData } from './quick-connect-utils';

describe('quick-connect-utils constants', () => {
    it('QC_SECRET_PREFIX starts with jfcompat:qc:secret:', () => {
        expect(typeof QC_SECRET_PREFIX).toBe('string');
        expect(QC_SECRET_PREFIX.startsWith('jfcompat:qc:secret:')).toBe(true);
    });

    it('QC_CODE_PREFIX starts with jfcompat:qc:code:', () => {
        expect(typeof QC_CODE_PREFIX).toBe('string');
        expect(QC_CODE_PREFIX.startsWith('jfcompat:qc:code:')).toBe(true);
    });

    it('QC_TTL_SECONDS is a positive number', () => {
        expect(typeof QC_TTL_SECONDS).toBe('number');
        expect(QC_TTL_SECONDS).toBeGreaterThan(0);
    });
});

describe('QuickConnectData type', () => {
    it('can construct a valid QuickConnectData object', () => {
        const data: QuickConnectData = {
            code: 'ABC123',
            authenticated: false,
            userId: null,
            username: null,
            isAdmin: false,
            groups: [],
            displayName: null,
        };
        expect(data.code).toBe('ABC123');
        expect(data.authenticated).toBe(false);
        expect(data.groups).toEqual([]);
    });
});
