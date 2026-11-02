// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The Backlog tab said "17 seasons pending" for the intro analyzer while the
 * Overview tile beside it said "Backlog 0". All 17 were a stage the task
 * reports as `ineligible` (seasons with one episode) — items it will never
 * process. They are shown apart from, not added to, the waiting count.
 */

import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import { setLocale } from '$lib/paraglide/runtime.js';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: mockGet }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({ runSSEBus: { onAnyChange: () => () => {} } }));

import BacklogCard from './BacklogCard.svelte';

describe('BacklogCard', () => {
    afterEach(() => {
        setLocale('en', { reload: false });
    });

    test('ineligible items are not counted as waiting', async () => {
        mockGet.mockResolvedValue({
            data: {
                unitLabel: 'seasons',
                stages: [{ id: 'ineligible', label: 'Ineligible (< 2 episodes)', count: 17 }],
            },
            error: null,
        });
        render(BacklogCard, { taskId: 'lumastra-intro-analyzer' });
        await waitFor(() =>
            expect(
                screen.getByText(m.admin_task_backlog_waiting({ count: '0', unit: 'seasons' })),
            ).toBeTruthy(),
        );
        expect(
            screen.getByText(
                m.admin_task_backlog_not_processable({ count: '17', unit: 'seasons' }),
            ),
        ).toBeTruthy();
        expect(screen.getByText('Ineligible (< 2 episodes)')).toBeTruthy();
    });

    test('shows the file-link unit in German', async () => {
        setLocale('de', { reload: false });
        mockGet.mockResolvedValue({
            data: {
                unitLabel: 'file links',
                stages: [{ id: 'remaining', label: 'Remaining', count: 1 }],
            },
            error: null,
        });
        render(BacklogCard, { taskId: 'trickplay-params-sync' });
        await waitFor(() => expect(screen.getByText('1 Dateiverknüpfungen warten')).toBeTruthy());
    });

    test('keeps terminal file errors out of the runnable count', async () => {
        setLocale('de', { reload: false });
        mockGet.mockResolvedValue({
            data: {
                unitLabel: 'file links',
                stages: [{ id: 'failed', label: 'Failed', count: 1 }],
            },
            error: null,
        });
        render(BacklogCard, { taskId: 'trickplay-params-sync' });
        await waitFor(() => expect(screen.getByText('0 Dateiverknüpfungen warten')).toBeTruthy());
        expect(screen.getByText('Fehlgeschlagene Dateiverknüpfungen: 1')).toBeTruthy();
    });
});
