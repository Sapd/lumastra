<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Per-plugin card for the admin Extensions page: header (name/version/kind/status/
  load state), trust row (signingKeyId + derived source + bundle indicator),
  declared capabilities, a persistent restart badge, and lifecycle actions.

  HONESTY (trust invariant #3): disable/uninstall/failed-enable-or-reload toasts
  always say the change takes effect ONLY on restart while the plugin is still
  loaded. The persistent restart badge is driven by the REFRESHED list's
  `restartRequired` (list-truth after onchanged()), never the mutation response
  literal — the disable handler always returns restartRequired:true even when the
  plugin was never loaded, so wiring the badge to that would lie.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import {
        enableExternalPlugin,
        disableExternalPlugin,
        reloadExternalPlugin,
        uninstallExternalPlugin,
    } from '$lib/api/admin.js';
    import type { ExternalPluginListItem } from '$lib/schemas/api-external-plugins.js';
    import CapabilityBadges from './CapabilityBadges.svelte';

    let { plugin, onchanged }: { plugin: ExternalPluginListItem; onchanged: () => void } = $props();

    type Action = '' | 'enable' | 'disable' | 'reload' | 'uninstall';
    let busy = $state<Action>('');
    let confirmingUninstall = $state(false);

    let isUninstalled = $derived(plugin.status === 'uninstalled');
    /**
     * A drop-in has no `external_plugins` row, so every lifecycle endpoint
     * looks one up and 404s. Offering the buttons would be offering failure —
     * the card says "managed on disk" instead.
     */
    let isDropIn = $derived(plugin.source === 'drop-in');
    /**
     * Shipped inside the image: first-party, current with it, and — like a
     * drop-in — without a row, so equally read-only. It must not read as an
     * "unverified" thing the operator put there.
     */
    let isBundled = $derived(plugin.source === 'bundled');
    let isReadOnly = $derived(isDropIn || isBundled);

    async function doEnable(): Promise<void> {
        if (busy) return;
        busy = 'enable';
        const { data, error } = await enableExternalPlugin(plugin.id);
        busy = '';
        if (error) {
            toasts.error(error);
            return;
        }
        // Honest copy: loaded true → actually took effect; else restart-only.
        if (data && 'loaded' in data && data.loaded) {
            toasts.success(m.plugins_external_toast_enabled());
        } else {
            toasts.info(m.plugins_external_toast_enable_restart());
        }
        onchanged();
    }

    async function doDisable(): Promise<void> {
        if (busy) return;
        busy = 'disable';
        const { error } = await disableExternalPlugin(plugin.id);
        busy = '';
        if (error) {
            toasts.error(error);
            return;
        }
        // The running code stays live until restart — say so.
        toasts.info(m.plugins_external_toast_disabled_restart());
        onchanged();
    }

    async function doReload(): Promise<void> {
        if (busy) return;
        busy = 'reload';
        const { data, error } = await reloadExternalPlugin(plugin.id);
        busy = '';
        if (error) {
            toasts.error(error);
            return;
        }
        if (data && data.reloaded) {
            toasts.success(m.plugins_external_toast_reloaded());
        } else {
            toasts.info(m.plugins_external_toast_reload_restart());
        }
        onchanged();
    }

    async function doUninstall(): Promise<void> {
        if (busy) return;
        if (!confirmingUninstall) {
            confirmingUninstall = true;
            return;
        }
        confirmingUninstall = false;
        busy = 'uninstall';
        const { error } = await uninstallExternalPlugin(plugin.id);
        busy = '';
        if (error) {
            toasts.error(error);
            return;
        }
        // Restart-only: the code keeps running with full host trust until restart.
        toasts.info(m.plugins_external_toast_uninstalled_restart());
        onchanged();
    }
</script>

<div class="card-base space-y-3">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
                <h4 class="text-lg font-medium text-white">{plugin.name}</h4>
                <!-- Only when there IS one. A drop-in whose contract declares
                     no version has nothing to show, and "v" + a placeholder
                     rendered as "vunknown". -->
                {#if plugin.version}
                    <span class="text-sm text-surface-400">v{plugin.version}</span>
                {/if}
                <span class="badge preset-tonal-surface text-xs">
                    {plugin.kind ?? m.plugins_external_kind_unknown()}
                </span>
                {#if isBundled}
                    <span
                        class="badge preset-tonal-success text-xs"
                        title={m.plugins_external_bundled_hint()}>
                        {m.plugins_external_bundled()}
                    </span>
                {:else if !isDropIn}
                    <!-- "Installed" only for a plugin installed through
                         Lumastra; a drop-in says the opposite right below. -->
                    <span
                        class="badge text-xs {isUninstalled
                            ? 'preset-tonal-error'
                            : 'preset-tonal-primary'}">
                        {isUninstalled
                            ? m.plugins_external_status_uninstalled()
                            : m.plugins_external_status_installed()}
                    </span>
                {/if}
                <!-- A drop-in carries no signature, no checksum and no
                     provenance, and is never tamper-evident on disk the way a
                     registry-managed plugin is (whose tree digest is
                     re-verified on every load). That difference should be
                     VISIBLE rather than inferable from the absence of buttons. -->
                {#if isDropIn}
                    <span
                        class="badge preset-tonal-warning text-xs"
                        title={m.plugins_external_unverified_hint()}>
                        {m.plugins_external_unverified()}
                    </span>
                {/if}
            </div>
            <div class="mt-1 text-sm">
                {#if plugin.error}
                    <span class="text-red-400">
                        {m.plugins_external_error_label()}: {plugin.error}
                    </span>
                {:else if plugin.loaded}
                    <span class="text-green-400">{m.plugins_external_loaded()}</span>
                {:else}
                    <span class="text-surface-500">{m.plugins_external_not_loaded()}</span>
                {/if}
            </div>
        </div>
    </div>

    {#if isUninstalled && plugin.loaded}
        <div class="section-error text-sm">
            {m.plugins_external_uninstalled_still_loaded()}
        </div>
    {/if}

    <!-- Trust row — a bundled plugin's provenance is the image itself; the
         signing-key vocabulary ("source unknown") does not apply to it. -->
    {#if !isBundled}
        <div class="flex flex-wrap items-center gap-2 text-sm">
            {#if plugin.signingKeyId}
                <span class="text-surface-400">{m.plugins_external_signing_key_label()}:</span>
                <span class="font-mono text-xs text-surface-300 truncate max-w-[16rem]">
                    {plugin.signingKeyId}
                </span>
            {/if}
            {#if plugin.signingKeySource === 'official'}
                <span class="badge preset-tonal-success text-xs">
                    {m.plugins_external_source_official()}
                </span>
            {:else if plugin.signingKeySource === 'operator'}
                <span class="badge preset-tonal-primary text-xs">
                    {m.plugins_external_source_operator()}
                </span>
            {:else}
                <span
                    class="badge preset-tonal-warning text-xs"
                    title={m.plugins_external_source_unknown_tooltip()}>
                    {m.plugins_external_source_unknown()}
                </span>
            {/if}
            {#if plugin.bundleInvalid}
                <span class="badge preset-tonal-warning text-xs">
                    {m.plugins_external_bundle_invalid()}
                </span>
            {:else if plugin.isBundle}
                <span class="badge preset-tonal-surface text-xs">
                    {m.plugins_external_bundle_badge()}
                </span>
            {/if}
        </div>
    {/if}

    <!-- Capabilities -->
    <CapabilityBadges capabilities={plugin.capabilities} />

    <!-- Restart badge (list-truth) -->
    {#if plugin.restartRequired}
        <div class="badge preset-tonal-warning text-xs">
            {m.plugins_external_restart_required()}
        </div>
    {/if}

    <!-- Actions -->
    <div class="flex flex-wrap items-center gap-2 pt-1">
        {#if isBundled}
            <p class="text-hint">{m.plugins_external_bundled_note()}</p>
            {#if plugin.shadowedCopy}
                <p class="text-xs text-amber-300">
                    {m.plugins_external_bundled_shadowed({ name: plugin.name })}
                </p>
            {/if}
        {:else if isDropIn}
            <p class="text-hint">
                {m.plugins_external_dropin_note()}
            </p>
        {/if}
        {#if !isUninstalled && !isReadOnly}
            {#if plugin.enabled}
                <button
                    type="button"
                    class="btn-secondary text-sm"
                    disabled={!!busy}
                    onclick={doDisable}>
                    {m.plugins_external_action_disable()}
                </button>
            {:else}
                <button
                    type="button"
                    class="btn-secondary text-sm"
                    disabled={!!busy}
                    onclick={doEnable}>
                    {m.plugins_external_action_enable()}
                </button>
            {/if}
        {/if}
        {#if !isReadOnly}
            <button
                type="button"
                class="btn-secondary text-sm"
                disabled={!!busy}
                onclick={doReload}>
                {m.plugins_external_action_reload()}
            </button>
        {/if}
        {#if !isUninstalled && !isReadOnly}
            {#if confirmingUninstall}
                <button
                    type="button"
                    class="btn-error text-sm"
                    disabled={busy === 'uninstall'}
                    onclick={doUninstall}>
                    {m.plugins_external_action_confirm()}
                </button>
                <button
                    type="button"
                    class="btn-secondary text-sm"
                    onclick={() => (confirmingUninstall = false)}>
                    {m.plugins_external_action_cancel()}
                </button>
            {:else}
                <button
                    type="button"
                    class="btn-error text-sm"
                    disabled={!!busy}
                    onclick={doUninstall}>
                    {m.plugins_external_action_uninstall()}
                </button>
            {/if}
        {/if}
    </div>
</div>
