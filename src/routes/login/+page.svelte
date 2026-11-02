<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { invalidateAll } from '$app/navigation';
    import { page } from '$app/stores';
    import { toasts } from '$lib/stores/toast.store';
    import { url } from '$lib/paths';
    import { Icon, LockClosed, ArrowRightOnRectangle } from 'svelte-hero-icons';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';
    import {
        AUTH_FAILURE_ERROR_PARAM,
        AUTH_FAILURE_REF_PARAM,
        formatAuthFailureBanner,
        formatAuthFailureReport,
        sanitizeAuthFailureRef,
    } from '$lib/shared/auth-failure-ref';

    interface LoginProviderOption {
        id: string;
        name: string;
        kind: 'credentials' | 'redirect';
    }

    interface PageData {
        redirectTo: string;
        unavailable?: boolean;
        nativeEnabled: boolean;
        oidcEnabled: boolean;
        oidcProviderName: string;
        pluginProviders?: LoginProviderOption[];
    }

    let { data }: { data: PageData } = $props();

    onMount(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        let delay = 5000;
        const retry = async (): Promise<void> => {
            if (stopped || !data.unavailable) return;
            try {
                await invalidateAll();
            } catch {
                // A network outage is temporary too. Keep the unavailable page visible.
            }
            delay = Math.min(delay * 2, 30_000);
            if (!stopped && data.unavailable) timer = setTimeout(() => void retry(), delay);
        };
        if (data.unavailable) timer = setTimeout(() => void retry(), delay);
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    });

    // SSO start URL, carrying the post-login destination as a same-origin returnTo.
    const oidcLoginHref = $derived(
        url(`/auth/oidc/login?returnTo=${encodeURIComponent(data.redirectTo || '/')}`),
    );

    const pluginLoginHref = (id: string): string =>
        url(
            `/api/auth/plugin/${encodeURIComponent(id)}/start?returnTo=${encodeURIComponent(data.redirectTo || '/')}`,
        );

    const appName = $derived($page.data?.branding?.appName ?? 'Lumastra');
    const logoFull = $derived($page.data?.branding?.logoFull as string | undefined);

    const pluginProviders = $derived(data.pluginProviders ?? []);

    // Every place a username+password can be checked. A plugin directory takes
    // the SAME two fields as the built-in one, so it reuses the same form rather
    // than getting a second one — only the endpoint differs.
    const credentialSources = $derived([
        ...(data.nativeEnabled ? [{ id: 'native', name: 'This server' }] : []),
        ...pluginProviders
            .filter((p) => p.kind === 'credentials')
            .map((p) => ({ id: p.id, name: p.name })),
    ]);

    // Redirect providers can't share the form — there is nothing to type. They
    // render as links beside the SSO button, which is the same shape of thing.
    const redirectProviders = $derived(pluginProviders.filter((p) => p.kind === 'redirect'));

    // Defaults to the built-in directory when there is one; a plugin is what an
    // operator adds, not what they'd want silently preselected.
    //
    // Seeded rather than left empty: `bind:value` writes this into the select on
    // mount, and '' matches no option, so the control rendered BLANK while the
    // form quietly posted to whatever the fallback resolved to. A visitor would
    // pick nothing, type their directory credentials, and have them checked
    // against the wrong directory.
    // The viewer's explicit pick, or '' for "hasn't chosen". `activeSource`
    // resolves that to something real, so the control is never blank and the
    // endpoint always matches what the control shows — the two drifting apart
    // is what previously posted LDAP credentials to the built-in directory.
    let authSource = $state('');
    const activeSource = $derived(
        credentialSources.some((s) => s.id === authSource)
            ? authSource
            : (credentialSources[0]?.id ?? 'native'),
    );
    const loginEndpoint = $derived(
        activeSource === 'native'
            ? '/api/auth/native/login'
            : `/api/auth/plugin/${encodeURIComponent(activeSource)}/login`,
    );

    let username = $state('');
    let password = $state('');
    let submitting = $state(false);
    let errorMessage = $state('');

    // A SERVER-side sign-in failure (the OIDC callback) bounces here with
    // ?error=…&ref=…. Both are attacker-reachable query parameters, so neither is
    // rendered raw: formatAuthFailureBanner() (in $lib/shared, so it is covered by
    // vitest and seen by tsgo) allowlists the message and shape-checks the ref.
    let bannerDismissed = $state(false);
    const redirectBanner = $derived(
        bannerDismissed
            ? null
            : formatAuthFailureBanner(
                  $page.url.searchParams.get(AUTH_FAILURE_ERROR_PARAM),
                  $page.url.searchParams.get(AUTH_FAILURE_REF_PARAM),
              ),
    );
    const failureRef = $derived(
        sanitizeAuthFailureRef($page.url.searchParams.get(AUTH_FAILURE_REF_PARAM)),
    );
    const bannerText = $derived(errorMessage || redirectBanner || '');

    // Captured once so the copied report says when the failure was shown, not
    // when the button happened to be clicked.
    const shownAt = new Date().toISOString();
    let copied = $state(false);

    async function copyFailureReport(): Promise<void> {
        const body = formatAuthFailureReport({
            message: $page.url.searchParams.get(AUTH_FAILURE_ERROR_PARAM),
            ref: failureRef,
            occurredAt: shownAt,
            appVersion: typeof $page.data?.appVersion === 'string' ? $page.data.appVersion : null,
        });
        try {
            await navigator.clipboard.writeText(body);
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            toasts.error('Copy failed — quote the reference from the message instead.');
        }
    }

    const LoginResponseSchema = z.object({ redirect: z.string().optional() }).passthrough();

    async function handleSubmit(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (submitting) return;

        // Read the ACTUAL field values from the form rather than the bound
        // state. Browser password managers often autofill inputs without firing
        // the `input` event Svelte's bind relies on, leaving `username`/`password`
        // empty in component state — so trust the DOM, not the binding.
        const form = event.currentTarget as HTMLFormElement;
        const fd = new FormData(form);
        const uname = String(fd.get('username') ?? '').trim();
        const pwd = String(fd.get('password') ?? '');

        // A fresh attempt supersedes whatever the redirect banner was reporting —
        // set BEFORE the validation early-return, or that return leaves the stale
        // server-side banner (and its copy button) alive next to a client-side
        // validation message that has nothing to do with it.
        bannerDismissed = true;

        if (!uname || !pwd) {
            errorMessage = 'Enter your username and password.';
            return;
        }

        errorMessage = '';
        submitting = true;

        try {
            const {
                data: body,
                error,
                status,
            } = await apiPost(loginEndpoint, LoginResponseSchema, {
                username: uname,
                password: pwd,
                redirect: data.redirectTo,
            });

            if (!error) {
                // Hard navigation so SSR reads the freshly-set session cookie.
                window.location.assign(body?.redirect || data.redirectTo || '/');
                return;
            }

            if (status === 401) {
                // Wrong username/password: the inline alert below is the only
                // surface for this — a toast on top of it duplicated the
                // same message on screen.
                errorMessage = 'Invalid username or password.';
            } else if (status === 403) {
                // The one failure the visitor can actually act on: their
                // directory account is real, but nobody has linked it here yet.
                errorMessage =
                    'That account is not linked on this server yet. Ask an administrator to link it.';
                toasts.error(errorMessage);
            } else if (status === 429) {
                errorMessage = 'Too many attempts. Please wait a few minutes and try again.';
                toasts.error(errorMessage);
            } else {
                errorMessage = error || 'Something went wrong. Please try again.';
                toasts.error(errorMessage);
            }
        } finally {
            submitting = false;
        }
    }
