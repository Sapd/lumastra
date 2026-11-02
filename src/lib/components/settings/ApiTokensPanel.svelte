<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { page } from '$app/stores';
    import { SvelteDate } from 'svelte/reactivity';
    import * as m from '$lib/paraglide/messages';
    import { Icon, Key, Plus, ClipboardDocument, Check, XMark } from 'svelte-hero-icons';
    import * as userApi from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { Z } from '$lib/utils/z-index';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import InlineConfirm from './InlineConfirm.svelte';
    import EmptyState from '$lib/components/ui/EmptyState.svelte';
    import type { UserTokenInfo } from '$lib/schemas/api-user-responses';
    import {
        patCreatePayload,
        PAT_FORM_DEFAULTS,
        type PatExpiryChoice,
        type PatScopeChoice,
    } from './pat-create-payload';

    interface Props {
        initialTokens?: UserTokenInfo[];
    }
    let { initialTokens = [] }: Props = $props();

    // Snapshot the SSR seed into mutable state (not reactive to prop changes).
    let patTokens = $state<UserTokenInfo[]>(untrack(() => initialTokens.slice()));
    let revokingPatId = $state<number | null>(null);

    // Options are rendered from a list so each `value` is a Svelte expression:
    // a `<select bind:value>` binds to the selected option's `value` *property*,
    // which Svelte assigns for expression values. Mirrors the expiry select on
    // /admin/users/api-tokens rather than inventing a second pattern.
    const PAT_EXPIRY_CHOICES: { value: PatExpiryChoice; label: () => string }[] = [
        { value: '30', label: m.settings_tokens_expires_30_days },
        { value: '90', label: m.settings_tokens_expires_90_days },
        { value: '365', label: m.settings_tokens_expires_1_year },
        { value: 'never', label: m.settings_tokens_expires_no_expiration },
    ];

    // The layout ships `isAdmin` on the user object (not in the PageData type).
    const isAdmin = $derived(
        ($page.data?.user as { isAdmin?: boolean } | undefined)?.isAdmin === true,
    );

    let showPatModal = $state(false);
    let newPatName = $state('');
    let newPatScope = $state<PatScopeChoice>(PAT_FORM_DEFAULTS.scope);
    let newPatExpiry = $state<PatExpiryChoice>(PAT_FORM_DEFAULTS.expiry);
    let creatingPat = $state(false);

    // Result
    let showTokenResult = $state(false);
    let newlyCreatedToken = $state('');
    let tokenCopied = $state(false);

    function formatDate(dateStr: string | null): string {
        if (!dateStr) return m.settings_tokens_never();
        const date = new SvelteDate(dateStr);
        return date.toLocaleDateString();
    }

    /**
     * Discards whatever the create form is holding.
     *
     * Every close path resets, not just the successful one: a "Read-only"
     * choice left over from an abandoned attempt would silently apply to the
     * next token the user creates — a quieter replay of the mislabelled-scope
     * bug this form was rebuilt to fix.
     */
    function closePatModal(): void {
        // Not while the request is out: dismissing it here did not stop the
        // token being created, and the one-time secret dialog then popped up
        // over whatever the user did next.
        if (creatingPat) return;
        showPatModal = false;
        newPatName = '';
        newPatScope = PAT_FORM_DEFAULTS.scope;
        newPatExpiry = PAT_FORM_DEFAULTS.expiry;
    }

    /**
     * Human label for a token's stored scopes.
     *
     * The list can contain tokens this panel cannot create — `admin` and the
     * exclusive `jellyfin_compat*` scopes come from Admin → API tokens — so the
     * most privileged scope wins to keep the badge honest.
     *
     * Anything unrecognised (a legacy row with no scopes, or a scope added by a
     * newer release) is shown verbatim rather than folded into "Read-only":
     * naming a privilege level we did not recognise is how a write-capable
     * token would end up displayed as harmless.
     */
    function scopeLabel(scopes: string[]): string {
        if (scopes.includes('admin')) return m.settings_tokens_scope_admin();
        if (scopes.includes('jellyfin_compat')) return m.settings_tokens_scope_jellyfin();
        if (scopes.includes('jellyfin_compat_read'))
            return m.settings_tokens_scope_jellyfin_readonly();
        if (scopes.includes('write')) return m.settings_tokens_scope_readwrite();
        if (scopes.includes('read')) return m.settings_tokens_scope_readonly();
        return scopes.join(', ') || '—';
    }

    async function revokePatToken(id: number): Promise<void> {
        revokingPatId = id;
        try {
            const { error } = await userApi.deleteToken(String(id));
            if (!error) {
                patTokens = patTokens.filter((t) => t.id !== id);
                toasts.success(m.settings_tokens_revoke_success());
            } else {
                toasts.error(error || m.settings_tokens_revoke_error());
            }
        } catch {
            toasts.error(m.settings_tokens_revoke_error());
        } finally {
            revokingPatId = null;
        }
    }

    async function createPat(): Promise<void> {
        if (!newPatName.trim()) {
            toasts.error(m.settings_tokens_name_required());
            return;
        }
        creatingPat = true;
        try {
            const { data, error, status } = await userApi.createUserToken(
                patCreatePayload(newPatName, newPatScope, newPatExpiry),
            );
            if (!error && data) {
                newlyCreatedToken = data.token;
                creatingPat = false;
                closePatModal();
                showTokenResult = true;
                tokenCopied = false;
                toasts.success(m.settings_tokens_create_success());
                const { data: list } = await userApi.getTokens();
                if (list?.items) patTokens = list.items;
            } else if (status === 409) {
                // 409 is only the per-user active-token cap on this endpoint.
                toasts.error(m.settings_tokens_limit_reached());
            } else {
                toasts.error(error || m.settings_tokens_create_error());
            }
        } catch {
            toasts.error(m.settings_tokens_create_error());
        } finally {
            creatingPat = false;
        }
    }

    /**
     * Escape closes the create form. It is handled on the dialog and stopped
     * there so the settings overlay's own Escape (close settings) never fires
     * underneath it.
     */
    function onCreateKeydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        closePatModal();
    }

    /**
     * The secret is shown exactly once, so the result dialog deliberately
     * ignores Escape and backdrop clicks: a stray click used to close it and
     * the token was gone for good. Only "Done" or the close button dismiss it.
     */
    function onResultKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') event.stopPropagation();
    }

    function closeResult(): void {
        showTokenResult = false;
        newlyCreatedToken = '';
    }

    async function copyToken(): Promise<void> {
        try {
            await navigator.clipboard.writeText(newlyCreatedToken);
            tokenCopied = true;
            toasts.success(m.settings_tokens_copy_success());
        } catch {
            toasts.error(m.settings_tokens_copy_error());
        }
    }
