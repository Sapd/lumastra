<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        XMark,
        ClipboardDocument,
        Check,
        ArrowPath,
        Trash,
        ServerStack,
        DevicePhoneMobile,
        Key,
        ChevronDown,
    } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { toasts } from '$lib/stores/toast.store';
    import { page } from '$app/stores';
    import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
    import { appPath } from '$lib/shared/api-urls.js';
    import { browser } from '$app/environment';
    import {
        getJellyfinPasswordStatus,
        generateJellyfinPassword,
        deleteJellyfinPassword,
        revealJellyfinPassword,
        getJellyfinClientSessions,
        getTokens,
        createUserToken,
        deleteToken,
    } from '$lib/api/user';
    import { authorizeQuickConnectCode } from '$lib/api/integrations.js';
    import ConnectedAppTokens from './ConnectedAppTokens.svelte';
    import RevealableSecret from '$lib/components/settings/RevealableSecret.svelte';
    import { Z } from '$lib/utils/z-index';
    import { resolve } from '$lib/paths';
    import { trapFocus } from '$lib/utils/focus-trap';

    interface Props {
        username: string;
        onclose: () => void;
    }

    let { username, onclose }: Props = $props();

    // State
    let hasPassword = $state(false);
    let displayPassword = $state('');
    /** Bumped on every generate/reset — keys the RevealableSecret remount. */
    let passwordGeneration = $state(0);
    let loading = $state(false);
    let generating = $state(false);
    let deleting = $state(false);

    // Quick Connect state
    let quickConnectCode = $state('');
    let authorizing = $state(false);

    // Read-only Jellyfin token state. Used by Discord RPC, Tautulli,
    // jellyfin-rpc2 — clients that only need GET/HEAD on /j/*.
    type ReadOnlyToken = {
        id: number;
        name: string;
        tokenPrefix: string;
    };

    let readOnlyTokens = $state<ReadOnlyToken[]>([]);
    let readOnlyTokensLoading = $state(false);
    let generatingReadOnly = $state(false);
    let displayReadOnlyToken = $state('');
    let readOnlyTokenCopied = $state(false);

    let serverUrl = $derived(
        normalizePublicBaseUrl($page.data.publicBaseUrl)
            ? `${normalizePublicBaseUrl($page.data.publicBaseUrl)}/j`
            : `${browser ? window.location.origin : ''}${appPath('/j')}`,
    );

    // How many clients are already paired with this password. Shown purely as a
    // pointer to /settings/sessions — this modal is where access is SET UP, the
    // sessions page is where it is reviewed and revoked. Without the pointer,
    // nothing tells a user who just paired Swiftfin that the result is visible
    // (or revocable) anywhere at all.
    let connectedClients = $state(0);

    // Load password status on mount
    $effect(() => {
        void checkPasswordStatus();
        void loadReadOnlyTokens();
        void loadConnectedClients();
    });

    async function loadConnectedClients(): Promise<void> {
        try {
            const { data } = await getJellyfinClientSessions();
            connectedClients = data?.items.length ?? 0;
        } catch {
            // Leave at 0 — the pointer just stays hidden.
        }
    }

    async function loadReadOnlyTokens(): Promise<void> {
        readOnlyTokensLoading = true;
        try {
            const { data } = await getTokens();
            const all = data?.items ?? [];
            // Filter on the client — `/api/me/pats` returns the
            // logged-in user's tokens regardless of scope.
            readOnlyTokens = all
                .filter((t) => (t.scopes ?? []).includes('jellyfin_compat_read'))
                .map((t) => ({
                    id: t.id,
                    name: t.name,
                    tokenPrefix: t.tokenPrefix,
                }));
        } catch {
            // Silently ignore — UI shows the empty state if it fails.
        } finally {
            readOnlyTokensLoading = false;
        }
    }

    async function generateReadOnlyToken(): Promise<void> {
        // Clear any previously-shown plaintext token BEFORE the network call.
        // If regeneration fails, the stale token must not remain visible — it
        // misleads the user into thinking the displayed value is the freshly-
        // generated one when in fact the new request errored.
        displayReadOnlyToken = '';
        readOnlyTokenCopied = false;
        generatingReadOnly = true;
        try {
            const { data, error } = await createUserToken({
                name: 'Read-only Jellyfin client',
                scopes: ['jellyfin_compat_read'],
                expiresInDays: 365,
            });
            if (!error && data?.token) {
                displayReadOnlyToken = data.token;
                readOnlyTokenCopied = false;
                await loadReadOnlyTokens();
                toasts.success(m.toast_readonly_token_created());
            } else {
                toasts.error(error || m.toast_token_create_failed());
            }
        } catch {
            toasts.error(m.toast_token_create_failed());
        } finally {
            generatingReadOnly = false;
        }
    }

    async function revokeReadOnlyToken(id: number, name: string): Promise<void> {
        if (!confirm(m.jellyfin_connect_revoke_token_confirm({ name }))) return;
        // Capture the prefix of the token being revoked so we can clear the
        // displayed plaintext token if it's the same one. The plaintext is
        // shown only once at generation time and lives in displayReadOnlyToken
        // until the modal closes — without this, revoking the freshly-shown
        // token leaves a now-dead token sitting in the UI.
        const revokedPrefix = readOnlyTokens.find((t) => t.id === id)?.tokenPrefix;
        try {
            const { error } = await deleteToken(String(id));
            if (!error) {
                toasts.success(m.toast_token_revoked());
                if (
                    revokedPrefix &&
                    displayReadOnlyToken &&
                    displayReadOnlyToken.startsWith(revokedPrefix)
                ) {
                    displayReadOnlyToken = '';
                    readOnlyTokenCopied = false;
                }
                await loadReadOnlyTokens();
            } else {
                toasts.error(error || m.toast_token_revoke_failed());
            }
        } catch {
            toasts.error(m.toast_token_revoke_failed());
        }
    }

    async function copyReadOnlyToken(): Promise<void> {
        try {
            await navigator.clipboard.writeText(displayReadOnlyToken);
            readOnlyTokenCopied = true;
            toasts.success(m.toast_token_copied());
        } catch {
            toasts.error(m.toast_token_copy_failed());
        }
    }

    async function checkPasswordStatus(): Promise<void> {
        loading = true;
        try {
            const { data } = await getJellyfinPasswordStatus();
            if (data) {
                hasPassword = data.hasPassword;
            }
        } catch {
            // Silently ignore — UI defaults to no-password state
        } finally {
            loading = false;
        }
    }

    async function generatePassword(): Promise<void> {
        generating = true;
        try {
            const { data, error } = await generateJellyfinPassword();
            if (!error && data) {
                displayPassword = data.password;
                passwordGeneration++;
                hasPassword = true;
            } else {
                toasts.error(m.toast_password_generation_failed());
            }
        } catch {
            toasts.error(m.toast_password_generation_failed());
        } finally {
            generating = false;
        }
    }

    async function deletePassword(): Promise<void> {
        deleting = true;
        try {
            const { data, error } = await deleteJellyfinPassword();
            if (!error && data) {
                hasPassword = false;
                displayPassword = '';
                toasts.success(m.toast_client_access_revoked());
            } else {
                toasts.error(m.toast_client_revoke_failed());
            }
        } catch {
            toasts.error(m.toast_client_revoke_failed());
        } finally {
            deleting = false;
        }
    }

    /**
     * Fetch the stored password on demand for RevealableSecret. Resolving null
     * means "configured but not showable" — a row written before the encrypted
     * display copy existed, where Reset is the only way forward.
     */
    async function loadPasswordForReveal(): Promise<string | null> {
        const { data } = await revealJellyfinPassword();
        return data?.password ?? null;
    }

    async function authorizeQuickConnect(): Promise<void> {
        const code = quickConnectCode.replace(/\s/g, '');
        if (!/^\d{6}$/.test(code)) {
            toasts.error(m.toast_invalid_device_code());
            return;
        }

        authorizing = true;
        try {
            const { error, status } = await authorizeQuickConnectCode(code);
            if (!error) {
                toasts.success(m.toast_device_authorized());
                quickConnectCode = '';
            } else if (status === 404) {
                toasts.error(m.toast_code_not_found());
            } else {
                toasts.error(error ?? m.toast_authorize_device_failed());
            }
        } catch {
            toasts.error(m.toast_authorize_device_failed());
        } finally {
            authorizing = false;
        }
    }

    // Which of the two copyable fields was copied last (drives the tick icon).
    let copiedField = $state<'url' | 'user' | null>(null);

    async function copyField(field: 'url' | 'user', value: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(value);
            copiedField = field;
            setTimeout(() => {
                if (copiedField === field) copiedField = null;
            }, 2000);
        } catch {
            toasts.error(m.jellyfin_connect_copy_failed());
        }
    }

    /**
     * Escape closes the dialog. Stopped here so the settings overlay behind it
     * does not also close (its own handler would otherwise see the key too).
     */
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
        aria-labelledby="jellyfin-connect-title"
        tabindex="-1"
        use:trapFocus
        onclick={stopPropagation()}>
        <!-- Header -->
        <div class="between mb-4">
            <h3 id="jellyfin-connect-title" class="text-xl font-semibold flex items-center gap-2">
                <Icon src={ServerStack} class="w-6 h-6 text-primary-400" />
                {m.jellyfin_connect_title()}
            </h3>
            <button
                class="btn-icon w-9 h-9 text-surface-400 hover:text-white"
                onclick={onclose}
                aria-label={m.jellyfin_connect_close()}
                title={m.jellyfin_connect_close()}>
                <Icon src={XMark} class="w-6 h-6" />
            </button>
        </div>

        <!--
          How-to first. The three steps used to sit at the very bottom, under
          two token tables, so the one thing a first-time user needs was the
          last thing they reached.
        -->
        <ol class="text-sm text-surface-300 space-y-1.5 list-none mb-4">
            <li class="flex gap-2">
                <span class="text-primary-400 font-bold shrink-0">1.</span>
                <span>{m.jellyfin_connect_setup_step1()}</span>
            </li>
            <li class="flex gap-2">
                <span class="text-primary-400 font-bold shrink-0">2.</span>
                <span>{m.jellyfin_connect_setup_step2_short()}</span>
            </li>
            <li class="flex gap-2">
                <span class="text-primary-400 font-bold shrink-0">3.</span>
                <span>{m.jellyfin_connect_setup_step3()}</span>
            </li>
        </ol>

        <!-- Server info -->
        <div class="space-y-3 mb-5">
            {#each [{ field: 'url' as const, label: m.jellyfin_connect_server_url_label(), value: serverUrl }, { field: 'user' as const, label: m.jellyfin_connect_username_label(), value: username }] as row (row.field)}
                <div class="bg-surface-900 rounded-lg p-3 flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                        <p class="text-xs text-surface-400 mb-1 uppercase tracking-wide">
                            {row.label}
                        </p>
                        <code class="text-sm font-mono text-primary-300 break-all"
                            >{row.value}</code>
                    </div>
                    <button
                        class="btn-icon w-9 h-9 variant-ghost-surface shrink-0"
                        onclick={() => copyField(row.field, row.value)}
                        aria-label={m.jellyfin_connect_copy_field({ field: row.label })}
                        title={m.jellyfin_connect_copy_field({ field: row.label })}>
                        <Icon
                            src={copiedField === row.field ? Check : ClipboardDocument}
                            class="w-4 h-4" />
                    </button>
                </div>
            {/each}
        </div>

        <!--
          Quick Connect leads: it is the easier path (approve a 6-digit code
          instead of typing a password on a TV remote) and the one most clients
          support. The password below is the fallback for clients that don't.
        -->
        <div class="mb-5">
            <p
                class="text-xs text-surface-400 mb-2 uppercase tracking-wide flex items-center gap-1.5">
                <Icon src={DevicePhoneMobile} class="w-3.5 h-3.5" />
                {m.jellyfin_connect_quick_connect_label()}
                <span class="badge variant-soft-primary text-[10px] px-1.5 py-0.5 normal-case">
                    {m.jellyfin_connect_recommended()}
                </span>
            </p>
            <div class="bg-surface-900 rounded-lg p-3 mb-3">
                <p class="text-xs text-surface-500 mb-2">
                    {m.jellyfin_connect_quick_connect_instructions()}
                </p>
                <div class="flex gap-2">
                    <input
                        type="text"
                        inputmode="numeric"
                        maxlength="6"
                        placeholder="123456"
                        class="input variant-form-material text-center font-mono text-lg tracking-widest flex-1"
                        bind:value={quickConnectCode}
                        onkeydown={(e) => {
                            if (e.key === 'Enter') void authorizeQuickConnect();
                        }} />
                    <button
                        class="btn variant-soft-primary shrink-0"
                        onclick={authorizeQuickConnect}
                        disabled={authorizing || quickConnectCode.replace(/\s/g, '').length !== 6}>
                        {#if authorizing}
                            <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                            ></span>
                        {:else}
                            <span>{m.jellyfin_connect_approve()}</span>
                        {/if}
                    </button>
                </div>
            </div>
        </div>

        <!-- Password section -->
        <div class="mb-5">
            <p class="text-xs text-surface-400 mb-1 uppercase tracking-wide">
                {m.jellyfin_connect_client_password_label()}
            </p>
            <p class="text-xs text-surface-500 mb-2">
                {m.jellyfin_connect_password_fallback_hint()}
            </p>

            {#if loading}
                <div class="flex justify-center py-4">
                    <span class="loading-spinner loading-spinner-white"></span>
                </div>
            {:else if hasPassword}
                <!--
                  One branch for both "just generated" and "already configured":
                  the password is re-readable now, so a freshly generated one is
                  no longer a special copy-it-or-lose-it case. Keyed on a reset
                  counter rather than on displayPassword itself, so every reset
                  remounts — keying on the value would silently skip the remount
                  in the (vanishingly rare) case where a reset re-issues the
                  identical PIN, leaving stale shown/copied state behind.
                -->
                {#key passwordGeneration}
                    <RevealableSecret
                        initial={displayPassword}
                        load={loadPasswordForReveal}
                        unavailableText={m.jellyfin_connect_password_not_revealable()} />
                {/key}
                <div class="flex gap-2">
                    <button
                        class="btn btn-sm variant-soft-primary flex-1"
                        onclick={generatePassword}
                        disabled={generating}>
                        {#if generating}
                            <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                            ></span>
                        {:else}
                            <Icon src={ArrowPath} class="w-4 h-4" />
                        {/if}
                        <span>{m.jellyfin_connect_reset_password()}</span>
                    </button>
                    <button
                        class="btn btn-sm variant-ghost-error"
                        onclick={deletePassword}
                        disabled={deleting}
                        title={m.jellyfin_connect_revoke_access_title()}>
                        {#if deleting}
                            <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                            ></span>
                        {:else}
                            <Icon src={Trash} class="w-4 h-4" />
                        {/if}
                    </button>
                </div>
            {:else}
                <!-- No password yet -->
                <div class="bg-surface-900 rounded-lg p-3 mb-3">
                    <p class="text-sm text-surface-400">
                        {m.jellyfin_connect_no_password()}
                    </p>
                </div>
                <button
                    class="btn variant-soft-primary w-full"
                    onclick={generatePassword}
                    disabled={generating}>
                    {#if generating}
                        <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                        ></span>
                    {/if}
                    <span>{m.jellyfin_connect_generate_password()}</span>
                </button>
            {/if}
        </div>

        <!--
          Pointer to the review-and-revoke surface. Stays hidden at zero, mirroring
          the sessions page's own section, so neither surface shows an empty shell.
        -->
        {#if connectedClients > 0}
            <div class="bg-surface-900 rounded-lg p-3 mb-5 flex items-center justify-between gap-3">
                <span class="text-sm text-surface-300">
                    {connectedClients === 1
                        ? m.jellyfin_connect_clients_connected_one()
                        : m.jellyfin_connect_clients_connected_many({ count: connectedClients })}
                </span>
                <a
                    href={resolve('/settings/sessions')}
                    class="text-sm text-primary-400 hover:text-primary-300 shrink-0">
                    {m.jellyfin_connect_clients_manage()}
                </a>
            </div>
        {/if}

        <!--
          Tokens are for tools and scripts, not for the apps this dialog sets up,
          so they sit behind a disclosure instead of taking up most of it.
        -->
        <details class="group border-t border-surface-500/30 pt-4">
            <summary
                class="flex items-center justify-between gap-2 cursor-pointer list-none text-sm text-surface-300 mb-3">
                <span>{m.jellyfin_connect_advanced_tokens()}</span>
                <Icon
                    src={ChevronDown}
                    class="w-4 h-4 text-surface-400 transition-transform group-open:rotate-180" />
            </summary>
            <p class="text-xs text-surface-400 mb-4">
                {m.jellyfin_connect_advanced_tokens_hint()}
                <a
                    href={resolve('/settings/account')}
                    class="text-primary-400 hover:text-primary-300"
                    >{m.jellyfin_connect_all_tokens_link()}</a>
            </p>
            <!--
              Read-only token — scope `jellyfin_compat_read`, GET/HEAD only. The
              sibling "API tokens" block below issues `jellyfin_compat`, which can
              WRITE. Keep the examples in the two blocks disjoint: presence/stats
              tools only observe and belong here; anything that marks watched or
              mutates state needs the read-write scope.
            -->
            <div class="mb-5">
                <p
                    class="text-xs text-surface-400 mb-2 uppercase tracking-wide flex items-center gap-1.5">
                    <Icon src={Key} class="w-3.5 h-3.5" />
                    {m.jellyfin_connect_readonly_token_label()}
                </p>
                <div class="bg-surface-900 rounded-lg p-3 mb-3">
                    <p class="text-xs text-surface-500 mb-2">
                        {m.jellyfin_connect_readonly_token_description()}
                    </p>
                    <p class="text-xs text-surface-500">
                        {m.jellyfin_connect_readonly_token_separate()}
                    </p>
                </div>

                {#if displayReadOnlyToken}
                    <!-- Token revealed once after generation -->
                    <div class="bg-surface-900 rounded-lg p-3 mb-3">
                        <p class="text-xs text-surface-500 mb-2">
                            {m.jellyfin_connect_copy_token_warning()}
                        </p>
                        <div class="flex items-center justify-between gap-2">
                            <code class="text-xs font-mono text-primary-200 break-all flex-1"
                                >{displayReadOnlyToken}</code>
                            <button
                                class="btn btn-sm {readOnlyTokenCopied
                                    ? 'variant-ghost-success'
                                    : 'variant-ghost-surface'} shrink-0"
                                onclick={copyReadOnlyToken}
                                title={m.jellyfin_connect_copy_token_title()}>
                                <Icon
                                    src={readOnlyTokenCopied ? Check : ClipboardDocument}
                                    class="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                {/if}

                {#if readOnlyTokensLoading}
                    <div class="flex justify-center py-2">
                        <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                        ></span>
                    </div>
                {:else if readOnlyTokens.length > 0}
                    <div class="bg-surface-900 rounded-lg overflow-hidden mb-3">
                        <table class="w-full text-sm">
                            <thead>
                                <tr
                                    class="text-left text-surface-400 border-b border-surface-700/50">
                                    <th class="px-3 py-2 font-medium"
                                        >{m.jellyfin_connect_token_table_name()}</th>
                                    <th class="px-3 py-2 font-medium"
                                        >{m.jellyfin_connect_token_table_prefix()}</th>
                                    <th class="px-3 py-2"></th>
                                </tr>
                            </thead>
                            <tbody class="divide-y divide-surface-700/30">
                                {#each readOnlyTokens as t (t.id)}
                                    <tr>
                                        <td class="px-3 py-2">{t.name}</td>
                                        <td class="px-3 py-2"
                                            ><code class="text-xs font-mono text-primary-300"
                                                >{t.tokenPrefix}…</code
                                            ></td>
                                        <td class="px-3 py-2 text-right">
                                            <button
                                                onclick={() => revokeReadOnlyToken(t.id, t.name)}
                                                class="text-red-400 hover:text-red-300 transition-colors"
                                                title={m.jellyfin_connect_revoke_token_title()}>
                                                <Icon src={Trash} class="w-4 h-4" />
                                            </button>
                                        </td>
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {/if}

                <button
                    class="btn btn-sm variant-soft-primary w-full"
                    onclick={generateReadOnlyToken}
                    disabled={generatingReadOnly}>
                    {#if generatingReadOnly}
                        <span class="loading-spinner loading-spinner-white loading-spinner-sm"
                        ></span>
                    {:else}
                        <Icon src={Key} class="w-4 h-4" />
                    {/if}
                    <span
                        >{readOnlyTokens.length > 0
                            ? m.jellyfin_connect_generate_another_readonly_token()
                            : m.jellyfin_connect_generate_readonly_token()}</span>
                </button>
            </div>

            <!-- API Tokens -->
            <div class="border-t border-surface-500/30 pt-4 mb-5">
                <ConnectedAppTokens mode="user" />
            </div>
        </details>
    </div>
</div>
