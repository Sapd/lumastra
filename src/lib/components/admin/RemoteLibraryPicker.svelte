<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Library picker for a remote media source (AudiobookShelf today).

  The operator picks a library by its REAL upstream name — never types a path and
  never sees a UUID. The id travels invisibly and the server derives both the
  `abs://<id>` sentinel and the `provider_path` lookup key from it.

  All provider knowledge lives behind `/api/admin/library/remote-libraries`, so
  this component has no idea which HTTP calls AudiobookShelf needs; it renders
  whatever `RemoteLibrarySource` reports. Three states have to be distinguished,
  because each sends the operator somewhere different:

    not_configured → credentials missing; link to the settings page
    unreachable    → configured but not answering; show why, offer retry
    ok             → the list (possibly genuinely empty)

  Collapsing these into "no libraries found" is the failure this replaces.
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { getRemoteLibraries, type RemoteLibraryOption } from '$lib/api/admin';
    import { resolve } from '$lib/paths';
    import { modals } from '$lib/stores/modal.store';
    import { Icon, ArrowPath, ExclamationTriangle, Cog6Tooth } from 'svelte-hero-icons';

    interface Props {
        /** Remote provider to enumerate, e.g. `audiobookshelf`. */
        provider: string;
        /** Currently selected upstream library id, or '' for none. */
        selectedId: string;
        /** Fired when the selection changes, or when the list resolves/fails. */
        onSelect: (
            selection: { id: string; library: RemoteLibraryOption } | { id: ''; library: null },
        ) => void;
    }

    let { provider, selectedId, onSelect }: Props = $props();

    let loading = $state(true);
    let status = $state<'ok' | 'not_configured' | 'unreachable' | 'request_failed'>('ok');
    let libraries = $state<RemoteLibraryOption[]>([]);
    let message = $state('');
    let missingKeys = $state<string[]>([]);
    let settingsHref = $state('/admin/settings');

    /**
     * Operator-facing source name, as reported by the server.
     *
     * Kept separate from a `$state(provider)` initializer: that would capture only
     * the FIRST value of the `provider` prop, so switching sources would keep
     * showing the previous source's name until its response landed. Empty until
     * the first response, with the raw provider id as the fallback.
     */
    let serverLabel = $state('');
    const label = $derived(serverLabel || provider);

    /**
     * Guards against an out-of-order response overwriting a newer one. The
     * provider can change (or Retry can be clicked) while a request is in
     * flight, and a superseded response arriving last would render the wrong
     * source's libraries.
     */
    let generation = 0;

    async function load(): Promise<void> {
        const mine = ++generation;
        loading = true;
        message = '';
        try {
            const { data, error } = await getRemoteLibraries(provider);
            if (mine !== generation) return;

            if (error || !data) {
                status = 'request_failed';
                message = error ?? m.admin_library_remote_load_failed();
                libraries = [];
                onSelect({ id: '', library: null });
                return;
            }

            serverLabel = data.label;
            settingsHref = data.settingsHref;
            status = data.status;
            missingKeys = data.missingKeys ?? data.requiredKeys;
            message = data.message ?? '';
            libraries = data.libraries ?? [];

            // Clear any stale selection that this list does not offer — otherwise
            // switching sources could submit an id belonging to the previous one.
            const stillValid = libraries.some((l) => l.id === selectedId && selectable(l));
            if (!stillValid) onSelect({ id: '', library: null });
        } catch (e) {
            if (mine !== generation) return;
            status = 'request_failed';
            message = e instanceof Error ? e.message : m.admin_library_remote_load_failed();
            libraries = [];
            onSelect({ id: '', library: null });
        } finally {
            if (mine === generation) loading = false;
        }
    }

    /** A library can be picked only if we can ingest it and it is not already added. */
    function selectable(lib: RemoteLibraryOption): boolean {
        return lib.supported && !lib.existing;
    }

    /**
     * Upstream names that appear more than once in this list.
     *
     * Nothing stops an operator naming two libraries "Fiction". Rendered as two
     * identical options, they are impossible to tell apart, and picking the wrong
     * one produces a library whose language and group belong to the other. Only
     * ambiguous names get a disambiguator, so the common case stays clean.
     */
    const duplicateNames = $derived(
        new Set(libraries.map((l) => l.name).filter((name, i, all) => all.indexOf(name) !== i)),
    );

    function optionLabel(lib: RemoteLibraryOption): string {
        // A short id prefix is the only distinguishing information upstream gives
        // us. It is shown ONLY when the name alone is ambiguous — the operator
        // should not have to read a UUID in the normal case.
        const name = duplicateNames.has(lib.name)
            ? `${lib.name} (${lib.id.slice(0, 8)})`
            : lib.name;
        // Distinguish added-and-active from added-but-disabled. Both are
        // unselectable, but only one of them is a library the operator probably
        // wants to go re-enable, and "already added" alone gives no hint that it
        // exists yet is not syncing.
        if (lib.existing) {
            return lib.existing.enabled
                ? m.admin_library_remote_added({ name })
                : m.admin_library_remote_disabled({ name });
        }
        if (!lib.supported) return m.admin_library_remote_unsupported({ name });
        return name;
    }

    function handleChange(event: Event): void {
        const id = (event.currentTarget as HTMLSelectElement).value;
        const lib = libraries.find((l) => l.id === id);
        if (!id || !lib) {
            onSelect({ id: '', library: null });
            return;
        }
        onSelect({ id, library: lib });
    }

    // Re-fetch whenever the provider changes. `provider` is a prop, so a source
    // switch in the parent must re-enumerate rather than keep the old list.
    $effect(() => {
        void provider;
        void load();
    });

    const selectableCount = $derived(libraries.filter(selectable).length);
