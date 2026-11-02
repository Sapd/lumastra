// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client', () => ({ apiGet }));

import GithubReportDialog from './GithubReportDialog.svelte';
import * as m from '$lib/paraglide/messages.js';

const issueUrl = 'https://github.com/Sapd/lumastra/issues/new?template=jellyfin-client.yml';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('GithubReportDialog', () => {
    it('shows the redacted preview, an issue link and a report download', async () => {
        apiGet.mockResolvedValue({ data: { markdown: 'M-PREVIEW', issueUrl, report: { a: 1 } } });
        const createObjectURL = vi.fn(() => 'blob:x');
        const revokeObjectURL = vi.fn();
        Object.assign(URL, { createObjectURL, revokeObjectURL });

        render(GithubReportDialog, { diagnosticId: 7, open: true, onclose: vi.fn() });

        await waitFor(() => expect(screen.getByText('M-PREVIEW')).toBeTruthy());
        expect(apiGet.mock.calls[0][0]).toBe('/api/admin/diagnostics/7/github-report');
        const link = screen.getByRole('link', { name: m.admin_clientdiag_report_open() });
        expect(link.getAttribute('href')).toBe(issueUrl);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');

        await fireEvent.click(
            screen.getByRole('button', { name: m.admin_clientdiag_report_download() }),
        );
        expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('shows the log excerpt in the main preview, not only inside the collapsed JSON', async () => {
        apiGet.mockResolvedValue({
            data: { markdown: 'M', issueUrl, report: { logExcerpt: 'LOG-LINE-1\nLOG-LINE-2' } },
        });
        render(GithubReportDialog, { diagnosticId: 7, open: true, onclose: vi.fn() });
        const pre = await screen.findByTestId('github-report-log');
        expect(pre.textContent).toBe('LOG-LINE-1\nLOG-LINE-2');
        expect(pre.closest('details')).toBeNull();
        expect(screen.getByText(m.admin_clientdiag_report_log())).toBeTruthy();
    });

    it('shows no log section for a report without an excerpt', async () => {
        apiGet.mockResolvedValue({ data: { markdown: 'M2', issueUrl, report: { a: 1 } } });
        render(GithubReportDialog, { diagnosticId: 7, open: true, onclose: vi.fn() });
        await waitFor(() => expect(screen.getByText('M2')).toBeTruthy());
        expect(screen.queryByTestId('github-report-log')).toBeNull();
    });

    it('shows an error and no issue link when the report cannot be built', async () => {
        apiGet.mockResolvedValue({ data: null, error: 'nope' });
        render(GithubReportDialog, { diagnosticId: 7, open: true, onclose: vi.fn() });
        await waitFor(() =>
            expect(screen.getByText(m.admin_clientdiag_report_error())).toBeTruthy(),
        );
        expect(screen.queryByRole('link', { name: m.admin_clientdiag_report_open() })).toBeNull();
    });

    it('fetches nothing while closed', () => {
        render(GithubReportDialog, { diagnosticId: 7, open: false, onclose: vi.fn() });
        expect(apiGet).not.toHaveBeenCalled();
    });
});
