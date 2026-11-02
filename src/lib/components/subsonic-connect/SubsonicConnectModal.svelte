<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, XMark, ArrowPath, Trash, ServerStack } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { toasts } from '$lib/stores/toast.store';
    import { Z } from '$lib/utils/z-index';
    import { page } from '$app/stores';
    import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
    import { appPath } from '$lib/shared/api-urls.js';
    import { browser } from '$app/environment';
    import {
        getSubsonicTokenStatus,
        generateSubsonicToken,
        deleteSubsonicToken,
        revealSubsonicToken,
    } from '$lib/api/user';
    import RevealableSecret from '$lib/components/settings/RevealableSecret.svelte';
    import { trapFocus } from '$lib/utils/focus-trap';

    interface Props {
        open: boolean;
        onclose: () => void;
    }

    let { open, onclose }: Props = $props();

    // State
    let hasToken = $state(false);
    let displayToken = $state('');
    /** Bumped on every generate/reset — keys the RevealableSecret remount. */
    let tokenGeneration = $state(0);
    let loading = $state(false);
    let generating = $state(false);
    let deleting = $state(false);

    let serverUrl = $derived(
        normalizePublicBaseUrl($page.data.publicBaseUrl)
            ? `${normalizePublicBaseUrl($page.data.publicBaseUrl)}/subsonic`
            : `${browser ? window.location.origin : ''}${appPath('/subsonic')}`,
    );

    $effect(() => {
        if (open) {
            void checkTokenStatus();
        }
    });

    async function checkTokenStatus(): Promise<void> {
        loading = true;
        try {
            const { data } = await getSubsonicTokenStatus();
            if (data) {
                hasToken = data.hasToken;
            }
        } catch {
            // Silently ignore — UI defaults to no-token state
        } finally {
            loading = false;
        }
    }

    async function generateToken(): Promise<void> {
        generating = true;
        try {
            const { data, error } = await generateSubsonicToken();
            if (!error && data) {
                displayToken = data.token;
                tokenGeneration++;
                hasToken = true;
            } else {
                toasts.error(m.toast_subsonic_token_generation_failed());
            }
        } catch {
            toasts.error(m.toast_subsonic_token_generation_failed());
        } finally {
            generating = false;
        }
    }

    async function deleteToken(): Promise<void> {
        deleting = true;
        try {
            const { data, error } = await deleteSubsonicToken();
            if (!error && data) {
                hasToken = false;
                displayToken = '';
                toasts.success(m.toast_token_revoked());
            } else {
                toasts.error(m.toast_subsonic_token_revoke_failed());
            }
        } catch {
            toasts.error(m.toast_subsonic_token_revoke_failed());
        } finally {
            deleting = false;
        }
    }

    /**
     * Fetch the stored token on demand for RevealableSecret. Subsonic tokens
     * are stored in the clear (the protocol requires it), so a configured token
     * always resolves — null here means it went away between the status check
     * and the reveal.
     */
    async function loadTokenForReveal(): Promise<string | null> {
        const { data } = await revealSubsonicToken();
        return data?.token ?? null;
    }

    /** Escape closes; stopped so the settings overlay underneath stays open. */
    function onKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onclose();
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="modal-overlay modal-overlay-blur p-4"
    style="z-index: {Z.MODAL}"
    onclick={onclose}
    onkeydown={onKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
        class="bg-surface-800 rounded-lg shadow-xl max-w-md w-full p-6 max-h-[90vh] overflow-y-auto overscroll-contain"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subsonic-connect-title"
        tabindex="-1"
        use:trapFocus
        onclick={stopPropagation()}>
        <!-- Header -->
        <div class="between mb-4">
            <h3 id="subsonic-connect-title" class="text-xl font-semibold flex items-center gap-2">
                <Icon src={ServerStack} class="w-6 h-6 text-primary-400" />
                {m.subsonic_connect_title()}
            </h3>
            <button
                class="btn-icon w-9 h-9 text-surface-400 hover:text-white"
                aria-label={m.jellyfin_connect_close()}
                onclick={onclose}>
                <Icon src={XMark} class="w-6 h-6" />
            </button>
        </div>

        <!-- Server info -->
        <div class="space-y-3 mb-5">
            <div class="bg-surface-900 rounded-lg p-3">
                <p class="text-xs text-surface-400 mb-1 uppercase tracking-wide">
                    {m.subsonic_connect_server_url_label()}
                </p>
                <code class="text-sm font-mono text-primary-300 break-all">{serverUrl}</code>
            </div>
        </div>

        <!-- Token section -->
        <div class="mb-5">
            <p class="text-xs text-surface-400 mb-2 uppercase tracking-wide">
                {m.subsonic_connect_access_token_label()}
            </p>

            {#if loading}
                <div class="flex justify-center py-4">
                    <span class="loading-spinner loading-spinner-white"></span>
                </div>
            {:else if hasToken}
                <!--
                  One branch for both "just generated" and "already configured":
                  the token is re-readable now, so a freshly generated one is no
                  longer a special copy-it-or-lose-it case. Keyed on a reset
                  counter rather than on displayToken itself, so every reset
                  remounts regardless of whether the new value happens to differ.
                -->
                {#key tokenGeneration}
                    <RevealableSecret
                        initial={displayToken}
                        load={loadTokenForReveal}
                        unavailableText={m.subsonic_connect_token_not_revealable()}
                        maskLength={16} />
                {/key}
                <div class="flex gap-2">
                    <button
                        class="btn btn-sm variant-soft-primary flex-1"
                        onclick={generateToken}
                        disabled={generating}>
                        {#if generating}
                            <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                            ></span>
                        {:else}
                            <Icon src={ArrowPath} class="w-4 h-4" />
                        {/if}
                        <span>{m.subsonic_connect_reset_token_button()}</span>
                    </button>
                    <button
                        class="btn btn-sm variant-ghost-error"
                        onclick={deleteToken}
                        disabled={deleting}
                        title={m.subsonic_connect_revoke_token_title()}>
                        {#if deleting}
                            <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                            ></span>
                        {:else}
                            <Icon src={Trash} class="w-4 h-4" />
                        {/if}
                    </button>
                </div>
            {:else}
                <!-- No token yet -->
                <div class="bg-surface-900 rounded-lg p-3 mb-3">
                    <p class="text-sm text-surface-400">
                        {m.subsonic_connect_no_token()}
                    </p>
                </div>
                <button
                    class="btn variant-soft-primary w-full"
                    onclick={generateToken}
                    disabled={generating}>
                    {#if generating}
                        <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                        ></span>
                    {/if}
                    <span>{m.subsonic_connect_generate_token_button()}</span>
                </button>
            {/if}
        </div>

        <!-- Instructions -->
        <div class="border-t border-surface-500/30 pt-4 space-y-4">
            <div>
                <p class="text-xs text-surface-400 mb-2 uppercase tracking-wide">
                    {m.subsonic_connect_classic_clients_heading()}
                </p>
                <p class="text-xs text-surface-500 mb-2">
                    {m.subsonic_connect_classic_clients_examples()}
                </p>
                <ol class="text-sm text-surface-300 space-y-1 list-none">
                    <li class="flex gap-2">
                        <span class="text-primary-400 font-bold shrink-0">1.</span>
                        <span
                            >{m.subsonic_connect_step_server_prefix()}
                            <code class="text-xs font-mono text-primary-300">{serverUrl}</code
                            ></span>
                    </li>
                    <li class="flex gap-2">
                        <span class="text-primary-400 font-bold shrink-0">2.</span>
                        <span>{m.subsonic_connect_step_username()}</span>
                    </li>
                    <li class="flex gap-2">
                        <span class="text-primary-400 font-bold shrink-0">3.</span>
                        <span>{m.subsonic_connect_step_password()}</span>
                    </li>
                </ol>
            </div>
            <div>
                <p class="text-xs text-surface-400 mb-2 uppercase tracking-wide">
                    {m.subsonic_connect_opensubsonic_clients_heading()}
                </p>
                <p class="text-xs text-surface-500 mb-2">
                    {m.subsonic_connect_opensubsonic_clients_examples()}
                </p>
                <ol class="text-sm text-surface-300 space-y-1 list-none">
                    <li class="flex gap-2">
                        <span class="text-primary-400 font-bold shrink-0">1.</span>
                        <span
                            >{m.subsonic_connect_step_server_prefix()}
                            <code class="text-xs font-mono text-primary-300">{serverUrl}</code
                            ></span>
                    </li>
                    <li class="flex gap-2">
                        <span class="text-primary-400 font-bold shrink-0">2.</span>
                        <span>{m.subsonic_connect_step_apikey()}</span>
                    </li>
                </ol>
            </div>
        </div>
    </div>
</div>