</script>

{#if loading}
    <div class="flex items-center gap-2 text-sm text-surface-400">
        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
        <span>{m.admin_library_remote_loading({ source: label })}</span>
    </div>
{:else if status === 'not_configured'}
    <!-- The picker cannot work until credentials exist. Say exactly which ones
         and link to where they are set, rather than showing an empty dropdown. -->
    <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
        <div class="flex items-start gap-2">
            <Icon src={Cog6Tooth} class="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div class="text-sm">
                <p class="text-amber-200 font-medium">
                    {m.admin_library_remote_not_connected({ source: label })}
                </p>
                <p class="text-surface-300 mt-1">
                    {m.admin_library_remote_missing_keys({ keys: missingKeys.join(', ') })}
                </p>
                <a
                    href={resolve(settingsHref)}
                    class="inline-block mt-2 underline text-amber-300 hover:text-amber-200"
                    onclick={() => void modals.close()}>
                    {m.admin_library_remote_settings({ source: label })}
                </a>
            </div>
        </div>
    </div>
{:else if status === 'unreachable' || status === 'request_failed'}
    <div class="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
        <div class="flex items-start gap-2">
            <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div class="text-sm min-w-0">
                <p class="text-red-200 font-medium">
                    {m.admin_library_remote_list_failed({ source: label })}
                </p>
                <p class="text-surface-300 mt-1 break-words">{message}</p>
                <div class="mt-2 flex items-center gap-3">
                    <button
                        type="button"
                        class="underline text-red-300 hover:text-red-200"
                        onclick={() => void load()}>
                        {m.retry()}
                    </button>
                    <a
                        href={resolve(settingsHref)}
                        class="underline text-surface-300 hover:text-white"
                        onclick={() => void modals.close()}>
                        {m.admin_library_remote_check_settings({ source: label })}
                    </a>
                </div>
            </div>
        </div>
    </div>
{:else}
    <select
        id="lp-remote-library"
        class="input w-full"
        value={selectedId}
        onchange={handleChange}
        disabled={selectableCount === 0}>
        <option value="">{m.admin_library_path_select_library()}</option>
        {#each libraries as lib (lib.id)}
            <option value={lib.id} disabled={!selectable(lib)}>{optionLabel(lib)}</option>
        {/each}
    </select>

    {#if libraries.length === 0}
        <p class="text-xs text-amber-400 mt-1">
            {m.admin_library_remote_empty({ source: label })}
        </p>
    {:else if selectableCount === 0}
        <p class="text-xs text-amber-400 mt-1">
            {m.admin_library_remote_all_added({ source: label })}
            {#if libraries.some((l) => l.existing && !l.existing.enabled)}
                {m.admin_library_remote_enable_existing()}
            {/if}
        </p>
    {:else}
        <div class="mt-1 flex items-center justify-between gap-2">
            <p class="text-xs text-surface-500">
                {m.admin_library_remote_names_hint({ source: label })}
            </p>
            <button
                type="button"
                class="text-xs text-surface-400 hover:text-white underline"
                onclick={() => void load()}>
                {m.btn_refresh()}
            </button>
        </div>
    {/if}
{/if}