</script>

<svelte:head>
    <title>Sign in to {appName}</title>
</svelte:head>

<div class="auth-shell">
    <div class="auth-aurora" aria-hidden="true"></div>
    <div class="auth-grain" aria-hidden="true"></div>

    <main class="auth-stage">
        <div class="auth-card card">
            <div class="auth-brand">
                {#if logoFull}
                    <img src={logoFull} alt={appName} class="auth-logo" />
                {:else}
                    <span class="auth-wordmark">{appName}</span>
                {/if}
            </div>

            <h1 class="auth-title">Sign in to {appName}</h1>
            <p class="auth-subtitle">
                {#if credentialSources.length > 0}
                    Welcome back. Enter your credentials to continue.
                {:else if data.oidcEnabled}
                    Welcome back. Continue with {data.oidcProviderName}.
                {:else if redirectProviders.length > 0}
                    Welcome back. Choose how you'd like to sign in.
                {/if}
            </p>

            {#if bannerText}
                <div class="auth-error" role="alert" aria-live="assertive">
                    <span>{bannerText}</span>
                    <!-- Offer the report only while the REDIRECT banner is what's on
                         screen: the report describes that failure, so showing the
                         button next to any other message would hand the user a
                         mismatched bug report. -->
                    {#if failureRef && bannerText === redirectBanner}
                        <button type="button" class="auth-error-copy" onclick={copyFailureReport}>
                            {copied ? 'Copied' : 'Copy for a bug report'}
                        </button>
                    {/if}
                </div>
            {/if}

            {#if data.unavailable}
                <div class="auth-error" role="status">
                    Sign-in is temporarily unavailable. Retrying automatically. Please wait while
                    the server reconnects.
                </div>
            {:else}
                {#if data.oidcEnabled}
                    <a class="btn variant-soft auth-sso" href={oidcLoginHref} data-sveltekit-reload>
                        <Icon src={ArrowRightOnRectangle} class="h-5 w-5" />
                        <span>Sign in with {data.oidcProviderName}</span>
                    </a>
                {/if}

                {#each redirectProviders as provider (provider.id)}
                    <!-- A plain link, deliberately: the host owns this transaction,
                     so the browser navigates to our own start endpoint and we
                     decide where it goes from there. `data-sveltekit-reload`
                     keeps it a real navigation rather than a client-side one. -->
                    <a
                        class="btn variant-soft auth-sso"
                        href={pluginLoginHref(provider.id)}
                        data-sveltekit-reload>
                        <Icon src={ArrowRightOnRectangle} class="h-5 w-5" />
                        <span>Sign in with {provider.name}</span>
                    </a>
                {/each}

                {#if (data.oidcEnabled || redirectProviders.length > 0) && credentialSources.length > 0}
                    <div class="auth-divider"><span>or</span></div>
                {/if}

                {#if credentialSources.length > 0}
                    <form method="post" class="auth-form" onsubmit={handleSubmit} novalidate>
                        <!-- Only worth showing when there is a genuine choice; one
                         directory needs no picker. -->
                        {#if credentialSources.length > 1}
                            <label class="auth-field" for="login-source">
                                <span class="auth-label">Sign in with</span>
                                <select
                                    id="login-source"
                                    class="select"
                                    name="source"
                                    bind:value={() => activeSource, (v) => (authSource = v)}
                                    disabled={submitting}>
                                    {#each credentialSources as source (source.id)}
                                        <!-- No `selected` attribute: `bind:value` owns
                                         the selection, and the attribute was dead
                                         code that masked the blank-render bug. -->
                                        <option value={source.id}>{source.name}</option>
                                    {/each}
                                </select>
                            </label>
                        {/if}

                        <label class="auth-field" for="login-username">
                            <span class="auth-label">Username</span>
                            <!-- svelte-ignore a11y_autofocus -->
                            <input
                                id="login-username"
                                class="input"
                                type="text"
                                name="username"
                                autocomplete="username"
                                autocapitalize="none"
                                spellcheck="false"
                                bind:value={username}
                                disabled={submitting}
                                required
                                autofocus />
                        </label>

                        <label class="auth-field" for="login-password">
                            <span class="auth-label">Password</span>
                            <input
                                id="login-password"
                                class="input"
                                type="password"
                                name="password"
                                autocomplete="current-password"
                                bind:value={password}
                                disabled={submitting}
                                required />
                        </label>

                        <button
                            type="submit"
                            class="btn variant-filled-primary auth-submit"
                            disabled={submitting}>
                            {#if submitting}
                                <span class="loading-spinner loading-spinner-white"></span>
                                <span>Signing in…</span>
                            {:else}
                                <Icon src={ArrowRightOnRectangle} class="h-5 w-5" />
                                <span>Sign in</span>
                            {/if}
                        </button>
                    </form>
                {/if}
            {/if}

            <p class="auth-footnote">
                <Icon src={LockClosed} class="inline h-3.5 w-3.5 -mt-0.5" />
                Your session is protected on this device.
            </p>
        </div>
    </main>
</div>

<style>
    .auth-shell {
        position: relative;
        display: flex;
        min-height: 100dvh;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        padding: 1.5rem;
        background: radial-gradient(
            120% 120% at 50% -10%,
            rgb(var(--color-surface-800-rgb)) 0%,
            rgb(var(--color-surface-900-rgb)) 55%,
            rgb(0 0 0) 100%
        );
    }

    /* Layered aurora mesh in the brand primary for cinematic depth. */
    .auth-aurora {
        position: absolute;
        inset: -25%;
        z-index: 0;
        background:
            radial-gradient(
                42% 38% at 22% 18%,
                rgb(var(--color-primary-500-rgb) / 0.32) 0%,
                transparent 70%
            ),
            radial-gradient(
                36% 40% at 82% 22%,
                rgb(var(--color-tertiary-500-rgb, var(--color-primary-400-rgb)) / 0.22) 0%,
                transparent 72%
            ),
            radial-gradient(
                48% 44% at 60% 92%,
                rgb(var(--color-primary-700-rgb) / 0.28) 0%,
                transparent 75%
            );
        filter: blur(28px) saturate(1.1);
        animation: aurora-drift 22s ease-in-out infinite alternate;
    }

    @keyframes aurora-drift {
        0% {
            transform: translate3d(-2%, -1%, 0) scale(1);
        }
        100% {
            transform: translate3d(3%, 2%, 0) scale(1.08);
        }
    }

    /* Fine film grain so the gradients never read flat. */
    .auth-grain {
        position: absolute;
        inset: 0;
        z-index: 1;
        opacity: 0.05;
        pointer-events: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    }

    .auth-stage {
        position: relative;
        z-index: 2;
        width: 100%;
        max-width: 25rem;
    }

    .auth-card {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 2.25rem 2rem 1.75rem;
        border-radius: 1.25rem;
        background: rgb(var(--color-surface-900-rgb) / 0.95);
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.45);
        backdrop-filter: blur(18px);
        box-shadow:
            0 1px 0 0 rgb(255 255 255 / 0.05) inset,
            0 24px 60px -20px rgb(0 0 0 / 0.7),
            0 0 0 1px rgb(var(--color-primary-500-rgb) / 0.06);
        animation: card-rise 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes card-rise {
        from {
            opacity: 0;
            transform: translateY(14px) scale(0.985);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }

    .auth-brand {
        display: flex;
        justify-content: center;
        margin-bottom: 1rem;
    }

    .auth-logo {
        height: 2.5rem;
        width: auto;
        object-fit: contain;
    }

    .auth-wordmark {
        font-size: 1.75rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        background: linear-gradient(
            100deg,
            rgb(var(--color-primary-300-rgb)),
            rgb(var(--color-primary-500-rgb))
        );
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
    }

    .auth-title {
        font-size: 1.35rem;
        font-weight: 600;
        line-height: 1.2;
        text-align: center;
        color: rgb(var(--color-surface-50-rgb));
    }

    .auth-subtitle {
        margin-top: 0.4rem;
        margin-bottom: 1.25rem;
        text-align: center;
        font-size: 0.875rem;
        color: rgb(var(--color-surface-300-rgb));
    }

    .auth-error {
        margin-bottom: 1rem;
        border-radius: 0.65rem;
        border: 1px solid rgb(var(--color-error-500-rgb) / 0.4);
        background: rgb(var(--color-error-500-rgb) / 0.12);
        padding: 0.65rem 0.85rem;
        font-size: 0.85rem;
        color: rgb(var(--color-error-400-rgb, var(--color-error-400-rgb)));
        animation: shake 0.4s ease;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .auth-error-copy {
        flex-shrink: 0;
        border-radius: 0.4rem;
        border: 1px solid rgb(var(--color-error-500-rgb) / 0.5);
        background: transparent;
        padding: 0.2rem 0.55rem;
        font-size: 0.75rem;
        color: inherit;
        cursor: pointer;
    }

    .auth-error-copy:hover {
        background: rgb(var(--color-error-500-rgb) / 0.18);
    }

    @keyframes shake {
        0%,
        100% {
            transform: translateX(0);
        }
        25% {
            transform: translateX(-4px);
        }
        75% {
            transform: translateX(4px);
        }
    }

    .auth-form {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .auth-field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .auth-label {
        font-size: 0.78rem;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: rgb(var(--color-surface-300-rgb));
    }

    .auth-submit {
        margin-top: 0.35rem;
        width: 100%;
        gap: 0.5rem;
    }

    .auth-sso {
        margin-top: 0.5rem;
        width: 100%;
        gap: 0.5rem;
    }

    .auth-divider {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        margin: 0.9rem 0 0.35rem;
        color: rgb(var(--color-surface-400-rgb));
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.08em;
    }

    .auth-divider::before,
    .auth-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        background: rgb(var(--color-surface-500-rgb) / 0.4);
    }

    .auth-footnote {
        margin-top: 1.25rem;
        text-align: center;
        font-size: 0.72rem;
        color: rgb(var(--color-surface-400-rgb));
    }

    @media (prefers-reduced-motion: reduce) {
        .auth-aurora,
        .auth-card,
        .auth-error {
            animation: none;
        }
    }
</style>
