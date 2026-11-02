// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin client validates reconcile proposals against its own reason enum
 * (ReconciliationProposalSchema) and labels each reason in
 * reconciliation-reason.ts. 'identity-bound' was emitted by the server for
 * months without either knowing it, so the needs-review list showed blank
 * reasons. This pins the two enums together.
 */

import { describe, expect, it } from 'vitest';
import { ReconciliationProposalSchema } from '$lib/schemas/api-admin-responses.js';
import { ReconcileReasonSchema } from './reconcile.js';

describe('reconcile reason enums', () => {
    it('the client proposal schema accepts every reason the server emits', () => {
        expect([...ReconciliationProposalSchema.shape.reason.options].sort()).toEqual(
            [...ReconcileReasonSchema.options].sort(),
        );
    });
});
