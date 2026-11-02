<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { resolve } from '$lib/paths';
    import { Icon, PauseCircle, PlayCircle, Moon, Bolt } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';

    /**
     * Admin Home "Load Controls" card (audit Tier 2 #27): the global pause an
     * operator's most common real need — "use less of my machine, right now" —
     * with no dedicated control to reach for today. Composes the existing
     * per-resource-class queue pause (same BullMQ primitive as
     * `/api/v1/queues/{class}/pause`) across every class, plus quiet-hours
     * status, plus the Gentle/Balanced/Fast work profile.
     *
     * Self-contained: this data (pause state, quiet-hours window, work
     * profile + host core count) has no home in the canonical admin status
     * payload, so — like SetupChecklist — it fetches its own state rather
     * than adding a fourth signal source to that payload. Polls the pause
     * endpoint while mounted; each poll also drives the server-side
     * reconciliation that auto-resumes an expired pause and flips quiet
     * hours on/off (see defs/admin/ops/global-pause.ts).
     */

    const POLL_MS = 20_000;
    const DURATIONS = [1, 2, 4, 8, 24] as const;

    function durationLabel(hours: (typeof DURATIONS)[number]): string {
        switch (hours) {
            case 1:
                return m.admin_home_load_controls_duration_1h();
            case 2:
                return m.admin_home_load_controls_duration_2h();
            case 4:
                return m.admin_home_load_controls_duration_4h();
            case 8:
                return m.admin_home_load_controls_duration_8h();
            case 24:
                return m.admin_home_load_controls_duration_24h();
        }
    }

    interface PauseStatus {
        playbackPressure?: {
            paused: boolean;
            reason:
                'cpu_transcode' | 'pod_pressure' | 'host_load' | 'cooloff' | 'minimum_run' | 'none';
            deferredMinutes: number;
            cpuTranscodes: number;
            gpuTranscodes: number;
            loadRatioPerCore: number;
            threshold: number;
        };
        globalPause: {
            active: boolean;
            resumeAt?: string;
            reason?: string;
        };
        quietHours: {
            enabled: boolean;
            start: string;
            end: string;
            active: boolean;
        };
    }

    interface WorkProfileStatus {
        profile: 'gentle' | 'balanced' | 'fast';
        cpuCores: number;
        requiresRestart: boolean;
        concurrency: Record<string, number>;
    }

    let pauseStatus = $state<PauseStatus | null>(null);
    let profileStatus = $state<WorkProfileStatus | null>(null);
    let loading = $state(true);
    let loadError = $state(false);
    let durationHours = $state<(typeof DURATIONS)[number]>(4);
    let reason = $state('');
    let pausing = $state(false);
    let resuming = $state(false);
    let settingProfile = $state<string | null>(null);

    async function loadPauseStatus(): Promise<void> {
        try {
            const res = await fetch('/api/admin/ops/global-pause');
            if (!res.ok) throw new Error(`${res.status}`);
            pauseStatus = (await res.json()) as PauseStatus;
            loadError = false;
        } catch {
            loadError = true;
        }
    }

    async function loadProfileStatus(): Promise<void> {
        try {
            const res = await fetch('/api/admin/ops/work-profile');
            if (!res.ok) throw new Error(`${res.status}`);
            profileStatus = (await res.json()) as WorkProfileStatus;
        } catch {
            // Non-fatal — the pause card still works without the profile block.
        }
    }

    $effect(() => {
        void loadPauseStatus().finally(() => {
            loading = false;
        });
        void loadProfileStatus();
        const id = setInterval(() => {
            void loadPauseStatus();
        }, POLL_MS);
        return () => clearInterval(id);
    });

    function formatTime(iso: string): string {
        try {
            return new Intl.DateTimeFormat(undefined, {
                hour: '2-digit',
                minute: '2-digit',
            }).format(new Date(iso));
        } catch {
            return iso;
        }
    }

    async function pauseNow(): Promise<void> {
        pausing = true;
        try {
            const res = await fetch('/api/admin/ops/global-pause', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    durationHours,
                    reason: reason.trim() || undefined,
                }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            pauseStatus = (await res.json()) as PauseStatus;
            reason = '';
            toasts.success(m.admin_home_load_controls_pause_success());
        } catch {
            toasts.error(m.admin_home_load_controls_pause_error());
        } finally {
            pausing = false;
        }
    }

    async function resumeNow(): Promise<void> {
        resuming = true;
        try {
            const res = await fetch('/api/admin/ops/global-pause', { method: 'DELETE' });
            if (!res.ok) throw new Error(`${res.status}`);
            pauseStatus = (await res.json()) as PauseStatus;
            toasts.success(m.admin_home_load_controls_resume_success());
        } catch {
            toasts.error(m.admin_home_load_controls_resume_error());
        } finally {
            resuming = false;
        }
    }

    async function setProfile(profile: 'gentle' | 'balanced' | 'fast'): Promise<void> {
        if (settingProfile) return;
        settingProfile = profile;
        try {
            const res = await fetch('/api/admin/ops/work-profile', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profile }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            profileStatus = (await res.json()) as WorkProfileStatus;
            toasts.success(m.admin_home_load_controls_work_profile_success());
        } catch {
            toasts.error(m.admin_home_load_controls_work_profile_error());
        } finally {
            settingProfile = null;
        }
    }

    const profileOptions = [
        { id: 'gentle' as const, label: () => m.admin_home_load_controls_work_profile_gentle() },
        {
            id: 'balanced' as const,
            label: () => m.admin_home_load_controls_work_profile_balanced(),
        },
        { id: 'fast' as const, label: () => m.admin_home_load_controls_work_profile_fast() },
    ];
