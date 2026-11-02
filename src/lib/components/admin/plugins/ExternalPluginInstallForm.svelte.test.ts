// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "Check first" — the dry-run install preview.
 *
 * The endpoint has existed since the catalog work with nothing calling it, so
 * operators installed blind. What matters in wiring it up is not that a panel
 * appears, but that it cannot mislead:
 *
 *  - a verdict must never outlive the manifest it was computed for, or
 *    "signed by an official key" ends up sitting above a URL the operator has
 *    since edited;
 *  - a refusal must read as a refusal, not as a successful check;
 *  - preview must stay advisory, because requiring it would train people to
 *    click through it and the install path re-checks everything server-side.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockPreview, mockInstall } = vi.hoisted(() => ({
    mockPreview: vi.fn(),
    mockInstall: vi.fn(),
}));

vi.mock('$lib/api/admin.js', () => ({
    previewExternalPlugin: mockPreview,
    installExternalPlugin: mockInstall,
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import ExternalPluginInstallForm from './ExternalPluginInstallForm.svelte';

function ok(over: Record<string, unknown> = {}) {
    return {
        data: {
            name: 'Acme Scrobbler',
            version: '2.1.0',
            kinds: ['task', 'integration'],
            sdkAbi: 3,
            signingKeyId: 'key-abc',
            signingKeySource: 'official',
            metadata: null,
            mode: 'install',
            blockedReason: null,
            ...over,
        },
        error: null,
    };
}

async function openFormAndFill() {
    render(ExternalPluginInstallForm, {
        installEnabled: true,
        trustedKeysConfigured: true,
        onchanged: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: /install a plugin|install/i }));
    const url = screen.getByPlaceholderText('https://…/manifest.json');
    await fireEvent.input(url, { target: { value: 'https://example.com/manifest.json' } });
    const sig = document.querySelector('textarea') as HTMLTextAreaElement;
    await fireEvent.input(sig, { target: { value: 'sig-data' } });
    return { url, sig };
}

describe('ExternalPluginInstallForm — check first', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(cleanup);

    it('sends only the manifest URL and signature — never checksum or force', async () => {
        // A preview that carried `force` would be a rehearsal of a forced
        // install and could report "would install" for a path the plain
        // install refuses.
        mockPreview.mockResolvedValue(ok());
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));

        await waitFor(() => expect(mockPreview).toHaveBeenCalled());
        expect(mockPreview.mock.calls[0][0]).toEqual({
            manifestUrl: 'https://example.com/manifest.json',
            signature: 'sig-data',
        });
    });

    it('reports the host verdict — which key matched, and what it adds', async () => {
        mockPreview.mockResolvedValue(ok());
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));

        await waitFor(() => expect(screen.getByText(/Acme Scrobbler/)).toBeTruthy());
        expect(screen.getByText(/official Lumastra key/)).toBeTruthy();
        expect(screen.getByText(/key-abc/)).toBeTruthy();
        expect(screen.getByText(/This would install\./)).toBeTruthy();
    });

    it('distinguishes an operator-added key from an official one', async () => {
        // Collapsing these would let a self-signed plugin read as vendor-blessed.
        mockPreview.mockResolvedValue(ok({ signingKeySource: 'operator' }));
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));

        await waitFor(() => expect(screen.getByText(/key you added yourself/)).toBeTruthy());
        expect(screen.queryByText(/official Lumastra key/)).toBeNull();
    });

    it('shows a refusal as a refusal', async () => {
        mockPreview.mockResolvedValue(
            ok({ blockedReason: 'version 2.1.0 is older than the installed 3.0.0' }),
        );
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));

        await waitFor(() => expect(screen.getByText(/would not install/)).toBeTruthy());
        expect(screen.queryByText(/This would install\./)).toBeNull();
    });

    it('names the version it would replace', async () => {
        mockPreview.mockResolvedValue(ok({ installedVersion: '1.4.2', mode: 'upgrade' }));
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));
        await waitFor(() =>
            expect(screen.getByText(/replace the installed version 1\.4\.2/)).toBeTruthy(),
        );
    });

    it('DISCARDS the verdict when the manifest URL changes', async () => {
        // The load-bearing one: a stale "signed by an official key" sitting
        // above a different URL is worse than showing nothing.
        mockPreview.mockResolvedValue(ok());
        const { url } = await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));
        await waitFor(() => expect(screen.getByText(/Acme Scrobbler/)).toBeTruthy());

        await fireEvent.input(url, {
            target: { value: 'https://elsewhere.example/manifest.json' },
        });
        await waitFor(() => expect(screen.queryByText(/Acme Scrobbler/)).toBeNull());
    });

    it('DISCARDS the verdict when the signature changes', async () => {
        mockPreview.mockResolvedValue(ok());
        const { sig } = await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));
        await waitFor(() => expect(screen.getByText(/Acme Scrobbler/)).toBeTruthy());

        await fireEvent.input(sig, { target: { value: 'a-different-signature' } });
        await waitFor(() => expect(screen.queryByText(/Acme Scrobbler/)).toBeNull());
    });

    it('drops a verdict that arrives after the URL was edited mid-check', async () => {
        let resolve!: (v: unknown) => void;
        mockPreview.mockReturnValue(new Promise((r) => (resolve = r)));
        const { url } = await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));

        await fireEvent.input(url, {
            target: { value: 'https://elsewhere.example/manifest.json' },
        });
        resolve(ok());
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByText(/Acme Scrobbler/)).toBeNull();
    });

    it('leaves Install enabled without a preview — advisory, not a gate', async () => {
        await openFormAndFill();
        const install = screen.getByRole('button', { name: 'Install' });
        expect(install.hasAttribute('disabled')).toBe(false);
        expect(mockPreview).not.toHaveBeenCalled();
    });

    it('surfaces a failed check instead of implying success', async () => {
        mockPreview.mockResolvedValue({
            data: { error: 'signature verification failed' },
            error: null,
        });
        await openFormAndFill();
        await fireEvent.click(screen.getByRole('button', { name: 'Check first' }));
        await waitFor(() => expect(screen.getByText(/signature verification failed/)).toBeTruthy());
        expect(screen.queryByText(/This would install\./)).toBeNull();
    });
});