</script>

<div class="p-4">
    {#if patTokens.length === 0}
        <EmptyState
            variant="minimal"
            icon={Key}
            title={m.settings_tokens_empty_title()}
            description={m.settings_tokens_empty_description()} />
    {:else}
        <div class="space-y-3 mb-4">
            {#each patTokens as token (token.id)}
                <div class="bg-surface-900 rounded-lg p-3 flex items-start justify-between gap-2">
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                            <span class="font-medium text-sm truncate">{token.name}</span>
                            {#if token.isExpired}
                                <span class="badge variant-filled-error text-xs px-1.5 py-0.5"
                                    >{m.settings_tokens_expired()}</span>
                            {/if}
                        </div>
                        <div class="text-xs text-surface-500 mt-1">
                            <span class="font-mono">{token.tokenPrefix}…</span>
                            · {scopeLabel(token.scopes)}
                            · {m.settings_tokens_created({ date: formatDate(token.createdAt) })}
                            · {token.expiresAt
                                ? m.settings_tokens_expires({ date: formatDate(token.expiresAt) })
                                : m.settings_tokens_expires_never()}
                        </div>
                        <div class="text-xs text-surface-400 mt-0.5">
                            {token.lastUsedAt
                                ? m.settings_tokens_last_used({
                                      when: formatRelativeTime(token.lastUsedAt),
                                  })
                                : m.settings_tokens_never_used()}
                        </div>
                    </div>
                    <InlineConfirm
                        iconOnly
                        triggerLabel={m.settings_tokens_revoke()}
                        ariaLabel={m.settings_tokens_revoke_named({ name: token.name })}
                        confirmLabel={m.settings_tokens_confirm()}
                        busy={revokingPatId === token.id}
                        onConfirm={() => revokePatToken(token.id)} />
                </div>
            {/each}
        </div>
    {/if}

    <button
        class="btn btn-sm variant-filled-primary flex items-center gap-2"
        onclick={() => (showPatModal = true)}>
        <Icon src={Plus} class="w-4 h-4" />
        {m.settings_tokens_create_button()}
    </button>
</div>

{#if showPatModal}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        use:bodyPortal
        class="modal-overlay modal-overlay-blur p-4"
        style="z-index: {Z.MODAL}"
        onclick={closePatModal}
        onkeydown={onCreateKeydown}>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="bg-surface-800 rounded-lg shadow-xl max-w-md w-full p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-pat-create-title"
            tabindex="-1"
            use:trapFocus
            onclick={stopPropagation()}>
            <div class="between mb-4">
                <h3 id="settings-pat-create-title" class="text-xl font-semibold">
                    {m.settings_tokens_modal_title()}
                </h3>
                <button
                    class="btn-icon w-9 h-9 text-surface-400 hover:text-white"
                    aria-label={m.settings_tokens_close()}
                    onclick={closePatModal}>
                    <Icon src={XMark} class="w-6 h-6" />
                </button>
            </div>
            <label for="settings-pat-name" class="block text-sm font-medium text-surface-300 mb-1"
                >{m.settings_tokens_name_label()}</label>
            <input
                id="settings-pat-name"
                type="text"
                data-autofocus
                class="input w-full"
                placeholder={m.settings_tokens_name_placeholder()}
                bind:value={newPatName} />

            <fieldset class="mt-4">
                <legend class="block text-sm font-medium text-surface-300 mb-2"
                    >{m.settings_tokens_access_label()}</legend>
                <div class="space-y-2">
                    <label class="flex items-start gap-2 cursor-pointer">
                        <input
                            type="radio"
                            class="radio mt-1"
                            value="write"
                            bind:group={newPatScope} />
                        <span>
                            <span class="text-sm text-surface-200"
                                >{m.settings_tokens_scope_readwrite()}</span>
                            <span class="block text-xs text-surface-500"
                                >{m.settings_tokens_scope_readwrite_desc()}</span>
                        </span>
                    </label>
                    <label class="flex items-start gap-2 cursor-pointer">
                        <input
                            type="radio"
                            class="radio mt-1"
                            value="read"
                            bind:group={newPatScope} />
                        <span>
                            <span class="text-sm text-surface-200"
                                >{m.settings_tokens_scope_readonly()}</span>
                            <span class="block text-xs text-surface-500"
                                >{m.settings_tokens_scope_readonly_desc()}</span>
                        </span>
                    </label>
                </div>
                <p class="text-xs text-surface-500 mt-2">
                    {isAdmin
                        ? m.settings_tokens_admin_note_for_admin()
                        : m.settings_tokens_admin_note()}
                </p>
            </fieldset>

            <label
                for="settings-pat-expiry"
                class="block text-sm font-medium text-surface-300 mt-4 mb-1"
                >{m.settings_tokens_expiration()}</label>
            <select id="settings-pat-expiry" class="select w-full" bind:value={newPatExpiry}>
                {#each PAT_EXPIRY_CHOICES as choice (choice.value)}
                    <option value={choice.value}>{choice.label()}</option>
                {/each}
            </select>

            <div class="flex gap-3 justify-end mt-6">
                <button class="btn variant-ghost-surface" onclick={closePatModal}
                    >{m.settings_tokens_cancel()}</button>
                <button
                    class="btn variant-filled-primary"
                    onclick={createPat}
                    disabled={creatingPat || !newPatName.trim()}>
                    {creatingPat ? m.settings_tokens_creating() : m.settings_tokens_create_submit()}
                </button>
            </div>
        </div>
    </div>
{/if}

{#if showTokenResult}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        use:bodyPortal
        class="modal-overlay modal-overlay-blur p-4"
        style="z-index: {Z.MODAL}"
        onkeydown={onResultKeydown}>
        <div
            class="bg-surface-800 rounded-lg shadow-xl max-w-lg w-full p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-pat-result-title"
            tabindex="-1"
            use:trapFocus>
            <div class="between mb-4">
                <h3 id="settings-pat-result-title" class="text-xl font-semibold">
                    {m.settings_tokens_result_title()}
                </h3>
                <button
                    class="btn-icon w-9 h-9 text-surface-400 hover:text-white"
                    aria-label={m.settings_tokens_close()}
                    onclick={closeResult}>
                    <Icon src={XMark} class="w-6 h-6" />
                </button>
            </div>
            <div class="bg-warning-900/30 border border-warning-600 rounded-lg p-4 mb-4">
                <p class="text-sm text-warning-200">
                    {m.settings_tokens_result_warning()}
                </p>
            </div>
            <div class="bg-surface-900 rounded-lg p-4 mb-4 flex items-center gap-2">
                <code class="text-sm text-success-400 break-all flex-1 font-mono"
                    >{newlyCreatedToken}</code>
                <button
                    class="shrink-0 p-2 rounded hover:bg-surface-700"
                    data-autofocus
                    onclick={copyToken}
                    title={m.settings_tokens_copy()}
                    aria-label={m.settings_tokens_copy()}>
                    <Icon src={tokenCopied ? Check : ClipboardDocument} class="w-5 h-5" />
                </button>
            </div>
            <div class="flex justify-end">
                <button
                    class="btn {tokenCopied ? 'variant-filled-primary' : 'variant-ghost-surface'}"
                    onclick={closeResult}>{m.settings_tokens_done()}</button>
            </div>
        </div>
    </div>
{/if}
