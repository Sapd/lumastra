// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * First-run wizard (/setup) client behaviour found in the 2026-10-07 review:
 * what the page sends and shows when a request is slow, fails, or was already
 * answered. The server side of each request has its own route tests.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import type { z } from 'zod';

type ApiResult = { data: unknown; error: string | null; status: number };

const api = vi.hoisted(() => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    apiPut: vi.fn(),
}));
const toasts = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
}));

vi.mock('$lib/api/client.js', () => api);
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
vi.mock('$lib/paths', () => ({ url: (p: string) => `/base${p}`, base: '/base' }));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn(async () => undefined) }));
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/setup'), data: {} }),
}));

import SetupPage from './+page.svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
import * as m from '$lib/paraglide/messages.js';
afterEach(() => overwriteGetLocale(originalGetLocale));

it('shows the server-resolved callback URL including subpath or explicit override', async () => {
    render(SetupPage, {
        props: {
            data: pageData({
                oidcCallbackUrl: 'https://public.example/media/auth/oidc/callback',
            }) as never,
        },
    });
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('https://public.example/media/auth/oidc/callback')).toBeTruthy();
});

/** Step-3 hydration as the load builds it for a fresh install (schema defaults). */
function preferences(
    overrides: {
        values?: Record<string, unknown>;
        envLocked?: string[];
        useCases?: string[];
    } = {},
): Record<string, unknown> {
    return {
        values: {
            appName: 'Lumastra',
            gpuAcceleration: 'none',
            metadataStorageLocation: 'central',
            trickplayEnabled: false,
            autoLyrics: true,
            introAnalyzer: true,
            gravatar: false,
            unratedContentVisible: false,
            shareActivityBetweenUsers: true,
            defaultActivitySharing: true,
            showUnavailableMedia: false,
            backchannelLogoutCascade: false,
            jellyfinCompat: true,
            subsonicCompat: false,
            publicApi: true,
            licenseServerContact: true,
            ...overrides.values,
        },
        envLocked: overrides.envLocked ?? [],
        useCases: overrides.useCases ?? [],
    };
}

/** The install overview as the load builds it (step "Check your install"). */
const ENVIRONMENT = {
    services: {
        valkey: true,
        sonic: 'absent',
        liveTvProxy: 'absent',
        gpu: 'none',
        gpuDevice: false,
    },
    database: { postgres: '18.1', pgvector: '0.8.0', dimension: 1024 },
    storage: { config: 'ok' },
    nodes: [],
    cluster: { versionMismatch: false, keyMismatch: false, noWorker: false },
    network: { proxy: 'direct', https: false, platform: 'docker' },
};

function pageData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        preferences: preferences(),
        forwardAuth: null,
        forwardAuthRejected: null,
        forwardAuthEnabled: false,
        forwardAuthDisabledHeaders: false,
        wideTrustedProxyRanges: [],
        adminGroups: ['admin'],
        proxyPosture: 'fail-closed',
        transport: 'ok',
        // No overview by default, so the wizard opens on the sign-in step.
        environment: null,
        environmentDetails: null,
        configDir: null,
        masterKeySource: 'file',
        oidcEnabled: false,
        oidcProviderName: 'Single Sign-On',
        oidcConfig: { issuer: '', clientId: '', scopes: '', groupsClaim: '', hasSecret: false },
        oidcIssues: [],
        resume: false,
        embeddingDimension: 1024,
        integrations: {
            hasTmdb: false,
            hasMdblist: false,
            hasEmbedding: false,
            hasDiscogsToken: false,
            hasLastfmKey: false,
        },
        jellyfinCompat: true,
        subsonicCompat: false,
        publicApi: true,
        metadataLanguage: { tmdbLanguage: null, additionalLanguages: [] },
        assistant: {
            enabled: false,
            provider: 'openai',
            hasOpenaiKey: false,
            hasAnthropicKey: false,
            openaiModel: '',
            anthropicModel: '',
        },
        ...overrides,
    };
}

const ok = (data: unknown = {}): ApiResult => ({ data, error: null, status: 200 });

