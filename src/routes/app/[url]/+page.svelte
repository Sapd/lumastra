<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { page } from '$app/stores';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { Icon, ArrowLeft, ArrowTopRightOnSquare } from 'svelte-hero-icons';
    import flyLogo from '$lib/assets/branding/lumastra-icon.svg';
    import fullLogo from '$lib/assets/branding/lumastra-logo-horizontal-ondark.svg';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    let appName = $derived($page.data?.branding?.appName || (m.nav_dashboard() as string));

    let iframeUrl: string = $state('');
    let isLoading = $state(true);
    let hasError = $state(false);

    // The server load (+page.server.ts) already validated the target against the
    // admin-configured external-link allowlist and returns the normalized URL —
    // it 404s anything else, so this page only ever renders an allowed URL. We
    // frame exactly that value; no client-side URL trust is involved.
    $effect(() => {
        const newUrl = data?.url;
        if (newUrl) {
            if (newUrl !== iframeUrl) {
                iframeUrl = newUrl;
                isLoading = true;
                hasError = false;
            }
        } else {
            hasError = true;
            isLoading = false;
        }
    });

    function handleIframeLoad() {
        isLoading = false;
    }

    function handleIframeError() {
        isLoading = false;
        hasError = true;
    }

    function goBack() {
        goto(resolve('/'));
    }

    function openInNewTab() {
        if (iframeUrl) {
            // 'noopener' severs window.opener so the opened page can't navigate
            // this tab back to a phishing URL (reverse tabnabbing).
            window.open(iframeUrl, '_blank', 'noopener');
        }
    }

    function getDisplayTitle(url: string): string {
        try {
            const parsed = new URL(url);
            const hostname = parsed.hostname;

            // Try to extract a friendly name from the first path segment
            const pathParts = parsed.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
                const service = pathParts[0];
                // Capitalize first letter
                return service.charAt(0).toUpperCase() + service.slice(1);
            }

            // Fall back to hostname
            return hostname;
        } catch {
            /* expected: URL parsing may fail on malformed or relative URLs */
            return m.embed_external_service();
        }
    }
</script>

<svelte:head>
    <title>{hasError ? m.embed_error_title() : getDisplayTitle(iframeUrl || '')} - {appName}</title>
</svelte:head>

