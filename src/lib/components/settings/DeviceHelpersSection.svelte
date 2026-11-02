<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    /**
     * DeviceHelpersSection - the "household grant": other users of this server
     * (a grandson with his own account) who may use the remote on my devices.
     * Lists them, adds one by username, removes one.
     */
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import * as deviceApi from '$lib/api/device-commands';
    import { toasts } from '$lib/stores/toast.store';
    import InlineConfirm from './InlineConfirm.svelte';
    import SettingsGroup from './SettingsGroup.svelte';

    /** The server refuses more helpers than this (422). */
    const MAX_HELPERS = 20;

    let grants = $state<deviceApi.DeviceGrant[]>([]);
    let loading = $state(true);
    let loadFailed = $state(false);
    let username = $state('');
    let adding = $state(false);
    let removing = $state<string | null>(null);
    let formError = $state('');

    onMount(async () => {
        try {
            const { data, error } = await deviceApi.listDeviceGrants();
            if (data && !error) grants = data.items;
            else loadFailed = true;
        } catch {
            loadFailed = true;
        } finally {
            loading = false;
        }
    });

    async function add(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const name = username.trim();
        if (!name || adding) return;
        adding = true;
        formError = '';
        try {
            const { data, error, status } = await deviceApi.addDeviceGrant(name);
            if (data && !error) {
                if (!grants.some((g) => g.username === data.username)) {
                    grants = [...grants, data].sort((a, b) => a.username.localeCompare(b.username));
                }
                username = '';
                toasts.success(m.device_helpers_added_toast({ username: data.username }));
            } else if (status === 404) {
                formError = m.device_helpers_unknown_user();
            } else if (status === 422) {
                formError =
                    grants.length >= MAX_HELPERS
                        ? m.device_helpers_limit()
                        : m.device_helpers_self();
            } else if (status === 429) {
                formError = m.device_helpers_rate_limited();
            } else {
                formError = m.device_helpers_add_failed();
            }
        } catch {
            formError = m.device_helpers_add_failed();
        } finally {
            adding = false;
        }
    }

    async function remove(name: string): Promise<void> {
        removing = name;
        try {
            const { error } = await deviceApi.removeDeviceGrant(name);
            if (!error) {
                grants = grants.filter((g) => g.username !== name);
                toasts.success(m.device_helpers_removed_toast({ username: name }));
            } else {
                toasts.error(m.device_helpers_remove_failed());
            }
        } catch {
            toasts.error(m.device_helpers_remove_failed());
        } finally {
            removing = null;
        }
    }
</script>

<SettingsGroup label={m.device_helpers_title()} description={m.device_helpers_description()}>
    {#if loadFailed}
        <p class="py-3 px-4 text-sm text-surface-400" role="status">
            {m.device_helpers_load_failed()}
        </p>
    {:else if !loading && grants.length === 0}
        <p class="py-3 px-4 text-sm text-surface-400">{m.device_helpers_empty()}</p>
    {/if}
    {#each grants as grant (grant.username)}
        <div class="flex items-center justify-between gap-3 py-3 px-4">
            <span class="text-sm font-medium truncate">{grant.username}</span>
            <InlineConfirm
                triggerLabel={m.device_helpers_remove()}
                ariaLabel={m.device_helpers_remove_label({ username: grant.username })}
                confirmLabel={m.settings_devices_confirm()}
                busy={removing === grant.username}
                onConfirm={() => remove(grant.username)} />
        </div>
    {/each}
    <form class="flex items-end gap-2 py-3 px-4" onsubmit={add}>
        <label class="flex-1 min-w-0 text-sm">
            <span class="block mb-1 text-surface-300">{m.device_helpers_username_label()}</span>
            <input
                type="text"
                class="input w-full"
                maxlength="128"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder={m.device_helpers_username_placeholder()}
                bind:value={username} />
        </label>
        <button
            type="submit"
            class="btn variant-filled-primary"
            disabled={adding || username.trim().length === 0}>
            {m.device_helpers_add()}
        </button>
    </form>
    {#if formError}
        <p class="pb-3 px-4 text-sm text-warning-400" role="alert">{formError}</p>
    {/if}
</SettingsGroup>
