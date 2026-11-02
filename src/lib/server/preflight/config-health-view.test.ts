// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `embedding.no-provider` is owned by the admin attention bell
 * (`optional-integration:embeddings`), which offers a durable ack. It must not
 * ALSO appear in the undismissable config banner. Everything else — every
 * error, and both security warnings — must still get through.
 */

import { describe, it, expect } from 'vitest';
import { toConfigHealthView } from './config-health-view.js';
import type { DoctorReport, DoctorIssue } from './config-doctor.js';

const NO_PROVIDER: DoctorIssue = {
    category: 'embedding',
    severity: 'warning',
    code: 'embedding.no-provider',
    message: 'No embedding provider configured',
};

const TRUST_ANY: DoctorIssue = {
    category: 'forward-auth',
    severity: 'warning',
    code: 'forward-auth.trust-any',
    message: 'LUMASTRA_TRUST_ANY_PROXY=true trusts identity headers from any peer',
};

const DIMENSION_MISMATCH: DoctorIssue = {
    category: 'embedding',
    severity: 'error',
    code: 'embedding.dimension-mismatch',
    message: 'EMBEDDING_DIMENSIONS=1536 is not valid for this model',
};

// Field values pinned to the real unions: EmbeddingProvider is
// 'voyage' | 'openai' (there is no 'none'), `spec` is required and may be
// null, and the *Source fields are 'config' | 'model-default' |
// 'provider-default' / 'config' | 'provider-default'. See
// src/lib/server/ai/embedding-models.ts:29 and :128.
function report(issues: DoctorIssue[]): DoctorReport {
    const errorCount = issues.filter((i) => i.severity === 'error').length;
    return {
        ok: errorCount === 0,
        errorCount,
        warningCount: issues.length - errorCount,
        issues,
        resolved: {
            embedding: {
                provider: 'voyage',
                model: 'voyage-3.5',
                spec: null,
                dimensions: 1024,
                dimensionSource: 'provider-default',
                modelSource: 'provider-default',
                hasProvider: false,
            },
        },
    };
}

describe('toConfigHealthView', () => {
    it('drops embedding.no-provider and decrements warningCount', () => {
        const view = toConfigHealthView(report([NO_PROVIDER, TRUST_ANY]));
        expect(view.issues.map((i) => i.code)).toEqual(['forward-auth.trust-any']);
        expect(view.warningCount).toBe(1);
    });

    it('keeps the security warnings — they must stay undismissable', () => {
        const view = toConfigHealthView(report([TRUST_ANY]));
        expect(view.issues).toHaveLength(1);
        expect(view.warningCount).toBe(1);
    });

    it('keeps every error and leaves errorCount/ok untouched', () => {
        const view = toConfigHealthView(report([NO_PROVIDER, DIMENSION_MISMATCH]));
        expect(view.issues.map((i) => i.code)).toEqual(['embedding.dimension-mismatch']);
        expect(view.errorCount).toBe(1);
        expect(view.ok).toBe(false);
        expect(view.warningCount).toBe(0);
    });

    it('is a no-op on a clean report', () => {
        const view = toConfigHealthView(report([]));
        expect(view.issues).toEqual([]);
        expect(view.ok).toBe(true);
        expect(view.warningCount).toBe(0);
    });

    it('never hides an error-severity issue even if its code is in the exclusion list', () => {
        // BANNER_EXCLUDED_CODES only ever contains 'embedding.no-provider'
        // (a warning) today, but the filter itself must stay structurally
        // incapable of dropping an error regardless of what the set holds —
        // simulate that by giving an error issue the excluded code.
        const excludedButError: DoctorIssue = {
            category: 'embedding',
            severity: 'error',
            code: 'embedding.no-provider',
            message: 'Simulated: excluded code carried on an error-severity issue',
        };
        const view = toConfigHealthView(report([excludedButError]));
        expect(view.issues.map((i) => i.code)).toEqual(['embedding.no-provider']);
    });
});
