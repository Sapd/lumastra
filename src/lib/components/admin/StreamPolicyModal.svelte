<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { ActionModal } from '$lib/components/admin';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import * as adminApi from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { formatApiError } from '$lib/utils/api-error-format';
    import type { UpdatePolicyRequest } from '$lib/schemas/play-sessions';
    import { UNLIMITED_CONCURRENT_STREAMS, isUnlimitedStreams } from '$lib/schemas/play-sessions';

    interface Props {
        username: string;
        onclose: () => void;
        /** Render in place (the user drawer's Access tab) instead of as a dialog. */
        inline?: boolean;
    }

    let { username, onclose, inline = false }: Props = $props();

    // ── loaded state ────────────────────────────────────────────────────────
    let loading = $state(true);
    let loadError = $state<string | null>(null);
    let loadedUserId = $state<string | null>(null);

    // ── editable form state ─────────────────────────────────────────────────
    let maxConcurrentStreams = $state(2);
    // Separate from the number above so toggling unlimited off restores the
    // operator's previous figure instead of resetting to a hardcoded default.
    let unlimitedStreams = $state(false);
    let requireSingleIp = $state(false);
    let ipGracePeriodSeconds = $state(120);
    // `undefined` (an empty input) = unlimited → max_bitrate_kbps: null.
    // MUST NOT be typed as a string: Svelte coerces `<input type="number">`
    // bindings to number | undefined, so a string-typed state here would blow
    // up on any string method the moment the field is edited.
    let maxBitrateKbps = $state<number | undefined>(undefined);

    // allowed_play_methods editing is intentionally out of scope for this
    // editor (niche) — the effective value is preserved as-is on save since
    // the PUT request simply omits the field.

    let saving = $state(false);
    let resetting = $state(false);

    /** True when the effective policy is a per-user override rather than inherited. */
    let isOverride = $derived(loadedUserId === username);

    async function load(): Promise<void> {
        loading = true;
        loadError = null;
        try {
            const { data, error, details } = await adminApi.getStreamPolicy(username);
            if (error) {
                loadError = formatApiError(error, details) || 'Failed to load stream policy';
            } else if (data) {
                loadedUserId = data.user_id;
                unlimitedStreams = isUnlimitedStreams(data.max_concurrent_streams);
                // Keep the number input on a sane figure while unlimited is on,
                // so unchecking it doesn't surface a raw -1.
                maxConcurrentStreams = unlimitedStreams ? 2 : data.max_concurrent_streams;
                requireSingleIp = data.require_single_ip;
                ipGracePeriodSeconds = data.ip_grace_period_seconds;
                maxBitrateKbps = data.max_bitrate_kbps ?? undefined;
            }
        } catch (e) {
            loadError = getErrorMessage(e, 'Failed to load stream policy');
        } finally {
            loading = false;
        }
    }

    $effect(() => {
        void load();
    });

    async function save(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const body: UpdatePolicyRequest = {
                max_concurrent_streams: unlimitedStreams
                    ? UNLIMITED_CONCURRENT_STREAMS
                    : maxConcurrentStreams,
                require_single_ip: requireSingleIp,
                ip_grace_period_seconds: ipGracePeriodSeconds,
                max_bitrate_kbps: maxBitrateKbps ?? null,
            };
            const { data, error, details } = await adminApi.updateStreamPolicy(username, body);
            if (error) {
                // formatApiError appends the server's field-level 422 reasons
                // ("max concurrent streams: Too big…") — without it an operator
                // just sees "Request validation failed" and cannot tell what to fix.
                toasts.error(formatApiError(error, details) || 'Failed to save stream policy');
            } else if (data) {
                toasts.success('Stream policy saved');
                await load();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to save stream policy'));
        } finally {
            saving = false;
        }
    }

    async function resetToDefault(): Promise<void> {
        if (resetting) return;
        resetting = true;
        try {
            const { error, details } = await adminApi.deleteStreamPolicy(username);
            if (error) {
                toasts.error(formatApiError(error, details) || 'Failed to reset stream policy');
            } else {
                toasts.success('Reset to default policy');
                await load();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to reset stream policy'));
        } finally {
            resetting = false;
        }
    }
</script>

<ActionModal title="Stream policy — {username}" {inline} {onclose}>
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
        <div class="space-y-4">
            <div class="flex items-center gap-2">
                {#if isOverride}
                    <span
                        class="text-xs bg-purple-900/40 text-purple-300 border border-purple-700/50 rounded px-1.5 py-0.5">
                        Custom override
                    </span>
                {:else}
                    <span
                        class="text-xs bg-surface-600/50 text-surface-300 border border-surface-600 rounded px-1.5 py-0.5">
                        Inherited from default
                    </span>
                {/if}
            </div>

            <label class="flex items-center justify-between gap-2">
                <span class="text-sm text-surface-300">Unlimited concurrent streams</span>
                <Toggle
                    bind:checked={unlimitedStreams}
                    disabled={saving || resetting}
                    label="Unlimited concurrent streams" />
            </label>

            {#if !unlimitedStreams}
                <label class="block">
                    <span class="text-sm text-surface-300">Max concurrent streams</span>
                    <input
                        type="number"
                        min="0"
                        max="20"
                        step="1"
                        class="w-full mt-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                        bind:value={maxConcurrentStreams}
                        disabled={saving || resetting} />
                    <span class="text-xs text-surface-500">
                        0 blocks all streams for this user. Maximum 20 — use the unlimited toggle
                        above for no cap.
                    </span>
                </label>
            {/if}

            <label class="flex items-center justify-between gap-2">
                <span class="text-sm text-surface-300">Require single IP</span>
                <Toggle
                    bind:checked={requireSingleIp}
                    disabled={saving || resetting}
                    label="Require single IP" />
            </label>

            {#if requireSingleIp}
                <label class="block">
                    <span class="text-sm text-surface-300">IP grace period (seconds)</span>
                    <input
                        type="number"
                        min="0"
                        max="3600"
                        step="1"
                        class="w-full mt-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                        bind:value={ipGracePeriodSeconds}
                        disabled={saving || resetting} />
                    <span class="text-xs text-surface-500">
                        Time allowed on a second IP before it is blocked.
                    </span>
                </label>
            {/if}

            <label class="block">
                <span class="text-sm text-surface-300">Max bitrate (kbps)</span>
                <input
                    type="number"
                    min="1"
                    step="1"
                    placeholder="Unlimited"
                    class="w-full mt-1 bg-surface-700 border border-surface-600 rounded-lg px-3 py-2 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                    bind:value={maxBitrateKbps}
                    disabled={saving || resetting} />
                <span class="text-xs text-surface-500">Leave empty for unlimited.</span>
            </label>
        </div>
    {/if}

    {#snippet footer()}
        <div class="flex items-center justify-between gap-3 mt-2 pt-4 border-t border-surface-700">
            <div>
                {#if !loading && !loadError && isOverride}
                    <button
                        type="button"
                        class="btn btn-ghost disabled:opacity-50"
                        onclick={() => void resetToDefault()}
                        disabled={saving || resetting}
                        title="Delete the per-user override and fall back to the default policy">
                        {#if resetting}
                            <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                            Resetting…
                        {:else}
                            Reset to default
                        {/if}
                    </button>
                {/if}
            </div>
            <div class="flex gap-3">
                {#if !inline}
                    <button
                        type="button"
                        class="btn btn-ghost"
                        data-autofocus
                        disabled={saving || resetting}
                        onclick={() => onclose()}>
                        Cancel
                    </button>
                {/if}
                {#if !loading && !loadError}
                    <button
                        type="button"
                        class="btn btn-blue font-medium disabled:opacity-50"
                        onclick={() => void save()}
                        disabled={saving || resetting}>
                        {#if saving}
                            <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                            Saving…
                        {:else}
                            Save changes
                        {/if}
                    </button>
                {/if}
            </div>
        </div>
    {/snippet}
</ActionModal>
