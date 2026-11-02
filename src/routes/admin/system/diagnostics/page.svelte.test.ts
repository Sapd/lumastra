// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Wiring proof for the debug report page (/admin/system/diagnostics).
 *
 * The page renders what the server sends through the SAME formatter the server uses
 * for format=md, so these tests drive the real page with a real (redacted) report and
 * assert on what the admin sees and what goes over the wire: the preview, the export
 * buttons, the include toggles on the request, the 429 message, and the agent-token
 * form (scope, expiry, and the token shown once).
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import type { DebugReport } from '$lib/schemas/debug-report.js';

// The `$lib/components/admin` barrel transitively reaches a component that
// reads `$env/dynamic/public`, a virtual module with no runtime backing under
// vitest. Mocked per the repo-wide pattern so the graph evaluates.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin') }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn() },
}));

const { apiGet, createServiceToken } = vi.hoisted(() => ({
    apiGet: vi.fn(),
    createServiceToken: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet }));
vi.mock('$lib/api/admin.js', () => ({
    addNavPin: vi.fn(),
    removeNavPin: vi.fn(),
    createServiceToken,
}));

import DebugReportPage from './+page.svelte';

const ZERO_COUNTS = {
    secret: 0,
    token: 0,
    url: 0,
    host: 0,
    ip: 0,
    email: 0,
    path: 0,
    file: 0,
    opaque: 0,
    sweep: 0,
};

/** A small, redacted, schema-shaped report. Mirrors the formatter's own fixture. */
function makeReport(overrides: Partial<DebugReport> = {}): DebugReport {
    return {
        schemaVersion: 1,
        generatedAt: '2026-10-21T10:00:00.000Z',
        redaction: {
            options: { includeHostnames: false, includePaths: false },
            counts: { ...ZERO_COUNTS, secret: 2, host: 1 },
            secretSweepHits: 0,
            notes: ['Secrets are removed.'],
        },
        links: {
            self: '/api/v1/admin/debug-report',
            markdown: '/api/v1/admin/debug-report?format=md',
            health: '/api/v1/admin/debug-report/health',
            run: '/api/v1/admin/debug-report/runs/{runId}',
            clientDiagnosticGroup: '/api/v1/admin/debug-report/client-diagnostics/{fingerprint}',
            clusterNode: '/api/v1/admin/debug-report/cluster/nodes/{instanceId}',
            llmsTxt: '/llms.txt',
            apiDocs: '/api-docs?format=md',
        },
        instance: {
            status: 'ok',
            version: '0.1.0',
            commit: 'abcdef1234567890abcdef1234567890abcdef12',
            commitShort: 'abcdef1',
            buildTime: '2026-10-21T00:00:00.000Z',
            installType: 'kubernetes',
            node: { version: 'v26.8.2', platform: 'linux', arch: 'x64', containerized: true },
            database: { postgresVersion: 'PostgreSQL 18.1', pgvectorVersion: '0.8.0' },
            valkeySplit: true,
            migrations: {
                current: '16.412.0',
                appliedCount: 110,
                pending: [{ version: '16.413.0', name: 'pending_one' }],
            },
        },
        health: {
            status: 'ok',
            ready: {
                orchestrator: true,
                database: true,
                valkey: true,
                cache: 'ok',
                worker: 'present',
                leader: false,
            },
            components: [{ name: 'database', status: 'fail', reason: 'ECONNREFUSED <host>' }],
            findings: [],
            href: '/api/v1/admin/debug-report/health',
        },
        cluster: { status: 'ok', nodes: [], sidecars: [{ name: 'sonic', reachable: 'yes' }] },
        tasks: {
            status: 'ok',
            failedRuns: [],
            queue: { depth: 5, activeRuns: 1, snapshotAt: '2026-10-21T10:00:00.000Z' },
            staleScans: 0,
            lastScans: [],
            pluginFailures: [],
        },
        library: {
            status: 'ok',
            mediaHealthIssues: [{ type: 'missing_file', count: 4 }],
            integrityViolations: [{ rule: 'orphan_file', count: 3 }],
        },
        serverErrors: { status: 'unavailable', note: 'Read the container log or the log backend.' },
        clientDiagnostics: { status: 'ok', windowHours: 24, groups: [] },
        settings: {
            status: 'ok',
            entries: [{ key: 'LOG_LEVEL', source: 'default', set: true, value: 'info' }],
        },
        integrations: {
            status: 'ok',
            items: [{ name: 'Jellyfin', configured: true, reachable: 'yes' }],
        },
        ...overrides,
    };
}