/** Resolve-later handle for a request the test wants to keep in flight. */
function deferred(): { promise: Promise<ApiResult>; resolve: (r: ApiResult) => void } {
    let resolve: (r: ApiResult) => void = () => undefined;
    const promise = new Promise<ApiResult>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/**
 * Choose a <select> option. Svelte's `bind:value` reads the choice with
 * `select.querySelector(':checked')`, which happy-dom never matches for an
 * <option>, so answer that one query from `selectedIndex`.
 */
async function pick(select: HTMLSelectElement, value: string): Promise<void> {
    if (!('pickShim' in select.dataset)) {
        const original = select.querySelector.bind(select);
        select.querySelector = ((selector: string) =>
            selector === ':checked'
                ? select.options[select.selectedIndex]
                : original(selector)) as typeof select.querySelector;
        select.dataset.pickShim = '';
    }
    select.value = value;
    await fireEvent.change(select);
}

/** Bodies the page POSTed to `path`. */
function postedTo(path: string): Record<string, unknown>[] {
    return api.apiPost.mock.calls.filter((c) => c[0] === path).map((c) => c[2]);
}

async function fillAdminForm(): Promise<void> {
    // Single sign-on is pre-selected; these tests take the built-in login path.
    await fireEvent.click(screen.getByRole('button', { name: /built-in login/i }));
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await fireEvent.input(document.getElementById('admin-username') as HTMLInputElement, {
        target: { value: 'owner' },
    });
    const pw = 'Correct-Horse-Battery-42!';
    await fireEvent.input(document.getElementById('admin-password') as HTMLInputElement, {
        target: { value: pw },
    });
    await fireEvent.input(document.getElementById('admin-confirm') as HTMLInputElement, {
        target: { value: pw },
    });
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    api.apiGet.mockResolvedValue(ok(null));
    api.apiPost.mockResolvedValue(ok());
    api.apiPut.mockResolvedValue(ok());
    reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload, assign: vi.fn() });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('/setup — creating the first admin', () => {
    it('keeps Back disabled while the create request is in flight', async () => {
        render(SetupPage, { props: { data: pageData() as never } });
        await fillAdminForm();
        const pending = deferred();
        api.apiPost.mockImplementation((path: string) =>
            path === '/api/auth/native/setup' ? pending.promise : Promise.resolve(ok()),
        );

        await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));
        const back = screen.getByRole('button', { name: /^back$/i }) as HTMLButtonElement;
        expect(back.disabled).toBe(true);
        // A stale success landing after Back would have jumped from step 1 to 3.
        await fireEvent.click(back);
        expect(document.getElementById('admin-username')).not.toBeNull();

        pending.resolve(ok({ redirect: '/admin/library/sources' }));
        await waitFor(() => expect(document.getElementById('admin-username')).toBeNull());
        // The clicked button is gone with step 2; focus lands on the new heading.
        await waitFor(() =>
            expect(document.activeElement).toBe(document.querySelector('.setup-title')),
        );
    });

    it('reloads on 409 (setup already done, e.g. a lost response) instead of showing a failure', async () => {
        render(SetupPage, { props: { data: pageData() as never } });
        await fillAdminForm();
        api.apiPost.mockResolvedValue({
            data: null,
            error: 'Setup has already been completed.',
            status: 409,
        });

        await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

        await waitFor(() => expect(reload).toHaveBeenCalled());
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('warns when the server removed OIDC settings saved before the admin existed', async () => {
        render(SetupPage, { props: { data: pageData() as never } });
        await fillAdminForm();
        api.apiPost.mockResolvedValue(ok({ oidcConfigDiscarded: true }));

        await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));

        await waitFor(() => expect(toasts.warning).toHaveBeenCalledTimes(1));
        expect(String(toasts.warning.mock.calls[0][0])).toMatch(/single sign-on/i);
    });
});

