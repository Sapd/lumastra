<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { Icon, Wrench, XCircle, ChevronDown } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import {
        getMaintenanceNotice,
        setMaintenanceNotice,
        clearMaintenanceNotice,
    } from '$lib/api/admin';
    import type { MaintenanceNotice } from '$lib/schemas/api-admin-responses';
    import type { MaintenanceNoticeWire } from '$lib/stores/maintenance-notice.store.svelte';
    import { formatCountdown } from '$lib/utils/countdown.js';
    import * as m from '$lib/paraglide/messages.js';

    function formatCreatedAt(epochMs: number): string {
        return new Date(epochMs).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    interface Props {
        /**
         * Rendered inside the "Message users" page, where the kind picker
         * already says what a maintenance banner is: always open, no
         * collapsible header.
         */
        embedded?: boolean;
    }
    let { embedded = false }: Props = $props();

    // ── state ────────────────────────────────────────────────────────
    let collapsed = $state(untrack(() => !embedded));
    let notice = $state<MaintenanceNotice | null>(null);
    /**
     * How much of the currently-streaming audience will actually see a banner.
     *
     * Shown as a count and NEVER as a gate: a maintenance notice is a global
     * broadcast with no single target session, so disabling the button because
     * one connected client is incompatible would be wrong. A client that does
     * not understand the frame ignores it — the correct failure mode. Absent
     * (server could not count) simply hides the line.
     */
    let reach = $state<{ total: number; supporting: number } | null>(null);
    // Local-clock-anchored endsAt: computed on fetch using remainingMs so
    // admin countdown is immune to server/client clock skew.
    let localEndsAt = $state<number | null>(null);
    let loadError = $state(false);

    // Compose form state
    const MAX_CHARS = 500;
    const AMBER_THRESHOLD = Math.floor(MAX_CHARS * 0.8);
    let composeMessage = $state('');
    let customMinutes = $state(30);
    let selectedPreset = $state<5 | 15 | 30 | 60 | 'custom'>(30);
    let busy = $state(false);

    // Live countdown ticker
    let countdownTick = $state(0);

    let charCount = $derived(composeMessage.length);
    let charCountColor = $derived(
        charCount >= MAX_CHARS
            ? 'text-red-400'
            : charCount >= AMBER_THRESHOLD
              ? 'text-amber-400'
              : 'text-surface-500',
    );

    let effectiveMinutes = $derived(selectedPreset === 'custom' ? customMinutes : selectedPreset);

    let canStart = $derived(composeMessage.trim().length > 0 && effectiveMinutes >= 1 && !busy);

    let countdown = $derived.by(() => {
        // Re-evaluate when countdownTick changes
        void countdownTick;
        if (!notice || localEndsAt === null) return '';
        return formatCountdown(Math.max(0, localEndsAt - Date.now()));
    });

    let noticeExpired = $derived.by(() => {
        void countdownTick;
        if (!notice || localEndsAt === null) return false;
        return localEndsAt <= Date.now();
    });

    // ── data loading ─────────────────────────────────────────────────
    async function load(): Promise<void> {
        try {
            const { data, error } = await getMaintenanceNotice();
            if (error) throw new Error(error);
            const fetched = (data?.notice ?? null) as MaintenanceNoticeWire | null;
            notice = fetched;
            reach = data?.reach ?? null;
            if (fetched !== null) {
                // Anchor countdown to local clock via remainingMs so admin
                // UI is not thrown off by server/client clock skew.
                localEndsAt =
                    fetched.remainingMs !== undefined
                        ? Date.now() + fetched.remainingMs
                        : fetched.endsAt;
            } else {
                localEndsAt = null;
            }
            loadError = false;
        } catch {
            loadError = true;
        }
    }

    // ── auto-refresh + countdown tick ────────────────────────────────
    $effect(() => {
        void load();

        const pollId = setInterval(() => {
            void load();
        }, 5000);

        const tickId = setInterval(() => {
            countdownTick += 1;
        }, 1000);

        return () => {
            clearInterval(pollId);
            clearInterval(tickId);
        };
    });

    // When countdown hits zero, clear the local notice state immediately
    $effect(() => {
        if (noticeExpired && notice !== null) {
            notice = null;
        }
    });

    // ── actions ──────────────────────────────────────────────────────
    async function handleStart(): Promise<void> {
        if (!canStart) return;
        busy = true;
        try {
            const { data, error, status } = await setMaintenanceNotice({
                message: composeMessage.trim(),
                minutes: effectiveMinutes,
            });
            if (error) {
                // 409 Conflict → another notice is already active.
                // Branch on HTTP status rather than sniffing the error string,
                // which is fragile to any change in the error envelope.
                if (status === 409) {
                    toasts.error('A maintenance notice is already active');
                    await load();
                } else {
                    toasts.error(error || 'Failed to start maintenance notice');
                }
                return;
            }
            const created = (data?.notice ?? null) as MaintenanceNoticeWire | null;
            notice = created;
            localEndsAt = created
                ? created.remainingMs !== undefined
                    ? Date.now() + created.remainingMs
                    : created.endsAt
                : null;
            composeMessage = '';
            selectedPreset = 30;
            toasts.success('Maintenance notice started');
        } catch {
            toasts.error('Failed to start maintenance notice');
        } finally {
            busy = false;
        }
    }

    async function handleClear(): Promise<void> {
        busy = true;
        try {
            const { error } = await clearMaintenanceNotice();
            if (error) {
                toasts.error(error || 'Failed to clear maintenance notice');
                return;
            }
            notice = null;
            localEndsAt = null;
            toasts.success('Maintenance notice cleared');
        } catch {
            toasts.error('Failed to clear maintenance notice');
        } finally {
            busy = false;
        }
    }

    const presets: { value: 5 | 15 | 30 | 60; label: string }[] = [
        { value: 5, label: '5 min' },
        { value: 15, label: '15 min' },
        { value: 30, label: '30 min' },
        { value: 60, label: '60 min' },
    ];
</script>

<div class="bg-surface-800/50 border border-surface-700 rounded-xl overflow-hidden">
    <!-- Header -->
    {#if !embedded}<button
            type="button"
            onclick={() => (collapsed = !collapsed)}
            aria-expanded={!collapsed}
            aria-controls={collapsed ? undefined : 'maintenance-notice-body'}
            class="w-full px-5 py-4 flex items-center gap-2 {collapsed
                ? ''
                : 'border-b border-surface-700/60'} hover:bg-surface-800/40 transition-colors text-left">
            <Icon src={Wrench} class="w-4 h-4 text-amber-400 shrink-0" />
            <h3 class="text-sm font-medium text-surface-200 uppercase tracking-wider flex-1">
                Maintenance Notice
            </h3>
            {#if notice !== null}
                <span
                    class="text-xs font-mono text-amber-300 tabular-nums"
                    aria-label="active notice countdown">
                    {countdown}
                </span>
            {/if}
            <Icon
                src={ChevronDown}
                class="w-4 h-4 text-surface-400 shrink-0 transition-transform {collapsed
                    ? ''
                    : 'rotate-180'}" />
        </button>{/if}

    {#if !collapsed}
        <div id="maintenance-notice-body" class="px-5 py-4">
            {#if loadError}
                <p class="text-sm text-red-400">Failed to load maintenance notice status.</p>
            {:else if notice === null}
                <!-- ── State A: no active notice ── -->
                <p class="text-sm text-surface-400 mb-1">
                    Broadcast a persistent banner with a live countdown to every connected user.
                </p>
                {#if !embedded}
                    <p class="text-xs text-surface-500 mb-4">
                        {m.admin_maintenance_notice_vs_broadcast_hint()}
                    </p>
                {:else}
                    <div class="mb-3"></div>
                {/if}

                {#if reach !== null && reach.total > 0}
                    <p
                        class="text-xs mb-4 {reach.supporting < reach.total
                            ? 'text-amber-400/90'
                            : 'text-surface-500'}"
                        title="Counted over active and paused play sessions. Clients that did not announce support ignore the banner; the notice is still sent to everyone.">
                        Will display on {reach.supporting} of {reach.total} active {reach.total ===
                        1
                            ? 'session'
                            : 'sessions'}
                        {#if reach.supporting < reach.total}
                            — the rest ignore it
                        {/if}
                    </p>
                {/if}

                <div class="space-y-4">
                    <!-- Message -->
                    <div>
                        <div class="flex items-center justify-between mb-1.5">
                            <label
                                for="maintenance-msg"
                                class="text-sm font-medium text-surface-300">
                                Message
                            </label>
                            <span class="text-xs {charCountColor}">{charCount} / {MAX_CHARS}</span>
                        </div>
                        <textarea
                            id="maintenance-msg"
                            bind:value={composeMessage}
                            maxlength={MAX_CHARS}
                            rows={3}
                            placeholder="We'll be performing maintenance in…"
                            class="w-full rounded-lg bg-surface-900/60 border border-surface-600 text-white placeholder-surface-500 text-sm px-3 py-2 focus:outline-none focus:border-amber-500 resize-none transition-colors">
                        </textarea>
                    </div>

                    <!-- Duration presets -->
                    <div>
                        <p class="text-sm font-medium text-surface-300 mb-2">Duration</p>
                        <div class="flex flex-wrap gap-2">
                            {#each presets as preset (preset.value)}
                                <button
                                    type="button"
                                    onclick={() => (selectedPreset = preset.value)}
                                    class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors
                                    {selectedPreset === preset.value
                                        ? 'border-amber-500 bg-amber-900/40 text-amber-200'
                                        : 'border-surface-600 bg-surface-800 text-surface-400 hover:border-surface-500 hover:text-surface-300'}">
                                    {preset.label}
                                </button>
                            {/each}
                            <button
                                type="button"
                                onclick={() => (selectedPreset = 'custom')}
                                class="px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors
                                {selectedPreset === 'custom'
                                    ? 'border-amber-500 bg-amber-900/40 text-amber-200'
                                    : 'border-surface-600 bg-surface-800 text-surface-400 hover:border-surface-500 hover:text-surface-300'}">
                                Custom
                            </button>
                            {#if selectedPreset === 'custom'}
                                <div class="flex items-center gap-2 w-full mt-1">
                                    <input
                                        type="number"
                                        bind:value={customMinutes}
                                        min={1}
                                        max={1440}
                                        class="w-24 rounded-lg bg-surface-900/60 border border-surface-600 text-white text-sm px-3 py-2 focus:outline-none focus:border-amber-500 transition-colors" />
                                    <span class="text-sm text-surface-400">minutes</span>
                                </div>
                            {/if}
                        </div>
                    </div>

                    <!-- Start button -->
                    <button
                        type="button"
                        onclick={() => void handleStart()}
                        disabled={!canStart}
                        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border font-medium text-sm transition-colors
                        {canStart
                            ? 'border-amber-600 bg-amber-900/30 text-amber-200 hover:bg-amber-900/50 hover:border-amber-500'
                            : 'border-surface-700 bg-surface-800/40 text-surface-500 cursor-not-allowed'}">
                        <Icon src={Wrench} class="w-4 h-4" />
                        {busy ? 'Starting…' : 'Start Maintenance Notice'}
                    </button>
                </div>
            {:else}
                <!-- ── State B: active notice ── -->
                <div class="space-y-4">
                    <!-- Countdown -->
                    <div class="flex items-center gap-4">
                        <div class="text-3xl font-mono font-bold text-amber-300 tabular-nums">
                            {countdown}
                        </div>
                        <div class="text-sm text-surface-400">remaining</div>
                    </div>

                    <!-- Notice message -->
                    <div class="bg-amber-950/30 border border-amber-700/40 rounded-lg px-4 py-3">
                        <p class="text-sm text-amber-100">{notice.message}</p>
                    </div>

                    <!-- Meta -->
                    <p class="text-xs text-surface-500">
                        Created by
                        <span class="text-surface-300 font-medium">{notice.createdBy}</span>
                        at {formatCreatedAt(notice.createdAt)}
                    </p>

                    <!-- Cancel button -->
                    <button
                        type="button"
                        onclick={() => void handleClear()}
                        disabled={busy}
                        class="inline-flex items-center gap-2 px-4 py-2 rounded-lg border font-medium text-sm transition-colors
                        border-red-700/60 bg-red-950/20 text-red-300 hover:bg-red-900/30 hover:border-red-600
                        disabled:opacity-50 disabled:cursor-not-allowed">
                        <Icon src={XCircle} class="w-4 h-4" />
                        {busy ? 'Cancelling…' : 'Cancel Notice'}
                    </button>
                </div>
            {/if}
        </div>
    {/if}
</div>