</script>

<section
    class="space-y-4 rounded-lg border border-surface-700/40 bg-surface-900/40 p-4"
    aria-label={m.admin_home_load_controls_heading()}>
    <h3
        class="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-surface-400">
        <Icon src={PauseCircle} class="h-3.5 w-3.5" aria-hidden="true" />
        {m.admin_home_load_controls_heading()}
    </h3>

    {#if loading}
        <div class="h-16 animate-pulse rounded bg-surface-800/60"></div>
    {:else if loadError || !pauseStatus}
        <p class="text-sm text-surface-500">{m.admin_home_load_controls_error()}</p>
    {:else}
        {#if pauseStatus.playbackPressure}
            {@const pressure = pauseStatus.playbackPressure}
            <div class="space-y-1 text-sm text-surface-300" role="status">
                {#if pressure.paused}
                    <p class="text-amber-300">{m.admin_home_playback_cpu_paused()}</p>
                    <p class="text-xs text-surface-400">
                        {#if pressure.reason === 'cpu_transcode'}
                            {m.admin_home_playback_cpu_encoding()}
                        {:else if pressure.reason === 'host_load' || pressure.reason === 'pod_pressure'}
                            {m.admin_home_playback_cpu_load()}
                        {:else}
                            {m.admin_home_playback_cpu_cooloff()}
                        {/if}
                        {m.admin_home_playback_cpu_checkpoint()}
                    </p>
                {:else}
                    <p>{m.admin_home_playback_cpu_ready()}</p>
                {/if}
                {#if pressure.deferredMinutes > 0}
                    <p>
                        {m.admin_home_playback_cpu_deferred({ minutes: pressure.deferredMinutes })}
                    </p>
                {/if}
                <p class="text-xs text-surface-500">
                    {m.admin_home_playback_cpu_stats({
                        cpu: pressure.cpuTranscodes,
                        gpu: pressure.gpuTranscodes,
                        load: pressure.loadRatioPerCore.toFixed(2),
                        threshold: pressure.threshold,
                    })}
                </p>
                <a
                    href={resolve('/admin/settings/tasks')}
                    class="text-xs text-sky-400 hover:text-sky-300"
                    >{m.admin_home_playback_cpu_configure()}</a>
            </div>
        {/if}
        <!-- Pause everything -->
        <div class="space-y-2">
            <p class="text-sm text-surface-300">{m.admin_home_load_controls_pause_desc()}</p>
            {#if pauseStatus.globalPause.active}
                <div class="flex flex-wrap items-center gap-3">
                    <span class="text-sm text-amber-300">
                        {m.admin_home_load_controls_pause_active({
                            time: pauseStatus.globalPause.resumeAt
                                ? formatTime(pauseStatus.globalPause.resumeAt)
                                : '',
                        })}
                    </span>
                    <button
                        type="button"
                        onclick={resumeNow}
                        disabled={resuming}
                        class="inline-flex items-center gap-1 rounded border border-surface-600 px-2.5 py-1 text-xs font-medium text-surface-200 hover:bg-surface-800 disabled:opacity-50">
                        <Icon src={PlayCircle} class="h-3.5 w-3.5" aria-hidden="true" />
                        {m.admin_home_load_controls_resume_button()}
                    </button>
                </div>
                {#if pauseStatus.globalPause.reason}
                    <p class="text-xs text-surface-500">
                        {m.admin_home_load_controls_pause_reason({
                            reason: pauseStatus.globalPause.reason,
                        })}
                    </p>
                {/if}
            {:else}
                <div class="flex flex-wrap items-center gap-2">
                    <select
                        bind:value={durationHours}
                        class="rounded border border-surface-600 bg-surface-800 px-2 py-1 text-sm text-surface-200">
                        {#each DURATIONS as hours (hours)}
                            <option value={hours}>{durationLabel(hours)}</option>
                        {/each}
                    </select>
                    <input
                        type="text"
                        bind:value={reason}
                        placeholder={m.admin_home_load_controls_pause_reason_placeholder()}
                        maxlength="500"
                        class="min-w-0 flex-1 rounded border border-surface-600 bg-surface-800 px-2 py-1 text-sm text-surface-200 placeholder:text-surface-500" />
                    <button
                        type="button"
                        onclick={pauseNow}
                        disabled={pausing}
                        class="inline-flex items-center gap-1 rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50">
                        <Icon src={PauseCircle} class="h-3.5 w-3.5" aria-hidden="true" />
                        {m.admin_home_load_controls_pause_button()}
                    </button>
                </div>
            {/if}
        </div>

        <!-- Quiet hours -->
        <div class="flex items-center justify-between gap-2 border-t border-surface-800 pt-3">
            <span class="flex items-center gap-1.5 text-sm text-surface-300">
                <Icon src={Moon} class="h-4 w-4 text-surface-500" aria-hidden="true" />
                {m.admin_home_load_controls_quiet_hours_heading()}:
                {#if pauseStatus.quietHours.enabled}
                    {m.admin_home_load_controls_quiet_hours_window({
                        start: pauseStatus.quietHours.start,
                        end: pauseStatus.quietHours.end,
                    })}
                    {#if pauseStatus.quietHours.active}
                        <span class="text-indigo-300"
                            >({m.admin_home_load_controls_quiet_hours_active_now()})</span>
                    {/if}
                {:else}
                    {m.admin_home_load_controls_quiet_hours_off()}
                {/if}
            </span>
            <a
                href={resolve('/admin/settings/tasks')}
                class="shrink-0 text-xs font-medium text-sky-400 hover:text-sky-300">
                {m.admin_home_load_controls_quiet_hours_configure()}
            </a>
        </div>

        <!-- Work profile -->
        {#if profileStatus}
            <div class="border-t border-surface-800 pt-3">
                <div class="mb-1.5 flex items-center justify-between">
                    <span class="flex items-center gap-1.5 text-sm text-surface-300">
                        <Icon src={Bolt} class="h-4 w-4 text-surface-500" aria-hidden="true" />
                        {m.admin_home_load_controls_work_profile_heading()}
                    </span>
                </div>
                <div
                    class="flex gap-1.5"
                    role="group"
                    aria-label={m.admin_home_load_controls_work_profile_heading()}>
                    {#each profileOptions as opt (opt.id)}
                        <button
                            type="button"
                            onclick={() => setProfile(opt.id)}
                            disabled={settingProfile !== null}
                            aria-pressed={profileStatus?.profile === opt.id}
                            class="rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 {profileStatus?.profile ===
                            opt.id
                                ? 'bg-sky-600 text-white'
                                : 'border border-surface-600 text-surface-300 hover:bg-surface-800'}">
                            {opt.label()}
                        </button>
                    {/each}
                </div>
                <p class="mt-1.5 text-xs text-surface-500">
                    {m.admin_home_load_controls_work_profile_restart_notice()}
                </p>
            </div>
        {/if}
    {/if}
</section>
