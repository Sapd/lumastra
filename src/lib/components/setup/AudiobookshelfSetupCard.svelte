<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  First-run wizard, library step: connect Audiobookshelf and add its book
  libraries, the remote counterpart of the "Found these folders" list.

  1. Connect: URL + API key go to POST /api/setup/audiobookshelf, which tests
     them against the server and only then stores them (same write path as
     Settings > Audiobookshelf). The key is dropped from this component's state
     once it is stored.
  2. List: GET /api/admin/library/remote-libraries, the same listing the admin
     add-library picker uses, so libraries that already exist are marked.
  3. Add: one POST /api/setup/library per checked library, exactly like a
     folder, so each one gets its first sync run for the scan screen.

  A connection that is already stored (an earlier pass, or environment
  variables) is picked up on mount and skips straight to the list.
-->

<script lang="ts" module>
    export interface AddedAudiobookshelfLibrary {
        remoteLibraryId: string;
        name: string;
        runId: string | null;
    }
</script>

<script lang="ts">
    import { onMount } from 'svelte';
    import { z } from 'zod';
    import { apiPost } from '$lib/api/client.js';
    import { getRemoteLibraries, type RemoteLibraryOption } from '$lib/api/admin';
    import { Icon, CheckCircle, ExclamationTriangle, GlobeAlt } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Upstream ids already added during this wizard run. */
        addedIds: readonly string[];
        /** Another library is being added, or the wizard is finishing. */
        disabled?: boolean;
        /** Fired once per library the server created (or re-attached). */
        onadded: (library: AddedAudiobookshelfLibrary) => void;
        /** Fired when a stored connection is found, so the parent can open its section. */
        onconnected?: () => void;
        /** True while libraries are being added, so the page holds Continue until they are in. */
        onbusy?: (busy: boolean) => void;
        /** How many libraries are ticked but not added yet; the page's Continue adds them. */
        onpending?: (count: number) => void;
    }

    let { addedIds, disabled = false, onadded, onconnected, onbusy, onpending }: Props = $props();

    const PROVIDER = 'audiobookshelf';

    let url = $state('');
    let apiKey = $state('');
    let connecting = $state(false);
    let connectError = $state('');
    /** The stored connection answered: show the library list instead of the form. */
    let connected = $state(false);
    let userMatches = $state<z.infer<typeof ConnectSchema> | null>(null);
    /** "Use a different server" reopens the form over a working connection. */
    let editing = $state(false);
    let loadingLibraries = $state(false);
    let libraries = $state<RemoteLibraryOption[]>([]);
    let checked = $state<Record<string, boolean>>({});
    let adding = $state(false);
    let addError = $state('');

    const ConnectSchema = z.object({
        connected: z.boolean(),
        libraryCount: z.number().int().nonnegative().optional(),
        reason: z.string().optional(),
        error: z.string().optional(),
        httpStatus: z.number().optional(),
        keys: z.array(z.string()).optional(),
        userMatchStatus: z.enum(['ok', 'unavailable']).optional(),
        adminUsername: z.string().optional(),
        adminMatched: z.boolean().nullable().optional(),
        matchedName: z.string().nullable().optional(),
        matchedUsernames: z.array(z.string()).optional(),
        unmatchedUsernames: z.array(z.string()).optional(),
        pendingUsernames: z.array(z.string()).optional(),
    });

    const LibrarySetupSchema = z
        .object({ ok: z.boolean().optional(), runId: z.string().optional() })
        .passthrough();

    const busy = $derived(disabled || connecting || adding || loadingLibraries);
    const canConnect = $derived(url.trim() !== '' && apiKey.trim() !== '' && !busy);

    function isAdded(lib: RemoteLibraryOption): boolean {
        return addedIds.includes(lib.id) || lib.existing !== undefined;
    }
    const addable = $derived(libraries.filter((l) => l.supported && !isAdded(l)));
    const selected = $derived(addable.filter((l) => checked[l.id]));

    function connectErrorFor(data: z.infer<typeof ConnectSchema>): string {
        switch (data.reason) {
            case 'auth':
                return m.setup_abs_error_auth();
            case 'http':
                return m.setup_abs_error_http({ status: String(data.httpStatus ?? '?') });
            case 'not_audiobookshelf':
                return m.setup_abs_error_not_abs();
            case 'libraries_exist':
                return m.setup_abs_error_libraries_exist();
            case 'env_locked':
                return m.setup_abs_error_env_locked({ keys: (data.keys ?? []).join(', ') });
            default:
                return data.error ?? m.setup_abs_error_network();
        }
    }

    /**
     * Read the stored connection's libraries. `quiet` is the mount-time check:
     * no stored connection (or one that does not answer) just leaves the form,
     * and it neither locks the form while a dead server times out nor
     * overwrites a connection the operator made in the meantime.
     */
    async function loadLibraries(quiet: boolean): Promise<boolean> {
        if (!quiet) loadingLibraries = true;
        const { data, error } = await getRemoteLibraries(PROVIDER);
        if (!quiet) loadingLibraries = false;
        else if (connecting || connected) return false;
        if (!data || data.status !== 'ok') {
            if (!quiet) connectError = error ?? m.setup_abs_error_network();
            return false;
        }
        libraries = data.libraries ?? [];
        // Preselect every book library not added yet; keep choices across reloads.
        for (const lib of libraries) {
            if (lib.id in checked) continue;
            checked[lib.id] = lib.supported && !isAdded(lib);
        }
        connected = true;
        editing = false;
        return true;
    }

    async function connect(): Promise<void> {
        if (!canConnect) return;
        connecting = true;
        connectError = '';
        userMatches = null;
        addError = '';
        const { data, error } = await apiPost('/api/setup/audiobookshelf', ConnectSchema, {
            url: url.trim(),
            apiKey: apiKey.trim(),
        });
        connecting = false;
        if (error || !data) {
            connectError = error ?? m.setup_abs_error_network();
            return;
        }
        if (!data.connected) {
            connectError = connectErrorFor(data);
            return;
        }
        // A different server's libraries: start the selection over.
        userMatches = data;
        libraries = [];
        checked = {};
        // Stored server-side, so the key is dropped once the list is in. If the
        // listing fails it stays, so a retry does not mean pasting it again.
        if (await loadLibraries(false)) apiKey = '';
    }

    async function addSelected(): Promise<void> {
        if (busy || selected.length === 0) return;
        adding = true;
        addError = '';
        try {
            for (const lib of [...selected]) {
                const { data, error } = await apiPost('/api/setup/library', LibrarySetupSchema, {
                    provider: PROVIDER,
                    remoteLibraryId: lib.id,
                    mediaType: 'audiobook',
                });
                if (error || data?.ok !== true) {
                    addError = m.setup_abs_add_failed({
                        name: lib.name,
                        error: error || m.setup_abs_add_retry(),
                    });
                    return;
                }
                checked[lib.id] = false;
                onadded({ remoteLibraryId: lib.id, name: lib.name, runId: data.runId ?? null });
            }
        } finally {
            adding = false;
        }
    }

    $effect(() => {
        onbusy?.(adding);
    });

    $effect(() => {
        onpending?.(selected.length);
    });

    /**
     * Adds the ticked libraries for the page's Continue button. True when none
     * is left pending; false when one failed (its error shows in the card).
     */
    export async function addPending(): Promise<boolean> {
        await addSelected();
        return selected.length === 0;
    }

    onMount(async () => {
        if (await loadLibraries(true)) onconnected?.();
    });