describe('/setup — step 3 (resumed admin)', () => {
    // Skip used to leave the wizard for Admin → Library → Sources while /setup
    // still resumed at "Step 4 of 5"; the library step was only reachable
    // through Save & continue.
    it('Skip for now moves on to the library step without saving anything', async () => {
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        expect(screen.getByText('Step 4 of 5')).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

        expect(
            await screen.findByRole('heading', { name: /add your first library/i }),
        ).toBeTruthy();
        expect(screen.getByText('Step 5 of 5')).toBeTruthy();
        expect(window.location.assign).not.toHaveBeenCalled();
        expect(api.apiPost).not.toHaveBeenCalled();
        expect(api.apiPut).not.toHaveBeenCalled();
    });

    it('names the local host and explains that other nodes have not been checked', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'local-node',
                          recommended: null,
                          onlyLocalHost: true,
                          hosts: [
                              {
                                  id: 'local',
                                  hostname: 'local-node',
                                  local: true,
                                  transcodeEligible: true,
                                  gpus: [],
                                  recommended: null,
                                  verified: false,
                              },
                          ],
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        expect(await screen.findByText('local-node')).toBeTruthy();
        expect(screen.getByText(/other nodes have not been checked yet/i)).toBeTruthy();
    });

    it.each([
        { optIn: false, verified: false },
        { optIn: true, verified: false },
        { optIn: false, verified: undefined },
    ])(
        'requires opt-in to an unverified worker GPU on fresh setup: %j',
        async ({ optIn, verified }) => {
            api.apiGet.mockImplementation((path: string) =>
                Promise.resolve(
                    path === '/api/setup/gpu-detect'
                        ? ok({
                              hostname: 'web-node',
                              recommended: 'nvenc',
                              recommendedVendor: 'NVIDIA',
                              recommendedHost: 'gpu-worker',
                              recommendationVerified: verified,
                              onlyLocalHost: false,
                              hosts: [
                                  {
                                      id: 'web',
                                      hostname: 'web-node',
                                      local: true,
                                      transcodeEligible: false,
                                      gpus: [],
                                      recommended: null,
                                      verified: false,
                                  },
                                  {
                                      id: 'worker',
                                      hostname: 'gpu-worker',
                                      local: false,
                                      transcodeEligible: true,
                                      gpus: ['NVIDIA RTX 4070'],
                                      recommended: 'nvenc',
                                      verified: false,
                                  },
                              ],
                          })
                        : ok(null),
                ),
            );
            render(SetupPage, { props: { data: pageData() as never } });
            await fillAdminForm();
            await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));
            expect(await screen.findByText('gpu-worker')).toBeTruthy();
            expect(screen.getByText('web-node')).toBeTruthy();
            expect(screen.getByText(/encoder has not been tested/i)).toBeTruthy();
            expect(screen.queryByText(/found and tested/i)).toBeNull();
            const toggle = screen.getByRole('switch', { name: /use it for hardware transcoding/i });
            expect(toggle.getAttribute('aria-checked')).toBe('false');
            if (optIn) await fireEvent.click(toggle);
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
            expect(postedTo('/api/setup/preferences')[0].gpuAcceleration).toBe(
                optIn ? 'nvenc' : 'none',
            );
        },
    );

    it('shows both CPU-only hosts without claiming that the local result covers the cluster', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'web-node',
                          recommended: null,
                          onlyLocalHost: false,
                          hosts: ['web-node', 'cpu-worker'].map((hostname) => ({
                              id: hostname,
                              hostname,
                              local: hostname === 'web-node',
                              transcodeEligible: hostname === 'cpu-worker',
                              gpus: [],
                              recommended: null,
                              verified: false,
                          })),
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        expect(await screen.findByText('cpu-worker')).toBeTruthy();
        expect(screen.getByText('web-node')).toBeTruthy();
        expect(screen.queryByText(/other nodes have not been checked yet/i)).toBeNull();
    });

    it('rechecks a GPU recommendation without re-enabling a fresh-install choice to use the CPU', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'web-node',
                          recommended: 'nvenc',
                          recommendedVendor: 'NVIDIA',
                          recommendedHost: 'gpu-worker',
                          recommendationVerified: true,
                          onlyLocalHost: false,
                          hosts: [
                              {
                                  id: 'worker',
                                  hostname: 'gpu-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: ['NVIDIA'],
                                  recommended: 'nvenc',
                                  verified: false,
                              },
                          ],
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData() as never } });
        await fillAdminForm();
        await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));
        const toggle = await screen.findByRole('switch', {
            name: /use it for hardware transcoding/i,
        });
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        await fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
        await waitFor(() =>
            expect(
                api.apiGet.mock.calls.filter(([path]) => path === '/api/setup/gpu-detect'),
            ).toHaveLength(2),
        );
        await waitFor(() =>
            expect(
                screen
                    .getByRole('switch', { name: /use it for hardware transcoding/i })
                    .getAttribute('aria-checked'),
            ).toBe('false'),
        );
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/setup/preferences')[0].gpuAcceleration).toBe('none');
    });

    it('warns which hosts support conflicting modes instead of offering a global GPU toggle', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'web-node',
                          recommended: null,
                          recommendationVerified: false,
                          modeConflict: true,
                          onlyLocalHost: false,
                          hosts: [
                              {
                                  id: 'intel',
                                  hostname: 'intel-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: ['Intel'],
                                  recommended: 'qsv',
                                  verified: true,
                              },
                              {
                                  id: 'nvidia',
                                  hostname: 'nvidia-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: ['NVIDIA'],
                                  recommended: 'nvenc',
                                  verified: false,
                              },
                          ],
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        const warning = await screen.findByText(/different GPU acceleration modes/i);
        expect(warning.textContent).toContain('intel-worker: qsv');
        expect(warning.textContent).toContain('nvidia-worker: nvenc');
        expect(warning.closest('[role="alert"]')).toBeTruthy();
        expect(
            screen.queryByRole('switch', { name: /use it for hardware transcoding/i }),
        ).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/setup/preferences')[0].gpuAcceleration).toBeUndefined();
    });

    it('shows only the success callout for a verified remote encoder, without a duplicate recommendation note', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'web-node',
                          recommended: 'nvenc',
                          recommendedVendor: 'NVIDIA',
                          recommendedHost: 'gpu-worker',
                          recommendationVerified: true,
                          onlyLocalHost: false,
                          hosts: [
                              {
                                  id: 'worker',
                                  hostname: 'gpu-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: ['NVIDIA'],
                                  recommended: 'nvenc',
                                  verified: true,
                              },
                          ],
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        expect(await screen.findByText(/found and tested/i)).toBeTruthy();
        expect(screen.queryByText(/^Recommended:/i)).toBeNull();
    });

    it('includes CPU-only workers in the global mode conflict warning', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({
                          hostname: 'web-node',
                          recommended: null,
                          modeConflict: true,
                          onlyLocalHost: false,
                          hosts: [
                              {
                                  id: 'gpu',
                                  hostname: 'gpu-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: ['NVIDIA'],
                                  recommended: 'nvenc',
                                  verified: true,
                              },
                              {
                                  id: 'cpu',
                                  hostname: 'cpu-worker',
                                  local: false,
                                  transcodeEligible: true,
                                  gpus: [],
                                  recommended: null,
                                  verified: false,
                              },
                          ],
                      })
                    : ok(null),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        const warning = await screen.findByText(/different GPU acceleration modes/i);
        expect(warning.textContent).toContain('gpu-worker: nvenc');
        expect(warning.textContent).toContain('cpu-worker: none');
    });

    it('does not send gpuAcceleration while GPU detection is still running', async () => {
        const gpu = deferred();
        api.apiGet.mockImplementation((path: string) =>
            path === '/api/setup/gpu-detect' ? gpu.promise : Promise.resolve(ok(null)),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        // 'none' here would have overwritten a saved GPU choice on every early save.
        // (undefined is dropped when the body is serialized)
        expect(postedTo('/api/setup/preferences')[0].gpuAcceleration).toBeUndefined();
        gpu.resolve(ok(null));
    });

    it('warns when saving the preferences failed', async () => {
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/preferences'
                    ? { data: null, error: 'boom', status: 500 }
                    : ok(),
            ),
        );
        render(SetupPage, {
            props: { data: pageData({ resume: true, publicApi: true }) as never },
        });

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
    });

    it('switching the embeddings provider drops the key typed for the previous one', async () => {
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        const provider = screen.getByLabelText(
            /AI recommendations \(embeddings\)/,
        ) as HTMLSelectElement;

        await pick(provider, 'openai');
        const key = await waitFor(() => {
            const el = document.getElementById('embed-key');
            expect(el).not.toBeNull();
            return el as HTMLInputElement;
        });
        await fireEvent.input(key, { target: { value: 'sk-openai-secret' } });

        await pick(provider, 'custom');

        await waitFor(() =>
            expect((document.getElementById('embed-key') as HTMLInputElement).value).toBe(''),
        );
    });

    it('keeps step 3 open when the embedding save probe fails and allows retry', async () => {
        let rejected = true;
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/integrations' && rejected
                    ? { data: null, error: 'Check the embedding API key.', status: 422 }
                    : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await pick(
            screen.getByLabelText(/AI recommendations \(embeddings\)/) as HTMLSelectElement,
            'openai',
        );
        await fireEvent.input(document.getElementById('embed-key') as HTMLInputElement, {
            target: { value: 'sk-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() =>
            expect(toasts.warning).toHaveBeenCalledWith('Check the embedding API key.'),
        );
        expect(screen.getByLabelText(/AI recommendations \(embeddings\)/)).toBeTruthy();
        expect(
            api.apiPost.mock.calls.some(([path]) => path === '/api/admin/instance-profile'),
        ).toBe(true);
        rejected = false;
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() =>
            expect(screen.queryByLabelText(/AI recommendations \(embeddings\)/)).toBeNull(),
        );
    });

    it('shows an outage warning, saves the instance profile and advances', async () => {
        const warning = 'Could not verify now; Lumastra will retry.';
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/integrations' ? ok({ ok: true, saved: true, warning }) : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await pick(
            screen.getByLabelText(/AI recommendations \(embeddings\)/) as HTMLSelectElement,
            'openai',
        );
        await fireEvent.input(document.getElementById('embed-key') as HTMLInputElement, {
            target: { value: 'sk-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(toasts.warning).toHaveBeenCalledWith(warning));
        expect(
            api.apiPost.mock.calls.some(([path]) => path === '/api/admin/instance-profile'),
        ).toBe(true);
        expect(api.apiPost.mock.calls.some(([path]) => path === '/api/setup/preferences')).toBe(
            true,
        );
        await waitFor(() =>
            expect(screen.queryByLabelText(/AI recommendations \(embeddings\)/)).toBeNull(),
        );
    });
});

describe('/setup — library step', () => {
    async function finishScan(status: () => Promise<ApiResult> | ApiResult): Promise<void> {
        api.apiGet.mockImplementation((path: string) =>
            path === '/api/setup/jellyfin'
                ? status()
                : Promise.resolve(
                      path === '/api/setup/library-mounts'
                          ? ok({ candidates: [{ path: '/data/Movies', entries: 3 }] })
                          : path === '/api/runs/scan-jf'
                            ? ok({ id: 'scan-jf', state: 'completed' })
                            : path === '/api/setup/media-count'
                              ? ok({ count: 3, metadataUnavailable: 0 })
                              : ok(null),
                  ),
        );
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, readable: true, runId: 'scan-jf' })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await fireEvent.click(
            await screen.findByRole('button', { name: /add 1 library and continue/i }),
        );
        await waitFor(() =>
            expect(api.apiGet.mock.calls.some(([path]) => path === '/api/setup/jellyfin')).toBe(
                true,
            ),
        );
    }

    it('backs status polling off to 30 seconds and stops after ten minutes with a Settings note', async () => {
        const initial = deferred();
        let first = true;
        const syncing = ok({
            configured: true,
            syncing: true,
            failed: false,
            paired: 2,
            waiting: 1,
        });
        await finishScan(() => {
            if (first) {
                first = false;
                return initial.promise;
            }
            return syncing;
        });
        vi.useFakeTimers();
        initial.resolve(syncing);
        await vi.advanceTimersByTimeAsync(0);
        const calls = (): number =>
            api.apiGet.mock.calls.filter(([path]) => path === '/api/setup/jellyfin').length;
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls()).toBe(2);
        await vi.advanceTimersByTimeAsync(2000);
        expect(calls()).toBe(2);
        await vi.advanceTimersByTimeAsync(600_000);
        expect(screen.getByText(/check.*settings/i)).toBeTruthy();
        const stopped = calls();
        expect(stopped).toBeLessThan(30);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls()).toBe(stopped);
    });

    it('shows cancellation as an automatic retry, not a failed sync', async () => {
        await finishScan(() =>
            ok({
                configured: true,
                syncing: false,
                failed: false,
                retrying: true,
                paired: 2,
                waiting: 1,
            }),
        );
        await waitFor(() =>
            expect(screen.getByText(/Jellyfin:.*retry automatically/i)).toBeTruthy(),
        );
        expect(screen.queryByText(/Jellyfin: watch sync could not finish/i)).toBeNull();
    });
    it('shows Jellyfin syncing after scans finish, then updates paired and waiting counts', async () => {
        let finished = false;
        let synced = false;
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-mounts'
                    ? ok({ candidates: [{ path: '/data/Movies', entries: 3 }] })
                    : path === '/api/runs/scan-jf'
                      ? ok({ id: 'scan-jf', state: finished ? 'completed' : 'active' })
                      : path === '/api/setup/media-count'
                        ? ok({ count: 3, metadataUnavailable: 0 })
                        : path === '/api/setup/jellyfin'
                          ? ok({
                                configured: true,
                                syncing: !synced,
                                failed: false,
                                paired: 2,
                                waiting: 1,
                            })
                          : ok(null),
            ),
        );
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, readable: true, runId: 'scan-jf' })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await fireEvent.click(
            await screen.findByRole('button', { name: /add 1 library and continue/i }),
        );
        expect(screen.queryByText(/Jellyfin: syncing watch history/i)).toBeNull();
        finished = true;
        await waitFor(
            () => expect(screen.getByText(/Jellyfin: syncing watch history/i)).toBeTruthy(),
            { timeout: 5000 },
        );
        synced = true;
        await waitFor(
            () => expect(screen.getByText(/Jellyfin: 2 titles paired, 1 waiting/i)).toBeTruthy(),
            { timeout: 5000 },
        );
    });
    it('holds the found-folders place while detection runs, above the manual form', async () => {
        let resolveMounts: (value: unknown) => void = () => {};
        api.apiGet.mockImplementation((path: string) =>
            path === '/api/setup/library-mounts'
                ? new Promise((resolve) => {
                      resolveMounts = resolve;
                  })
                : Promise.resolve(ok(null)),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        const status = await screen.findByText(/looking for media folders/i);
        const manual = document.getElementById('lib-path') as HTMLInputElement;
        expect(
            status.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        resolveMounts(ok({ candidates: [{ path: '/data/media/Filme', entries: 3 }] }));
        await screen.findByText('/data/media/Filme');
        expect(screen.queryByText(/looking for media folders/i)).toBeNull();
    });

    it('offers every folder library type, not only movies/TV/anime/music, and posts the one picked', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-mounts'
                    ? ok({ candidates: [{ path: '/data/media/Kurse', entries: 2 }] })
                    : ok(null),
            ),
        );
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, readable: true, runId: 'run-1' })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await screen.findByText('/data/media/Kurse');

        const expected = [
            'movie',
            'tv',
            'anime',
            'music',
            'home_video',
            'training',
            'educational',
            'personal',
        ];
        // Both pickers: the manual form's and the one next to each found folder.
        const selects = [...document.querySelectorAll('select')].filter((s) =>
            [...s.options].some((o) => o.value === 'movie'),
        );
        expect(selects.length).toBeGreaterThanOrEqual(2);
        for (const select of selects) {
            const values = [...select.options].map((o) => o.value).filter(Boolean);
            expect(values).toEqual(expected);
        }

        const manualPath = document.getElementById('lib-path') as HTMLInputElement;
        await fireEvent.input(manualPath, { target: { value: '/data/media/Family' } });
        const manualType = document.getElementById('lib-type') as HTMLSelectElement;
        await pick(manualType, 'home_video');
        await fireEvent.submit(manualPath.closest('form') as HTMLFormElement);
        await waitFor(() =>
            expect(
                api.apiPost.mock.calls.some(
                    ([path, , body]) =>
                        path === '/api/setup/library' &&
                        (body as { mediaType?: string }).mediaType === 'home_video',
                ),
            ).toBe(true),
        );
    });

    it('Continue adds the ticked folder suggestions before it moves on', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-mounts'
                    ? ok({
                          candidates: [
                              { path: '/data/media/Filme', entries: 3 },
                              { path: '/data/media/Serien', entries: 1 },
                              { path: '/data/media/Kinder', entries: 1 },
                          ],
                      })
                    : ok(null),
            ),
        );
        let run = 0;
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, readable: true, runId: `run-${++run}` })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        // Filme and Serien are named like a library: typed and ticked. Kinder holds
        // either type, so it waits for one and is not added.
        const primary = await screen.findByRole('button', {
            name: /add 2 libraries and continue/i,
        });
        expect(screen.queryByRole('button', { name: /^add 2 libraries$/i })).toBeNull();
        await fireEvent.click(primary);

        await waitFor(() => expect(postedTo('/api/setup/library')).toHaveLength(2));
        expect(postedTo('/api/setup/library')).toEqual([
            { path: '/data/media/Filme', mediaType: 'movie' },
            { path: '/data/media/Serien', mediaType: 'tv' },
        ]);
        await waitFor(() =>
            expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/scan/i),
        );
    });
});

