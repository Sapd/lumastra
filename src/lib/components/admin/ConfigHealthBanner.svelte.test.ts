// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A failed configuration check is shown as such — it used to render nothing,
 * exactly like "no issues".
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

vi.mock('$app/state', () => ({ page: { data: {}, url: new URL('http://localhost/admin') } }));
const getConfigHealth = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ getConfigHealth }));

import ConfigHealthBanner from './ConfigHealthBanner.svelte';

afterEach(() => {
    cleanup();
    getConfigHealth.mockReset();
});

describe('ConfigHealthBanner', () => {
    it('says the check could not run, and Retry shows the real report', async () => {
        getConfigHealth.mockResolvedValueOnce({ data: null, error: 'Service unavailable' });
        render(ConfigHealthBanner);

        await waitFor(() =>
            expect(screen.getByText(m.admin_config_health_unavailable())).toBeTruthy(),
        );

        getConfigHealth.mockResolvedValueOnce({
            data: {
                issues: [
                    { code: 'x', severity: 'error', message: 'Embedding dimensions mismatch' },
                ],
                errorCount: 1,
                warningCount: 0,
            },
            error: null,
        });
        await fireEvent.click(screen.getByRole('button', { name: m.common_retry() }));

        await waitFor(() => expect(screen.getByText('Embedding dimensions mismatch')).toBeTruthy());
        expect(screen.queryByText(m.admin_config_health_unavailable())).toBeNull();
    });

    it('no issues renders nothing', async () => {
        getConfigHealth.mockResolvedValue({
            data: { issues: [], errorCount: 0, warningCount: 0 },
            error: null,
        });
        const { container } = render(ConfigHealthBanner);
        await waitFor(() => expect(getConfigHealth).toHaveBeenCalled());
        expect(container.textContent?.trim()).toBe('');
    });
});