</script>

<div class="abs-card">
    <p class="abs-desc">{m.setup_abs_desc()}</p>

    {#if connected && !editing}
        <div class="abs-callout abs-callout-success" role="status">
            <Icon src={CheckCircle} class="h-5 w-5 shrink-0" />
            <span>{m.setup_abs_connected()}</span>
        </div>
        <p class="abs-hint">{m.setup_abs_language_hint()}</p>
        {#if userMatches?.userMatchStatus === 'unavailable'}
            <div class="abs-callout" role="status">{m.setup_abs_users_unavailable()}</div>
        {:else if userMatches?.userMatchStatus === 'ok'}
            {#if (userMatches.pendingUsernames?.length ?? 0) > 0}
                <p class="abs-hint">
                    {m.setup_abs_users_pending({
                        names: (userMatches.pendingUsernames ?? []).join(', '),
                    })}
                </p>
            {/if}
            {#if userMatches.adminMatched}
                <p class="abs-hint">
                    {m.setup_abs_admin_matched({
                        username: userMatches.adminUsername ?? '',
                        matched: userMatches.matchedName ?? userMatches.adminUsername ?? '',
                    })}
                </p>
            {/if}
            {#if (userMatches.matchedUsernames?.length ?? 0) > 0}
                <p class="abs-hint">
                    {m.setup_abs_users_matched({
                        names: (userMatches.matchedUsernames ?? []).join(', '),
                    })}
                </p>
            {/if}
            {#if (userMatches.unmatchedUsernames?.length ?? 0) > 0}
                <div class="abs-callout" role="status">
                    <span
                        >{m.setup_abs_users_unmatched({
                            names: (userMatches.unmatchedUsernames ?? []).join(', '),
                        })}</span>
                </div>
            {/if}
        {/if}

        {#if libraries.length === 0}
            <p class="abs-hint">{m.setup_abs_no_libraries()}</p>
        {:else}
            <ul class="abs-list" aria-label={m.setup_abs_libraries_label()}>
                {#each libraries as lib (lib.id)}
                    {@const done = isAdded(lib)}
                    <li class="abs-row">
                        <input
                            type="checkbox"
                            class="checkbox"
                            id={`abs-lib-${lib.id}`}
                            checked={done || (checked[lib.id] ?? false)}
                            onchange={(e) => (checked[lib.id] = e.currentTarget.checked)}
                            disabled={busy || done || !lib.supported} />
                        <label class="abs-name" for={`abs-lib-${lib.id}`}>
                            <span>{lib.name}</span>
                            {#if done}
                                <span class="abs-hint">{m.setup_abs_lib_added()}</span>
                            {:else if !lib.supported}
                                <span class="abs-hint">{m.setup_abs_lib_unsupported()}</span>
                            {/if}
                        </label>
                    </li>
                {/each}
            </ul>
        {/if}

        {#if addError}
            <div class="abs-callout abs-callout-warning" role="alert">
                <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                <span>{addError}</span>
            </div>
        {/if}

        <div class="abs-actions">
            <button
                type="button"
                class="btn variant-ghost-surface btn-sm"
                onclick={() => {
                    editing = true;
                    connectError = '';
                }}
                disabled={busy}>
                {m.setup_abs_change_server()}
            </button>
            <div class="abs-spacer"></div>
            {#if adding}
                <span class="loading-spinner"></span>
                <span class="abs-hint">{m.setup_lib_starting()}</span>
            {:else if selected.length > 0}
                <!-- Ticked libraries are added by the library step's Continue, like
                     ticked folders; a separate Add button here read as optional. -->
                <span class="abs-hint">{m.setup_abs_added_on_continue()}</span>
            {/if}
        </div>
    {:else}
        <form
            method="post"
            class="abs-form"
            onsubmit={(e) => {
                e.preventDefault();
                void connect();
            }}>
            <label class="abs-field" for="abs-url">
                <span class="abs-label">{m.setup_abs_url_label()}</span>
                <input
                    id="abs-url"
                    class="input"
                    type="url"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck="false"
                    placeholder={m.setup_abs_url_placeholder()}
                    bind:value={url}
                    disabled={busy} />
                <span class="abs-hint">{m.setup_abs_url_hint()}</span>
            </label>

            <label class="abs-field" for="abs-key">
                <span class="abs-label">{m.setup_abs_key_label()}</span>
                <input
                    id="abs-key"
                    class="input"
                    type="password"
                    autocomplete="new-password"
                    placeholder={m.setup_abs_key_placeholder()}
                    bind:value={apiKey}
                    disabled={busy} />
                <span class="abs-hint">{m.setup_abs_key_hint()}</span>
            </label>

            {#if connectError}
                <div class="abs-callout abs-callout-warning" role="alert">
                    <Icon src={ExclamationTriangle} class="h-5 w-5 shrink-0" />
                    <span>{connectError}</span>
                </div>
            {/if}

            <div class="abs-actions">
                {#if connected}
                    <button
                        type="button"
                        class="btn variant-ghost-surface btn-sm"
                        onclick={() => {
                            editing = false;
                            connectError = '';
                        }}
                        disabled={busy}>
                        {m.setup_abs_keep_server()}
                    </button>
                {/if}
                <div class="abs-spacer"></div>
                <button type="submit" class="btn variant-soft-surface" disabled={!canConnect}>
                    {#if connecting || loadingLibraries}
                        <span class="loading-spinner"></span>
                        <span>{m.setup_jf_btn_testing()}</span>
                    {:else}
                        <Icon src={GlobeAlt} class="h-5 w-5" />
                        <span>{m.setup_jf_btn_test()}</span>
                    {/if}
                </button>
            </div>
        </form>
    {/if}
</div>

<style>
    /* Same tokens as the wizard's own field, callout and suggestion-row styles,
       which are scoped to +page.svelte and do not reach this component. */
    .abs-card {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .abs-desc {
        font-size: 0.76rem;
        line-height: 1.4;
        color: rgb(var(--color-surface-400-rgb));
    }

    .abs-form {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .abs-field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .abs-label {
        font-size: 0.78rem;
        font-weight: 500;
        color: rgb(var(--color-surface-300-rgb));
    }

    .abs-hint {
        font-size: 0.74rem;
        line-height: 1.35;
        color: rgb(var(--color-surface-400-rgb));
    }

    .abs-callout {
        display: flex;
        align-items: flex-start;
        gap: 0.6rem;
        border-radius: 0.75rem;
        padding: 0.8rem 0.95rem;
        font-size: 0.9rem;
        line-height: 1.45;
    }

    .abs-callout-success {
        border: 1px solid rgb(var(--color-success-500-rgb) / 0.4);
        background: rgb(var(--color-success-500-rgb) / 0.12);
        color: rgb(var(--color-success-400-rgb));
    }

    .abs-callout-warning {
        border: 1px solid rgb(var(--color-warning-500-rgb) / 0.4);
        background: rgb(var(--color-warning-500-rgb) / 0.12);
        color: rgb(var(--color-warning-400-rgb));
    }

    .abs-list {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .abs-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0.75rem;
        border-radius: 0.75rem;
        border: 1px solid rgb(var(--color-surface-500-rgb) / 0.3);
        background: rgb(var(--color-surface-700-rgb) / 0.25);
    }

    .abs-name {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        flex-direction: column;
        cursor: pointer;
        overflow-wrap: anywhere;
    }

    .abs-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.6rem;
    }

    .abs-spacer {
        flex: 1 1 auto;
    }
</style>