describe('/setup — a resumed wizard keeps what an earlier pass saved', () => {
    it('starts with sharing on and persists the admin switching it off', async () => {
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        // Privacy is collapsed initially, as are the wizard's other optional fields.
        const privacy = document.querySelector<HTMLDetailsElement>('#setup-sec-privacy');
        if (privacy) privacy.open = true;
        const toggle = screen.getByRole('switch', {
            name: 'Default activity sharing for new accounts',
        });
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await fireEvent.click(toggle);
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/setup/preferences')[0]).toMatchObject({
            defaultActivitySharing: false,
        });
    });

    // Reloading on step 3/4 (or returning from an OIDC sign-in) restarts at step
    // 3. Seeded from client defaults, Save & continue re-sent the Movies preset and
    // default toggles over the operator's earlier choices.
    const SAVED = preferences({
        useCases: ['music'],
        values: {
            shareActivityBetweenUsers: false,
            defaultActivitySharing: false,
            metadataStorageLocation: 'alongside',
            unratedContentVisible: true,
            gravatar: true,
            trickplayEnabled: true,
            licenseServerContact: false,
        },
        envLocked: ['trickplayEnabled'],
    });

    it('re-sends the saved use cases and preferences, and leaves env-locked fields out', async () => {
        render(SetupPage, {
            props: { data: pageData({ resume: true, preferences: SAVED }) as never },
        });

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/admin/instance-profile')[0]).toEqual({ useCases: ['music'] });
        const prefs = postedTo('/api/setup/preferences')[0];
        expect(prefs).toMatchObject({
            shareActivityBetweenUsers: false,
            defaultActivitySharing: false,
            metadataStorageLocation: 'alongside',
            unratedContentVisible: true,
            gravatar: true,
            licenseServerContact: false,
        });
        // An env var owns TRICKPLAY_ENABLED: the server would skip it anyway.
        expect('trickplayEnabled' in prefs).toBe(false);
    });

    it('CONTROL: the first run starts from the defaults, not the saved values', async () => {
        render(SetupPage, {
            props: { data: pageData({ preferences: SAVED }) as never },
        });
        // First run starts on step 1; jump straight to step 3 the way a created
        // admin does.
        await fillAdminForm();
        await fireEvent.click(screen.getByRole('button', { name: /create admin/i }));
        await screen.findByRole('button', { name: /save & continue/i });

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/admin/instance-profile')[0]).toEqual({ useCases: ['vod'] });
        expect(postedTo('/api/setup/preferences')[0]).toMatchObject({
            shareActivityBetweenUsers: true,
            defaultActivitySharing: true,
            metadataStorageLocation: 'central',
            unratedContentVisible: false,
            // ...except the contact opt-out, which always shows (and re-sends)
            // the value in force: a fresh pass must not write ON over an
            // earlier OFF.
            licenseServerContact: false,
        });
    });

    it('contact with lumastra.org: on by default, off explains the push relay and is saved', async () => {
        render(SetupPage, {
            props: { data: pageData({ resume: true }) as never },
        });
        const contact = await screen.findByRole('switch', {
            name: /contact lumastra\.org for the push relay token/i,
        });
        expect(contact.getAttribute('aria-checked')).toBe('true');
        expect(contact.closest('details')).toBeNull();
        expect(screen.queryByTestId('setup-license-contact-off')).toBeNull();

        await fireEvent.click(contact);

        const warning = await screen.findByTestId('setup-license-contact-off');
        expect(warning.textContent).toMatch(/push notifications/i);
        expect(warning.textContent).toMatch(/standard relay/i);
        expect(screen.queryByRole('switch', { name: /check-in/i })).toBeNull();

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        const body = postedTo('/api/setup/preferences')[0];
        expect(body).toMatchObject({ licenseServerContact: false });
        expect('licenseCheckIn' in body).toBe(false);
    });

    it('contact with lumastra.org: a saved OFF is shown, and an env lock disables it', async () => {
        render(SetupPage, {
            props: {
                data: pageData({
                    resume: true,
                    preferences: preferences({
                        values: { licenseServerContact: false },
                        envLocked: ['licenseServerContact'],
                    }),
                }) as never,
            },
        });
        const contact = await screen.findByRole('switch', {
            name: /contact lumastra\.org for the push relay token/i,
        });
        expect(contact.getAttribute('aria-checked')).toBe('false');
        expect((contact as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByTestId('setup-license-contact-off')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        // Env owns it: left out of the request.
        expect('licenseServerContact' in postedTo('/api/setup/preferences')[0]).toBe(false);
    });

    it('a saved CPU choice survives GPU detection recommending an encoder', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/gpu-detect'
                    ? ok({ ffmpegReady: true, recommended: 'qsv', recommendedVendor: 'intel' })
                    : ok(null),
            ),
        );
        render(SetupPage, {
            props: {
                data: pageData({
                    resume: true,
                    preferences: preferences({ values: { gpuAcceleration: 'none' } }),
                }) as never,
            },
        });
        await waitFor(() =>
            expect(api.apiGet).toHaveBeenCalledWith('/api/setup/gpu-detect', expect.anything()),
        );

        const schema = api.apiGet.mock.calls.find(
            ([path]) => path === '/api/setup/gpu-detect',
        )![1] as z.ZodObject;
        expect(
            schema.strict().safeParse({
                hostname: 'example-host',
                ffmpegReady: true,
                recommended: 'qsv',
                recommendedVendor: 'intel',
                candidates: [],
                inContainer: true,
                driPresent: true,
            }).success,
        ).toBe(true);

        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

        await waitFor(() => expect(postedTo('/api/setup/preferences')).toHaveLength(1));
        expect(postedTo('/api/setup/preferences')[0].gpuAcceleration).toBe('none');
    });
});

