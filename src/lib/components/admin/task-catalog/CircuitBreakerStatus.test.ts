// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Prod showed a healthy task's auto-pause box reading "Running · 0 failures in
 * a row · last failure: orphaned_at_recovery" with a "Resume now" button and a
 * "Why was this paused?" heading — a control that resumes nothing, a raw
 * runner code, and a question about a pause that never happened.
 */

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import type { CircuitFleetEntry } from '$lib/schemas/task-system-failure-detection.schema.js';

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }));

vi.mock('$lib/api/client.js', () => ({ apiGet: mockGet, apiPut: mockPut }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));

import CircuitBreakerStatus from './CircuitBreakerStatus.svelte';

function entry(over: Partial<CircuitFleetEntry>): CircuitFleetEntry {
    return {
        taskId: 'lumastra-intro-analyzer',
        state: 'closed',
        consecutiveFailures: 0,
        openedAt: null,
        openedReason: null,
        nextProbeAt: null,
        forceEnabled: false,
        lastErrorMessage: 'orphaned_at_recovery',
        ...over,
    };
}

function respond(e: CircuitFleetEntry): void {
    mockGet.mockResolvedValue({
        data: { entries: [e], summary: { open: 0, halfOpen: 0, forceEnabled: 0, total: 1 } },
        error: null,
    });
}

describe('CircuitBreakerStatus', () => {
    beforeEach(() => vi.clearAllMocks());

    test('a healthy task offers no Resume and asks no "why was this paused"', async () => {
        respond(entry({}));
        render(CircuitBreakerStatus, { taskId: 'lumastra-intro-analyzer' });
        await waitFor(() =>
            expect(screen.getByText(m.admin_task_stat_circuit_value_closed())).toBeTruthy(),
        );
        expect(screen.queryByText(m.admin_circuit_resume_now())).toBeNull();
        expect(screen.queryByText(m.admin_circuit_learn_more_summary())).toBeNull();
        expect(screen.getByText(m.admin_circuit_learn_more_summary_idle())).toBeTruthy();
    });

    test('a runner code is shown in words, never verbatim', async () => {
        respond(entry({}));
        const { container } = render(CircuitBreakerStatus, { taskId: 'lumastra-intro-analyzer' });
        await waitFor(() => expect(container.textContent).toContain(m.admin_run_error_orphaned()));
        expect(container.textContent).not.toContain('orphaned_at_recovery');
    });

    test('a paused task still offers Resume', async () => {
        respond(entry({ state: 'open', consecutiveFailures: 5 }));
        render(CircuitBreakerStatus, { taskId: 'lumastra-intro-analyzer' });
        await waitFor(() => expect(screen.getByText(m.admin_circuit_resume_now())).toBeTruthy());
    });

    test('a failed lookup is shown as such, never as "running normally"', async () => {
        mockGet.mockResolvedValue({ data: null, error: 'Service unavailable' });
        render(CircuitBreakerStatus, { props: { taskId: 'lumastra-intro-analyzer' } });

        await waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain(
                m.admin_circuit_state_unavailable(),
            ),
        );
        expect(screen.queryByText(m.admin_circuit_running_normally())).toBeNull();
    });
});
