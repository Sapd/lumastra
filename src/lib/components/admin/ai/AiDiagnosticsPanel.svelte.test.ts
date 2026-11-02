// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet }));

import AiDiagnosticsPanel from './AiDiagnosticsPanel.svelte';

afterEach(cleanup);

describe('AiDiagnosticsPanel', () => {
    it('names a vector-width mismatch instead of an empty failure headline', async () => {
        // The probe answers ok:true, matches:false and no error for this case.
        apiGet.mockResolvedValueOnce({
            data: { ok: true, provider: 'openai', dimension: 768, expected: 1536, matches: false },
            error: null,
        });
        render(AiDiagnosticsPanel);
        await fireEvent.click(screen.getAllByRole('button', { name: 'Test' })[0]);
        await waitFor(() => expect(screen.getByText(/Dimension mismatch/)).toBeTruthy());
        expect(screen.getByText(/returned 768 dimensions, the database expects 1536/)).toBeTruthy();
    });
});