describe('/setup — install overview step', () => {
    beforeEach(() => {
        sessionStorage.clear();
    });

    it('opens on the overview; Continue goes to sign-in, Back returns', async () => {
        render(SetupPage, { props: { data: pageData({ environment: ENVIRONMENT }) as never } });
        expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
            /check your install/i,
        );
        expect(screen.getByText(/step 1 of 5/i)).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
        expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/sign in/i);
        expect(screen.getByText(/step 2 of 5/i)).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
        expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
            /check your install/i,
        );
    });

    it('a reload in the same tab after Continue goes straight to sign-in', async () => {
        const first = render(SetupPage, {
            props: { data: pageData({ environment: ENVIRONMENT }) as never },
        });
        await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
        first.unmount();

        render(SetupPage, { props: { data: pageData({ environment: ENVIRONMENT }) as never } });
        expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/sign in/i);
    });

    it('a resumed wizard skips it', () => {
        render(SetupPage, {
            props: { data: pageData({ environment: ENVIRONMENT, resume: true }) as never },
        });
        expect(screen.getByRole('heading', { level: 1 }).textContent).not.toMatch(
            /check your install/i,
        );
    });
});

describe('/setup — metadata must be ready before the first library', () => {
    it('validates the primary language locally without echoing input or saving', async () => {
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        const field = document.getElementById('tmdb-language')!;
        await fireEvent.input(field, { target: { value: 'https://user:secret@example.com' } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        expect(postedTo('/api/setup/preferences')).toHaveLength(0);
        expect(field.getAttribute('aria-invalid')).toBe('true');
        expect(document.body.textContent).toMatch(/language code.*de-DE/i);
        expect(document.body.textContent).not.toMatch(/user:secret|example\.com/);
        expect(document.getElementById('tmdb-language')).not.toBeNull();
        await fireEvent.input(field, { target: { value: 'de-DE' } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
    });

    it.each(['http', 'network'])(
        'blocks advancing on a TMDB %s save failure and allows retry',
        async (failure) => {
            api.apiPost.mockImplementation((path: string) => {
                if (path === '/api/admin/tmdb-key') {
                    if (failure === 'network') return Promise.reject(new Error('secret-key'));
                    return Promise.resolve({ data: null, error: 'secret-key', status: 500 });
                }
                return Promise.resolve(ok());
            });
            render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
            await fireEvent.input(document.getElementById('tmdb-key')!, {
                target: { value: 'secret-key' },
            });
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
            expect(document.getElementById('tmdb-key')).not.toBeNull();
            expect(document.getElementById('lib-path')).toBeNull();
            expect(document.body.textContent).toMatch(/could not save the TMDB key.*try again/i);
            expect(document.body.textContent).not.toContain('secret-key');
            api.apiPost.mockResolvedValue(ok());
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
        },
    );

    it('keeps an invalid TMDB key on basics and shows the localized refusal', async () => {
        const error = 'TMDB rejected the API key (HTTP 401). Check the key and try again.';
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/admin/tmdb-key' ? { data: null, error, status: 422 } : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.input(document.getElementById('tmdb-key')!, {
            target: { value: 'day1029-invalid-tmdb-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(document.body.textContent).toContain(error));
        expect(document.getElementById('lib-path')).toBeNull();
        expect(toasts.warning).toHaveBeenCalledWith(error);
    });
    it('shows an unverified TMDB warning and allows continuing after save', async () => {
        const warning =
            'The TMDB key was saved, but could not be verified. Metadata requests will retry automatically.';
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/admin/tmdb-key'
                    ? { data: { saved: true, warning }, error: null, status: 200 }
                    : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.input(document.getElementById('tmdb-key')!, {
            target: { value: 'typed-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
        expect(toasts.warning).toHaveBeenCalledWith(warning);
    });

    it('allows continuing with the effective environment-owned TMDB key', async () => {
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/admin/tmdb-key'
                    ? { data: null, error: 'Environment lock', status: 409 }
                    : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.input(document.getElementById('tmdb-key')!, {
            target: { value: 'typed-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
    });

    it('keeps language preference save failures on step 3', async () => {
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/preferences'
                    ? { data: null, error: 'private config path', status: 500 }
                    : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(toasts.warning).toHaveBeenCalled());
        expect(document.getElementById('tmdb-language')).not.toBeNull();
        expect(document.body.textContent).toMatch(/could not save.*preferences.*try again/i);
        expect(document.body.textContent).not.toContain('private config path');
    });
});

describe('/setup — retry a queued first scan', () => {
    it('keeps a queued card through backpressure and errors, then starts and polls the retry once', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-mounts'
                    ? ok({ candidates: [{ path: '/data/media/Filme', entries: 3 }] })
                    : path === '/api/runs/retry-run'
                      ? ok({ id: 'retry-run', state: 'active' })
                      : ok(null),
            ),
        );
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, scanStarted: false })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await fireEvent.click(
            await screen.findByRole('button', { name: /add 1 librar.*continue/i }),
        );
        await waitFor(() =>
            expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/scan/i),
        );
        expect(screen.getByText(/scan queued.*within the hour/i)).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
        await waitFor(() => expect(postedTo('/api/setup/library')).toHaveLength(2));
        await screen.findByText(/still busy.*start automatically/i);
        expect(screen.getByText(/scan queued.*within the hour/i)).toBeTruthy();
        api.apiPost.mockResolvedValueOnce({
            data: null,
            error: 'https://user:secret@example.com',
            status: 500,
        });
        await fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
        await screen.findByText(/could not start.*scan.*retry/i);
        expect(document.body.textContent).not.toMatch(/user:secret|example\.com/);
        const pending = deferred();
        api.apiPost.mockImplementation(() => pending.promise);
        const retry = screen.getByRole('button', { name: /^retry$/i });
        await fireEvent.click(retry);
        await fireEvent.click(retry);
        expect(postedTo('/api/setup/library')).toHaveLength(4);
        expect(postedTo('/api/setup/library')[3]).toEqual({
            path: '/data/media/Filme',
            mediaType: 'movie',
        });
        pending.resolve(ok({ ok: true, scanStarted: true, runId: 'retry-run' }));
        await waitFor(() =>
            expect(api.apiGet).toHaveBeenCalledWith('/api/runs/retry-run', expect.anything()),
        );
        expect(screen.queryByText(/scan queued.*within the hour/i)).toBeNull();
        expect(screen.queryByRole('button', { name: /^retry$/i })).toBeNull();
    });
});

describe('/setup — retry while another scan is polling', () => {
    it('pairs responses with the polled runs when Retry adds a run mid-request', async () => {
        const firstPoll = deferred();
        let holdFirst = true;
        api.apiGet.mockImplementation((path: string) => {
            if (path === '/api/setup/library-mounts')
                return Promise.resolve(
                    ok({
                        candidates: [
                            { path: '/data/media/Filme', entries: 3 },
                            { path: '/data/media/Serien', entries: 1 },
                        ],
                    }),
                );
            if (path === '/api/runs/first-run' && holdFirst) return firstPoll.promise;
            if (path.startsWith('/api/runs/'))
                return Promise.resolve(ok({ id: path.split('/').at(-1), state: 'completed' }));
            return Promise.resolve(ok(null));
        });
        let adds = 0;
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({
                            ok: true,
                            runId:
                                ++adds === 1 ? 'first-run' : adds === 2 ? undefined : 'retry-run',
                        })
                      : ok(),
            ),
        );
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await fireEvent.click(
            await screen.findByRole('button', { name: /add 2 libraries and continue/i }),
        );
        await waitFor(() =>
            expect(api.apiGet).toHaveBeenCalledWith('/api/runs/first-run', expect.anything()),
        );
        await fireEvent.click(await screen.findByRole('button', { name: /^retry$/i }));
        await waitFor(() => expect(postedTo('/api/setup/library')).toHaveLength(3));
        holdFirst = false;
        firstPoll.resolve(ok({ id: 'first-run', state: 'completed' }));
        await screen.findByText(/^complete$/i);
        await waitFor(() => expect(screen.getAllByText(/^complete$/i)).toHaveLength(2), {
            timeout: 5000,
        });
        expect(screen.queryByText(/scan queued/i)).toBeNull();
    });
});

describe('/setup — finish-step backup guidance', () => {
    it.each([
        { source: 'env', configDir: '/config' },
        { source: 'env', configDir: null },
        { source: 'file', configDir: '/config' },
        { source: 'generated', configDir: '/custom-config' },
        { source: 'file', configDir: null },
    ])(
        'backs up the effective $source key (configDir: $configDir)',
        async ({ source, configDir }) => {
            api.apiGet.mockImplementation((path: string) =>
                Promise.resolve(
                    path === '/api/setup/library-mounts'
                        ? ok({ candidates: [{ path: '/data/media/Filme', entries: 3 }] })
                        : ok(null),
                ),
            );
            api.apiPost.mockImplementation((path: string) =>
                Promise.resolve(
                    path === '/api/setup/library-probe'
                        ? ok({ readable: true })
                        : path === '/api/setup/library'
                          ? ok({ ok: true, scanStarted: false })
                          : ok(),
                ),
            );
            render(SetupPage, {
                props: {
                    data: pageData({ resume: true, masterKeySource: source, configDir }) as never,
                },
            });
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await fireEvent.click(
                await screen.findByRole('button', { name: /add 1 librar.*continue/i }),
            );
            await waitFor(() =>
                expect(document.querySelector('.setup-finish-backup')).not.toBeNull(),
            );
            const note = document.querySelector('.setup-finish-backup')!.textContent!;
            expect(note).toContain('PostgreSQL');
            expect(note).toContain(configDir ?? '/config');
            expect(note).toMatch(/without.*cannot be recovered/i);
            if (source === 'env') {
                expect(note).toContain('.env');
                expect(note).toContain('LUMASTRA_MASTER_KEY');
                expect(note).toMatch(/separately back up/i);
                expect(note).not.toContain('master.key');
            } else {
                expect(note).toContain(`${configDir ?? '/config'}/master.key`);
                expect(note).not.toContain('.env');
                expect(note).not.toContain('LUMASTRA_MASTER_KEY');
            }
        },
    );
});

describe('/setup — language compatibility on resume', () => {
    it.each(['es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW', 'legacy-language'])(
        'keeps an unchanged configured %s from trapping the wizard',
        async (tmdbLanguage) => {
            render(SetupPage, {
                props: {
                    data: pageData({
                        resume: true,
                        metadataLanguage: { tmdbLanguage, additionalLanguages: [] },
                    }) as never,
                },
            });
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
            expect(postedTo('/api/setup/preferences')[0].tmdbLanguage).toBeUndefined();
        },
    );
    it.each(['es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW'])(
        'accepts a newly chosen %s',
        async (tmdbLanguage) => {
            render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
            await fireEvent.input(document.getElementById('tmdb-language')!, {
                target: { value: tmdbLanguage },
            });
            await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
            await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
            expect(postedTo('/api/setup/preferences')[0].tmdbLanguage).toBe(tmdbLanguage);
        },
    );
    it('disables and omits an environment-owned language', async () => {
        render(SetupPage, {
            props: {
                data: pageData({
                    resume: true,
                    metadataLanguage: {
                        tmdbLanguage: 'legacy-language',
                        tmdbLanguageLocked: true,
                        additionalLanguages: [],
                    },
                }) as never,
            },
        });
        expect((document.getElementById('tmdb-language') as HTMLInputElement).disabled).toBe(true);
        await fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));
        await waitFor(() => expect(document.getElementById('lib-path')).not.toBeNull());
        expect(postedTo('/api/setup/preferences')[0].tmdbLanguage).toBeUndefined();
    });
});

