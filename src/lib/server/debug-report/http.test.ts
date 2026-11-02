// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import { debugReportRateKey } from './http.js';

describe('debugReportRateKey', () => {
    it.each([
        { kind: 'service_token', credentialId: '42', expected: 'service_token:42:debug-report' },
        {
            kind: 'session',
            credentialId: undefined,
            expected: 'session:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee:debug-report',
        },
        { kind: 'pat', credentialId: '42', expected: 'pat:42:debug-report' },
    ] as const)(
        'separates the $kind budget by credential kind and endpoint',
        ({ kind, credentialId, expected }) => {
            const principal = buildPrincipal({
                kind,
                credentialId,
                userId: toUserId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
                username: 'owner',
                userGroups: [],
                sessionIsAdmin: true,
                ownerIsAdmin: true,
                tokenScopes: ['admin'],
            });
            const event = { locals: { principal } } as RequestEvent;
            expect(debugReportRateKey(event, 'debug-report')).toBe(expected);
            expect(debugReportRateKey(event, 'debug-report-health')).toBe(expected + '-health');
        },
    );
});
