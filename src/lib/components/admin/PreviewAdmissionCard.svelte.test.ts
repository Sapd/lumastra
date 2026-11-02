// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Preview admission.
 *
 * "Previews stopped working" has three causes with three different remedies —
 * an operator disabled them, the load circuit shed them, or every concurrent
 * slot is taken — and until now none of the three was visible anywhere. The
 * cache page showed preview CACHE numbers, which describe storage and say
 * nothing about whether anything is being served.
 *
 * The trap this guards is the toggle: when the LOAD circuit has shed previews,
 * flipping the operator switch off and on does not bring them back. A control
 * that appears to fix something it cannot is worse than no control, so the
 * switch reflects `adminDisabled` only, and the auto-shed case says so out loud.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockSet } = vi.hoisted(() => ({ mockGet: vi.fn(), mockSet: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({
    getPreviewStatus: mockGet,
    setPreviewsDisabled: mockSet,
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import PreviewAdmissionCard from './PreviewAdmissionCard.svelte';

function admission(over: Record<string, unknown> = {}) {
    return {
        data: {
            admission: {
                disabled: false,
                reason: null,
                loadRatio: 0.2,
                loadShedRatio: 0.85,
                activeCount: 3,
                maxGlobal: 20,
                adminDisabled: false,
                autoDisabled: false,
                ...over,
            },
        },
        error: null,
    };
}

describe('PreviewAdmissionCard', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('says previews are being served, with the slot usage', async () => {
        mockGet.mockResolvedValue(admission());
        render(PreviewAdmissionCard, {});
        await waitFor(() => expect(screen.getByText(/Being served — 3 of 20/)).toBeTruthy());
    });

    it('names an operator disable as the cause', async () => {
        mockGet.mockResolvedValue(
            admission({ disabled: true, reason: 'admin_disabled', adminDisabled: true }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() =>
            expect(screen.getByText(/Turned off by an administrator/)).toBeTruthy(),
        );
        expect(screen.getByRole('button', { name: 'Turn back on' })).toBeTruthy();
    });

    it('reports the load numbers when the circuit shed them', async () => {
        // Generic "previews are off" sends someone hunting for a setting; the
        // load figure points at the actual constraint.
        mockGet.mockResolvedValue(
            admission({
                disabled: true,
                reason: 'load_shed',
                autoDisabled: true,
                loadRatio: 0.93,
                loadShedRatio: 0.85,
            }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() =>
            expect(screen.getByText(/93% load, above the 85% cut-off/)).toBeTruthy(),
        );
    });

    it('warns that the switch cannot undo an automatic shed', async () => {
        // Without this an operator flips the toggle twice and concludes the
        // button is broken.
        mockGet.mockResolvedValue(
            admission({ disabled: true, reason: 'load_shed', autoDisabled: true }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() =>
            expect(screen.getByText(/switch above will not bring them back/)).toBeTruthy(),
        );
    });

    it('does NOT show that warning when the operator is the one who disabled them', async () => {
        // Here the switch genuinely does fix it.
        mockGet.mockResolvedValue(
            admission({ disabled: true, reason: 'admin_disabled', adminDisabled: true }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() =>
            expect(screen.getByText(/Turned off by an administrator/)).toBeTruthy(),
        );
        expect(screen.queryByText(/will not bring them back/)).toBeNull();
    });

    it('explains a full slot budget with the numbers behind it', async () => {
        mockGet.mockResolvedValue(
            admission({ disabled: true, reason: 'global_budget', activeCount: 20, maxGlobal: 20 }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() =>
            expect(screen.getByText(/All 20 preview slots are in use/)).toBeTruthy(),
        );
    });

    it('the switch reflects the OPERATOR flag, not the served state', async () => {
        // Auto-shed previews are not being served, but the operator has not
        // turned them off — so the control must still offer "Turn off".
        mockGet.mockResolvedValue(
            admission({ disabled: true, reason: 'load_shed', autoDisabled: true }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy());
    });

    it('sends the inverted operator flag and adopts the server echo', async () => {
        mockGet.mockResolvedValue(admission());
        mockSet.mockResolvedValue(
            admission({ disabled: true, reason: 'admin_disabled', adminDisabled: true }),
        );
        render(PreviewAdmissionCard, {});
        await waitFor(() => expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));

        await waitFor(() => expect(mockSet).toHaveBeenCalledWith(true));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Turn back on' })).toBeTruthy(),
        );
    });
});