<div class="iframe-container">
    <!-- Header -->
    <header class="iframe-header">
        <div class="flex items-center gap-4">
            <button
                class="btn btn-sm variant-ghost-surface"
                onclick={goBack}
                title={m.embed_back_to_dashboard()}>
                <Icon src={ArrowLeft} class="h-4 w-4" />
                <span class="sr-only md:not-sr-only ml-2">{m.nav_dashboard()}</span>
            </button>

            <div class="flex items-center gap-2">
                <div class="w-6 h-6 bg-primary-500 rounded center">
                    <Icon src={ArrowLeft} class="h-3 w-3 text-white" />
                </div>
                <h1 class="h4 font-semibold">
                    {hasError ? m.embed_error_loading() : getDisplayTitle(iframeUrl || '')}
                </h1>
            </div>
        </div>

        {#if !hasError && iframeUrl}
            <button
                class="btn btn-sm variant-ghost-surface"
                onclick={openInNewTab}
                title={m.embed_open_new_tab()}>
                <Icon src={ArrowTopRightOnSquare} class="h-4 w-4" />
                <span class="sr-only md:not-sr-only ml-2">{m.embed_open_new_tab()}</span>
            </button>
        {/if}
    </header>

    <!-- Content -->
    <main class="iframe-content">
        {#if hasError}
            <div class="error-state">
                <div class="text-center space-y-4">
                    <div class="text-6xl">⚠️</div>
                    <h2 class="h3">{m.embed_unable_to_load()}</h2>
                    <p class="text-surface-400">
                        {m.embed_load_failure_reasons()}
                    </p>
                    <ul class="text-left text-surface-400 space-y-1 max-w-md">
                        <li>• {m.embed_reason_unavailable()}</li>
                        <li>• {m.embed_reason_invalid_url()}</li>
                        <li>• {m.embed_reason_no_embed()}</li>
                        <li>• {m.embed_reason_network()}</li>
                    </ul>
                    <div class="flex gap-2 justify-center pt-4">
                        <button class="btn variant-filled-primary" onclick={goBack}>
                            <Icon src={ArrowLeft} class="h-4 w-4 mr-2" />
                            {m.embed_back_to_dashboard()}
                        </button>
                        {#if iframeUrl}
                            <button class="btn variant-ghost-surface" onclick={openInNewTab}>
                                <Icon src={ArrowTopRightOnSquare} class="h-4 w-4 mr-2" />
                                {m.embed_try_new_tab()}
                            </button>
                        {/if}
                    </div>
                </div>
            </div>
        {:else if iframeUrl}
            <!-- Loading indicator with Lumastra splash animation -->
            {#if isLoading}
                <div class="loading-state">
                    <div class="lumastra-splash">
                        <div class="stage">
                            <img class="fly" src={flyLogo} alt={m.layout_button_alt({ appName })} />
                            <img class="full" src={fullLogo} alt={m.layout_logo_alt({ appName })} />
                        </div>
                        <p class="loading-text">
                            {m.embed_loading({
                                title: getDisplayTitle(iframeUrl),
                            })}
                        </p>
                    </div>
                </div>
            {/if}

            <!-- Iframe -->
            <iframe
                src={iframeUrl}
                title={getDisplayTitle(iframeUrl)}
                class="iframe {isLoading ? 'opacity-0' : 'opacity-100'}"
                onload={handleIframeLoad}
                onerror={handleIframeError}
                sandbox="allow-same-origin allow-scripts allow-forms allow-downloads allow-modals allow-popups"
            ></iframe>
        {/if}
    </main>
</div>

<style lang="postcss">
    /* Override the main layout's background for iframe pages */
    :global(.app-layout:has(.iframe-container)) {
        background-image: none !important;
        background-color: var(--color-surface-800);
    }

    .iframe-container {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: var(--color-surface-800);
        margin-left: 0;
        transition: margin-left 0.3s ease-in-out;
    }

    /* No sidebar offset here: this page renders inside `.main-content`, which
       already carries the dock gutter. The old `sidebar-expanded` rule added a
       SECOND 75px on top of it (and tracked the dock through a `sidebar-toggle`
       window event that no longer exists). */

    .iframe-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem;
        border-bottom: 1px solid var(--color-surface-700);
        background: var(--color-surface-800);
        flex-shrink: 0;
        min-height: 64px;
    }

    .iframe-content {
        flex: 1;
        position: relative;
        overflow: hidden;
    }

    .iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: white;
        transition: opacity 0.3s ease;
    }

    .loading-state,
    .error-state {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-surface-900);
        z-index: 10;
    }

    .error-state {
        padding: 2rem;
    }

    /* Lumastra Splash Animation */
    .lumastra-splash {
        text-align: center;
    }

    .stage {
        position: relative;
        width: 300px;
        margin: 0 auto 2rem;
        --button-size: 64px;
        --travel: 200px;
        --fly-duration: 1.25s;
        --fade-delay: 1.05s;
        --fade-duration: 0.55s;
    }

    .fly {
        position: absolute;
        top: 50%;
        left: 0;
        width: var(--button-size);
        transform: translate(0, -50%);
        z-index: 2;
        animation: moveRight var(--fly-duration) cubic-bezier(0.2, 0.7, 0.2, 1) infinite;
    }

    .full {
        width: 100%;
        opacity: 0;
        position: relative;
        z-index: 1;
        visibility: hidden;
        animation: showLogo var(--fade-duration) ease-out infinite;
        animation-delay: var(--fly-duration);
    }

    .loading-text {
        color: var(--color-surface-400);
        font-size: 0.875rem;
    }

    @keyframes moveRight {
        0% {
            transform: translate(0, -50%) scale(1);
            opacity: 1;
            filter: blur(0);
        }
        70% {
            transform: translate(var(--travel), -50%) scale(1.05);
            opacity: 1;
            filter: blur(0.2px);
        }
        100% {
            transform: translate(calc(var(--travel) - 20px), -50%) scale(1);
            opacity: 0;
            filter: blur(0);
        }
    }

    @keyframes fadeIn {
        0% {
            opacity: 0;
        }
        50% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }

    @keyframes showLogo {
        0% {
            visibility: hidden;
            opacity: 0;
        }
        1% {
            visibility: visible;
            opacity: 0;
        }
        50% {
            visibility: visible;
            opacity: 1;
        }
        100% {
            visibility: visible;
            opacity: 0;
        }
    }

    /* Keep header actions clear of the desktop bell (1rem inset + 2.25rem
       button + 1rem gap). On mobile the bell lives in the dock instead. */
    @media (min-width: 768px) {
        .iframe-header {
            padding-right: 4.25rem;
        }
    }

    /* Mobile adjustments */
    @media (max-width: 767px) {
        .iframe-header {
            padding: 0.75rem;
        }

        .iframe-header h1 {
            font-size: 1rem;
        }

        .stage {
            width: 200px;
            --button-size: 48px;
            --travel: 120px;
        }
    }
</style>
