<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ArrowPath, CheckCircle, XCircle, LinkSlash } from 'svelte-hero-icons';
    import { ActionModal } from '$lib/components/admin';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';

    type IdentityRow = {
        provider: string;
        providerLabel: string;
        isOidc: boolean;
        subject: string;
        email: string | null;
        emailVerified: boolean;
        createdAt: string;
        lastLoginAt: string | null;
    };

    type JellyfinInfo = {
        override: string | null;
        cachedUserId: string | null;
        effectiveName: string;
    };

    interface Props {
        username: string;
        formatDate: (dateStr: string | null | undefined) => string;
        onclose: () => void;
        /** Render in place (the user drawer's Access tab) instead of as a dialog. */
        inline?: boolean;
        /**
         * Whether Jellyfin sync is enabled on this install. When false the
         * Jellyfin mapping editor is hidden — it can only fail on Jellyfin-less
         * installs. Passed by the admin users page (Phase 3). Defaults to false.
         */
        jellyfinSyncEnabled?: boolean;
        /**
         * Whether the user has a native (username/password) credential set.
         * Sourced from LocalUser.hasNativePassword on the list endpoint.
         * Used to compute lockout warnings in the unlink confirm dialog.
         */
        hasNativePassword?: boolean;
        /**
         * Distinct identity providers the user has authenticated via
         * (e.g. 'native', 'oidc:<hash>', 'forward_auth').
         * Sourced from LocalUser.identityProviders on the list endpoint.
         */
        identityProviders?: string[];
    }

    let {
        username,
        formatDate,
        onclose,
        inline = false,
        jellyfinSyncEnabled = false,
        hasNativePassword = false,
        // identityProviders is part of the shared data contract (Phase 3 passes it);
        // the modal derives login-method state from the loaded identities rows directly,
        // but callers need a consistent Props interface across admin components.
        identityProviders: _identityProviders = [],
    }: Props = $props();

    // ── data state ──────────────────────────────────────────────────────────
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let jellyfin = $state<JellyfinInfo>({
        override: null,
        cachedUserId: null,
        effectiveName: '',
    });
    let identities = $state<IdentityRow[]>([]);

    // ── jellyfin section state ───────────────────────────────────────────────
    let jellyfinOverrideInput = $state('');
    let savingJellyfin = $state(false);
    let resolvingJellyfin = $state(false);
    let resolvedId = $state<string | null | undefined>(undefined);

    // ── unlink confirm state ─────────────────────────────────────────────────
    /**
     * When set, the unlink-confirm ActionModal is shown for this identity.
     * Cleared on cancel or after the unlink completes.
     */
    let pendingUnlink = $state<{ provider: string; subject: string; identity: IdentityRow } | null>(
        null,
    );
    /** Which (provider::subject) key is currently being unlinked via the API call. */
    let unlinkingKey = $state<string | null>(null);

    // ── helpers ─────────────────────────────────────────────────────────────
    function subjectKey(provider: string, subject: string): string {
        return `${provider}::${subject}`;
    }

    function truncateSubject(s: string): string {
        if (s.length <= 20) return s;
        return s.slice(0, 12) + '…' + s.slice(-6);
    }

    /**
     * Build context-aware copy for the unlink confirmation dialog.
     * Returns { warning, detail } where detail is an extra warning line
     * or null when no special risk applies.
     */
    function buildUnlinkWarning(identity: IdentityRow): { warning: string; detail: string | null } {
        // After removing this identity, which login methods remain?
        const remainingIdentities = identities.filter(
            (i) => !(i.provider === identity.provider && i.subject === identity.subject),
        );
        // Forward-auth and OIDC rows in the remaining list are valid login methods.
        // The native ledger row is not a login method on its own — only the password is.
        const hasOtherFederatedMethod = remainingIdentities.some(
            (i) =>
                i.provider !== 'native' && i.provider !== 'forward_auth'
                    ? true // any OIDC-ish row
                    : i.provider === 'forward_auth', // forward_auth is a method
        );
        const willLoseAllMethods = !hasNativePassword && !hasOtherFederatedMethod;

        if (willLoseAllMethods) {
            return {
                warning: `Unlink the "${identity.providerLabel}" identity for ${username}?`,
                detail:
                    'Warning: this is the last login method for this account. ' +
                    'Unlinking will lock the user out. Set a native password or add another ' +
                    'identity before proceeding.',
            };
        }

        if (identity.isOidc) {
            return {
                warning: `Unlink the "${identity.providerLabel}" identity for ${username}?`,
                detail:
                    'Note: this is an OIDC identity. After unlinking, the next sign-in via this ' +
                    'provider may create a separate account instead of re-linking to this one.',
            };
        }

        return {
            warning: `Unlink the "${identity.providerLabel}" identity for ${username}?`,
            detail: null,
        };
    }

    /** Returns true when the pending unlink would leave the user with no login methods. */
    let pendingUnlinkIsLastMethod = $derived.by((): boolean => {
        if (!pendingUnlink) return false;
        const { detail } = buildUnlinkWarning(pendingUnlink.identity);
        return detail?.startsWith('Warning: this is the last') ?? false;
    });

    // ── load ─────────────────────────────────────────────────────────────────
    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        try {
            const { data, error } = await adminApi.getUserIdentities(username);
            if (error) {
                loadError = error ?? 'Failed to load identities';
            } else if (data) {
                jellyfin = data.jellyfin;
                identities = data.identities;
                jellyfinOverrideInput = data.jellyfin.override ?? '';
                resolvedId = undefined;
            }
        } catch (e) {
            loadError = getErrorMessage(e, 'Failed to load identities');
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        void load();
    });

    // ── jellyfin actions ─────────────────────────────────────────────────────
    async function saveJellyfinMapping(): Promise<void> {
        if (savingJellyfin) return;
        savingJellyfin = true;
        try {
            const value = jellyfinOverrideInput.trim() || null;
            const { data, error } = await adminApi.setUserJellyfinMapping(username, {
                jellyfinUsername: value,
            });
            if (error) {
                toasts.error(error ?? 'Failed to save Jellyfin mapping');
            } else if (data) {
                toasts.success('Jellyfin mapping saved');
                await load();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to save Jellyfin mapping'));
        } finally {
            savingJellyfin = false;
        }
    }

    async function resolveJellyfin(): Promise<void> {
        if (resolvingJellyfin) return;
        resolvingJellyfin = true;
        resolvedId = undefined;
        try {
            const { data, error } = await adminApi.setUserJellyfinMapping(username, {
                resolve: true,
            });
            if (error) {
                toasts.error(error ?? 'Failed to resolve Jellyfin account');
                resolvedId = null;
            } else if (data) {
                resolvedId = data.jellyfinUserId ?? null;
                if (resolvedId) {
                    toasts.success(`Resolved: ${resolvedId}`);
                } else {
                    toasts.error(
                        'Could not resolve (is Jellyfin sync enabled and the user present?)',
                    );
                }
                await load();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to resolve Jellyfin account'));
            resolvedId = null;
        } finally {
            resolvingJellyfin = false;
        }
    }

    // ── unlink action ────────────────────────────────────────────────────────

    /** Open the confirm modal — actual API call happens in confirmUnlink(). */
    function requestUnlink(identity: IdentityRow): void {
        pendingUnlink = { provider: identity.provider, subject: identity.subject, identity };
    }

    async function confirmUnlink(): Promise<void> {
        if (!pendingUnlink) return;
        const { provider, subject } = pendingUnlink;
        const key = subjectKey(provider, subject);
        pendingUnlink = null;
        unlinkingKey = key;
        try {
            const { data, error } = await adminApi.unlinkUserIdentity(username, provider, subject);
            if (error) {
                toasts.error(error ?? 'Failed to unlink identity');
            } else if (data) {
                toasts.success(`Unlinked ${provider} identity for ${username}`);
                await load();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to unlink identity'));
        } finally {
            unlinkingKey = null;
        }
    }
</script>

<ActionModal
    title="Accounts & identities — {username}"
    confirmText="Close"
    confirmColor="blue"
    {inline}
    {onclose}
    onconfirm={onclose}>
    {#if loading}
        <div class="flex items-center justify-center py-8 gap-3 text-surface-400">
            <Icon src={ArrowPath} class="w-5 h-5 animate-spin" />
            Loading…
        </div>
    {:else if loadError}
        <div class="bg-red-900/30 border border-red-700 rounded-lg p-4 text-red-300 text-sm">
            {loadError}
        </div>
    {:else}
        <!-- ── Jellyfin account ──────────────────────────────────────────── -->
        {#if jellyfinSyncEnabled}
            <section class="space-y-3">
                <h4 class="text-sm font-semibold text-surface-300 uppercase tracking-wide">
                    Jellyfin account
                </h4>

                <div class="bg-surface-700 rounded-lg p-4 space-y-3">
                    <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                        <div>
                            <span class="text-surface-400">Effective name:</span>
                            <span class="text-white ml-1 font-medium"
                                >{jellyfin.effectiveName}</span>
                            {#if jellyfin.override}
                                <span
                                    class="ml-1 text-xs bg-amber-900/40 text-amber-300 border border-amber-700/50 rounded px-1.5 py-0.5">
                                    override
                                </span>
                            {:else}
                                <span class="ml-1 text-xs text-surface-500"
                                    >(same as Lumastra username)</span>
                            {/if}
                        </div>
                        <div>
                            <span class="text-surface-400">Cached Jellyfin ID:</span>
                            {#if jellyfin.cachedUserId}
                                <span class="text-white ml-1 font-mono text-xs"
                                    >{jellyfin.cachedUserId}</span>
                            {:else}
                                <span class="ml-1 text-surface-500 italic">not resolved yet</span>
                            {/if}
                        </div>
                    </div>

                    {#if resolvedId !== undefined}
                        <div
                            class="text-xs rounded px-3 py-2 {resolvedId
                                ? 'bg-green-900/30 border border-green-700/50 text-green-300'
                                : 'bg-red-900/30 border border-red-700/50 text-red-300'}">
                            {#if resolvedId}
                                Resolved ID: <span class="font-mono">{resolvedId}</span>
                            {:else}
                                Could not resolve — is Jellyfin sync enabled and the user present?
                            {/if}
                        </div>
                    {/if}

                    <div class="flex gap-2 items-end">
                        <label class="block flex-1 min-w-0">
                            <span class="text-xs text-surface-400">Jellyfin username override</span>
                            <input
                                type="text"
                                class="w-full mt-1 bg-surface-600 border border-surface-500 rounded-lg px-3 py-2 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                                placeholder={username}
                                bind:value={jellyfinOverrideInput}
                                disabled={savingJellyfin || resolvingJellyfin} />
                        </label>
                        <button
                            class="btn btn-blue shrink-0 disabled:opacity-50"
                            onclick={() => void saveJellyfinMapping()}
                            disabled={savingJellyfin || resolvingJellyfin}>
                            {#if savingJellyfin}
                                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                Saving…
                            {:else}
                                Save
                            {/if}
                        </button>
                        <button
                            class="btn btn-gray shrink-0 disabled:opacity-50"
                            onclick={() => void resolveJellyfin()}
                            disabled={savingJellyfin || resolvingJellyfin}
                            title="Resolve the Jellyfin account UUID right now">
                            {#if resolvingJellyfin}
                                <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                Resolving…
                            {:else}
                                Resolve / test
                            {/if}
                        </button>
                    </div>

                    <p class="text-xs text-surface-500">
                        Leave blank to use the Lumastra username. Changing this re-resolves the
                        Jellyfin account.
                    </p>
                </div>
            </section>
        {/if}

        <!-- ── Federated identities ─────────────────────────────────────────── -->
        <section class="space-y-3">
            <h4 class="text-sm font-semibold text-surface-300 uppercase tracking-wide">
                Federated identities
            </h4>

            {#if identities.length === 0}
                <p class="text-surface-500 text-sm italic">No federated identities recorded yet.</p>
            {:else}
                <div class="space-y-2">
                    {#each identities as identity (subjectKey(identity.provider, identity.subject))}
                        {@const key = subjectKey(identity.provider, identity.subject)}
                        {@const isUnlinking = unlinkingKey === key}
                        <div class="bg-surface-700 rounded-lg p-3 flex gap-3 items-start">
                            <div class="flex-1 min-w-0 space-y-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="text-sm font-medium text-white">
                                        {identity.providerLabel}
                                    </span>
                                </div>

                                <div class="text-xs text-surface-400 font-mono truncate">
                                    <span title={identity.subject}>
                                        {truncateSubject(identity.subject)}
                                    </span>
                                </div>

                                {#if identity.email}
                                    <div class="flex items-center gap-1.5 text-xs">
                                        <span class="text-surface-300">{identity.email}</span>
                                        {#if identity.emailVerified}
                                            <span
                                                class="flex items-center gap-0.5 text-green-400 bg-green-900/30 border border-green-700/40 rounded px-1.5 py-0.5">
                                                <Icon src={CheckCircle} class="w-3 h-3" />
                                                verified
                                            </span>
                                        {:else}
                                            <span
                                                class="flex items-center gap-0.5 text-surface-500 bg-surface-600/50 border border-surface-600 rounded px-1.5 py-0.5">
                                                <Icon src={XCircle} class="w-3 h-3" />
                                                unverified
                                            </span>
                                        {/if}
                                    </div>
                                {/if}

                                <div class="text-xs text-surface-500">
                                    Linked: {formatDate(identity.createdAt)} · Last login:
                                    {formatDate(identity.lastLoginAt)}
                                </div>
                            </div>

                            <button
                                class="shrink-0 p-2 rounded-lg bg-red-900/30 hover:bg-red-900/50 text-red-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                onclick={() => requestUnlink(identity)}
                                disabled={isUnlinking || savingJellyfin || resolvingJellyfin}
                                title="Unlink this identity">
                                {#if isUnlinking}
                                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                                {:else}
                                    <Icon src={LinkSlash} class="w-4 h-4" />
                                {/if}
                            </button>
                        </div>
                    {/each}
                </div>

                <p class="text-xs text-surface-500">
                    Unlinking removes the link; the next sign-in via that provider will re-link or
                    create a fresh account per your linking policy.
                </p>
            {/if}
        </section>
    {/if}
</ActionModal>

<!-- ── Unlink confirm modal ──────────────────────────────────────────────── -->
{#if pendingUnlink}
    {@const { warning, detail } = buildUnlinkWarning(pendingUnlink.identity)}
    <ActionModal
        title="Confirm unlink"
        confirmText="Unlink"
        confirmColor="red"
        onclose={() => (pendingUnlink = null)}
        onconfirm={confirmUnlink}>
        <p class="text-sm text-white">{warning}</p>
        {#if detail}
            <p
                class="text-sm mt-2 rounded px-3 py-2 {pendingUnlinkIsLastMethod
                    ? 'bg-red-900/30 border border-red-700/50 text-red-300'
                    : 'bg-amber-900/30 border border-amber-700/50 text-amber-300'}">
                {detail}
            </p>
        {/if}
    </ActionModal>
{/if}
