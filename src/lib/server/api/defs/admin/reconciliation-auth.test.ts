// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Every reconciliation endpoint rewrites or reveals library structure: each of
 * its handlers must sit behind the library-admin scope.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/services/absolute-numbering-reconciliation.service.js', () => ({
    ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER: 'lumastra-reconcile-absolute',
    ABSOLUTE_NUMBERING_PROPOSED_REASON: 'absolute-numbering:proposed',
    ProposalActionError: class extends Error {},
    applyAbsoluteNumberingProposal: vi.fn(),
    dismissAbsoluteNumberingProposal: vi.fn(),
}));
vi.mock('$lib/server/services/episode-reconciliation-undo.service.js', () => ({
    ReconciliationUndoError: class extends Error {},
    undoReconciliationMove: vi.fn(),
}));

const defs = {
    'reconciliation-moves/list': (await import('./reconciliation-moves/list.js')).def,
    'reconciliation-moves/undo': (await import('./reconciliation-moves/undo.js')).def,
    'reconciliation-proposals/list': (await import('./reconciliation-proposals/list.js')).def,
    'reconciliation-proposals/apply': (await import('./reconciliation-proposals/apply.js')).def,
    'reconciliation-proposals/dismiss': (await import('./reconciliation-proposals/dismiss.js')).def,
};

describe('reconciliation endpoints require the library admin scope', () => {
    for (const [name, def] of Object.entries(defs)) {
        it(`${name}: every handler is behind library:admin`, () => {
            const methods = Object.keys(def.handlers);
            expect(methods.length).toBeGreaterThan(0);
            const auth = def.auth as Record<string, unknown>;
            for (const method of methods) {
                const spec = 'kind' in auth ? auth : auth[method];
                expect(spec, `${name} ${method}`).toEqual({
                    kind: 'scope',
                    anyOf: ['library:admin'],
                });
            }
        });
    }
});
