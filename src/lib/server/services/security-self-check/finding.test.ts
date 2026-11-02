// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { finding, summarize } from './finding';
import type { SecuritySelfCheckFinding } from '$lib/schemas/security-self-check';
import {
    SecuritySelfCheckReportSchema,
    SecuritySelfCheckStatusSchema,
} from '$lib/schemas/security-self-check';

describe('finding', () => {
    it('omits optional fields when not provided', () => {
        const f = finding({
            id: 'oidc.allow-insecure',
            method: 'oidc',
            type: 'config-static',
            status: 'fail',
            title: 'TLS verification disabled',
            detail: 'AUTH_OIDC_ALLOW_INSECURE=true',
        });
        expect(f).toEqual({
            id: 'oidc.allow-insecure',
            method: 'oidc',
            type: 'config-static',
            status: 'fail',
            title: 'TLS verification disabled',
            detail: 'AUTH_OIDC_ALLOW_INSECURE=true',
        });
        expect('remediation' in f).toBe(false);
        expect('evidence' in f).toBe(false);
    });

    it('includes optional fields when provided', () => {
        const f = finding({
            id: 'edge.hsts',
            method: 'edge',
            type: 'edge-probe',
            status: 'warn',
            title: 'HSTS missing',
            detail: 'No Strict-Transport-Security header',
            remediation: 'Add HSTS at the edge',
            evidence: 'hooks.server.ts:751',
        });
        expect(f.remediation).toBe('Add HSTS at the edge');
        expect(f.evidence).toBe('hooks.server.ts:751');
    });
});

describe('summarize', () => {
    it('returns all zeros for an empty list', () => {
        expect(summarize([])).toEqual({ pass: 0, warn: 0, fail: 0, skipped: 0, error: 0, info: 0 });
    });

    it('counts each status independently', () => {
        const findings: SecuritySelfCheckFinding[] = [
            finding({
                id: 'a',
                method: 'edge',
                type: 'edge-probe',
                status: 'pass',
                title: 'a',
                detail: '',
            }),
            finding({
                id: 'b',
                method: 'edge',
                type: 'edge-probe',
                status: 'pass',
                title: 'b',
                detail: '',
            }),
            finding({
                id: 'c',
                method: 'oidc',
                type: 'config-static',
                status: 'fail',
                title: 'c',
                detail: '',
            }),
            finding({
                id: 'd',
                method: 'oidc',
                type: 'config-static',
                status: 'warn',
                title: 'd',
                detail: '',
            }),
            finding({
                id: 'e',
                method: 'token',
                type: 'edge-probe',
                status: 'skipped',
                title: 'e',
                detail: '',
            }),
            finding({
                id: 'f',
                method: 'secrets',
                type: 'inventory',
                status: 'error',
                title: 'f',
                detail: '',
            }),
            finding({
                id: 'g',
                method: 'edge',
                type: 'edge-probe',
                status: 'info',
                title: 'g',
                detail: '',
            }),
        ];
        expect(summarize(findings)).toEqual({
            pass: 2,
            warn: 1,
            fail: 1,
            skipped: 1,
            error: 1,
            info: 1,
        });
    });
});

// Regression guard: a finding may emit ANY status in the enum, and the assembled
// report (findings + summarize()) MUST validate against the Zod schema. This is
// exactly what the /run route does — so an out-of-enum status, or a summarize()
// that doesn't cover a status, fails here instead of 500ing in production
// (caught a real 'info'-not-in-enum regression).
describe('status enum ↔ summarize ↔ report schema consistency', () => {
    it('every status is summarizable and the report validates', () => {
        const findings: SecuritySelfCheckFinding[] = SecuritySelfCheckStatusSchema.options.map(
            (status, i) =>
                finding({
                    id: `check.${i}`,
                    method: 'edge',
                    type: 'edge-probe',
                    status,
                    title: `t${i}`,
                    detail: `d${i}`,
                }),
        );
        const summary = summarize(findings);
        // Every enum status counted exactly once.
        for (const status of SecuritySelfCheckStatusSchema.options) {
            expect(summary[status]).toBe(1);
        }
        // The full report parses — same validation the /run route performs.
        expect(() =>
            SecuritySelfCheckReportSchema.parse({
                ranAt: '2026-01-01T00:00:00.000Z',
                findings,
                summary,
            }),
        ).not.toThrow();
    });
});