describe('/setup — German day-one guidance', () => {
    it('keeps the password name separate from its described hint', async () => {
        overwriteGetLocale(() => 'de');
        render(SetupPage, { props: { data: pageData() as never } });
        await fireEvent.click(screen.getByRole('button', { name: /Integrierte Anmeldung/i }));
        await fireEvent.click(screen.getByRole('button', { name: /^Weiter$/ }));
        const input = screen.getByLabelText('Passwort', { exact: true });
        const hint = document.getElementById(input.getAttribute('aria-describedby')!);
        expect(hint?.textContent).toContain('10');
        expect(hint?.closest('label')).toBeNull();
        await fireEvent.input(input, { target: { value: 'Correct-Horse-Battery-42!' } });
        expect(screen.getByLabelText('Passwort', { exact: true })).toBe(input);
    });
    it('explains the default watch-history sync cadence on the Jellyfin step', () => {
        overwriteGetLocale(() => 'de');
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        expect(screen.getByText(/standardmäßig alle 5 Minuten im Hintergrund/)).toBeTruthy();
        expect(m.setup_jf_sync_interval({}, { locale: 'en' })).toContain(
            'every 5 minutes by default',
        );
    });
    it('localizes runner stages and progress phase codes after adding libraries', async () => {
        api.apiGet.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-mounts'
                    ? ok({ candidates: [{ path: '/data/Movies', entries: 3 }] })
                    : path === '/api/runs/day1-scan'
                      ? ok({
                            id: 'day1-scan',
                            state: 'active',
                            stages: [
                                {
                                    id: 'main',
                                    label: 'main',
                                    state: 'active',
                                    currentItem: 'discovering',
                                },
                            ],
                        })
                      : ok(null),
            ),
        );
        api.apiPost.mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/setup/library-probe'
                    ? ok({ readable: true })
                    : path === '/api/setup/library'
                      ? ok({ ok: true, readable: true, runId: 'day1-scan' })
                      : ok(),
            ),
        );
        overwriteGetLocale(() => 'de');
        render(SetupPage, { props: { data: pageData({ resume: true }) as never } });
        await fireEvent.click(screen.getByRole('button', { name: /Speichern & weiter/i }));
        await fireEvent.click(await screen.findByRole('button', { name: /1 Bibliothek.*weiter/i }));
        await screen.findByText('Bibliothek wird gescannt');
        expect(screen.getByText('Dateien werden gesucht…')).toBeTruthy();
        expect(screen.queryByText('main', { exact: true })).toBeNull();
        expect(screen.queryByText('discovering', { exact: true })).toBeNull();
    });
});