async function renderPage(): Promise<void> {
    apiGet.mockResolvedValue({ data: makeReport(), error: null, status: 200 });
    render(DebugReportPage);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    await screen.findByText(/# Lumastra debug report/);
}

describe('/admin/system/diagnostics — debug report', () => {
    afterEach(() => {
        cleanup();
        apiGet.mockReset();
        createServiceToken.mockReset();
    });

    it('fetches the JSON report and previews the Markdown with copy and download', async () => {
        await renderPage();

        expect(apiGet.mock.calls[0][0]).toBe('/api/admin/debug-report?format=json');
        expect(screen.getByRole('button', { name: /copy report/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /download \.md/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /download json/i })).toBeTruthy();
        expect(
            (screen.getByRole('button', { name: /copy report/i }) as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('sends include= when a toggle is turned on, and warns while it is on', async () => {
        await renderPage();

        apiGet.mockResolvedValue({
            data: makeReport({
                redaction: {
                    options: { includeHostnames: true, includePaths: false },
                    counts: ZERO_COUNTS,
                    secretSweepHits: 0,
                    notes: [],
                },
            }),
            error: null,
            status: 200,
        });
        await fireEvent.change(screen.getByRole('checkbox', { name: /include host names/i }), {
            target: { checked: true },
        });

        await waitFor(() =>
            expect(apiGet).toHaveBeenLastCalledWith(
                '/api/admin/debug-report?format=json&include=hostnames',
                expect.anything(),
            ),
        );
        expect(
            await screen.findByText(/host names or file paths are in this report/i),
        ).toBeTruthy();
    });

    it('asks for both toggles together as one comma list', async () => {
        await renderPage();

        await fireEvent.change(screen.getByRole('checkbox', { name: /include host names/i }), {
            target: { checked: true },
        });
        // The toggles are disabled while a load is in flight; wait for the first to settle.
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
        await waitFor(() =>
            expect(
                (screen.getByRole('checkbox', { name: /include paths/i }) as HTMLInputElement)
                    .disabled,
            ).toBe(false),
        );
        await fireEvent.change(screen.getByRole('checkbox', { name: /include paths/i }), {
            target: { checked: true },
        });

        await waitFor(() =>
            expect(apiGet).toHaveBeenLastCalledWith(
                '/api/admin/debug-report?format=json&include=hostnames,paths',
                expect.anything(),
            ),
        );
    });

    it('shows a friendly message on 429 and disables export until a report loads', async () => {
        await renderPage();

        apiGet.mockResolvedValue({ data: null, error: 'Too Many Requests', status: 429 });
        await fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

        expect(await screen.findByText(/wait a few seconds and refresh/i)).toBeTruthy();
        expect(
            (screen.getByRole('button', { name: /copy report/i }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    it('creates an agent token with the diagnostics:read scope and shows it once', async () => {
        createServiceToken.mockResolvedValue({
            data: { id: 7, token: 'svc_test_token_value' },
            error: null,
            status: 201,
        });
        apiGet.mockResolvedValue({ data: makeReport(), error: null, status: 200 });
        render(DebugReportPage);
        await waitFor(() => expect(apiGet).toHaveBeenCalled());

        await fireEvent.click(screen.getByRole('button', { name: /create token/i }));

        await waitFor(() =>
            expect(createServiceToken).toHaveBeenCalledWith(
                expect.objectContaining({ scopes: ['diagnostics:read'], expiresInDays: 7 }),
            ),
        );
        expect(await screen.findByDisplayValue('svc_test_token_value')).toBeTruthy();
        expect(screen.getByText(/it is shown once/i)).toBeTruthy();
        expect(screen.getByText(/LUMASTRA_DIAGNOSTICS_TOKEN=/)).toBeTruthy();
    });
});
