<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteMap } from 'svelte/reactivity';
    import { useAutoRefresh } from '$lib/utils/use-auto-refresh.svelte';
    import {
        Icon,
        ArrowPath,
        Stop,
        User,
        Cog,
        PlayCircle,
        ChartBar,
        Signal,
        XCircle,
        ExclamationTriangle,
    } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';
    import { confirmDialog } from '$lib/utils/modal-utils';
    import {
        AdminPageHeader,
        BandwidthChart,
        StatCard,
        ActivePlaySessionsPanel,
    } from '$lib/components/admin';
    import type { LayoutData } from '../../$types';
    import type {
        StreamThroughput,
        FFmpegJobsResponse,
        FFmpegJobInfo,
    } from '$lib/types/admin-metrics';
    import { formatElapsed, formatBytes, getDisplayStatus } from '$lib/utils/metric-formatters';
    import { getStatusColor, getStatusBg } from '$lib/utils/metric-styles';
    import * as adminApi from '$lib/api/admin';
    import { getProxyStatus, killProxyConnection } from '$lib/api/livetv';
    import type { ProxyStatusResponse } from '$lib/schemas/livetv';
    import type {
        AdminPlaySession,
        UntrackedJellyfinSession,
    } from '$lib/schemas/api-admin-responses';
    import { sessionChangedRevision } from '$lib/services/sse/watch-state-sse';

    interface Props {
        data: LayoutData;
    }
    let { data }: Props = $props();
    let hasFFmpeg = $derived(data?.features?.ffmpegAvailable ?? false);
    let isStandalone = $derived((data?.features?.liveTvSource ?? 'disabled') === 'standalone');
    let liveTvProxyConfigured = $derived(data?.features?.liveTvProxyConfigured === true);

    // ── Unified data state ──────────────────────────────────────────
    let sessions: AdminPlaySession[] = $state([]);
    let untrackedJellyfinSessions: UntrackedJellyfinSession[] = $state([]);
    let sessionsLoading = $state(true);
    let sessionsError = $state(false);
    let jobsError = $state(false);
    let throughputError = $state(false);
    let proxyStatus = $state<ProxyStatusResponse | null>(null);
    let liveTvError = $state(false);
    let liveTvWasConnected = $state(false);
    let ffmpegJobsData = $state<FFmpegJobsResponse | null>(null);
    let throughput = $state<StreamThroughput | null>(null);
    let lastUpdated = $state<Date | null>(null);
    let refreshing = $state(false);

    // Kill state
    let killingSessionId = $state<string | null>(null);
    let killingChannelId = $state<string | null>(null);
    let stoppingJobId = $state<string | null>(null);

    // ── Derived summary values ──────────────────────────────────────
    let liveTvViewerCount = $derived(proxyStatus?.totalViewers ?? 0);
    let activeJobCount = $derived((ffmpegJobsData as FFmpegJobsResponse | null)?.count ?? 0);
    // Jobs with a live ffmpeg process — the only ones that actually consume CPU/RAM.
    // The summary CPU/RAM strip gates on this so we don't render "0%" for lingering
    // completed jobs that haven't been swept yet.
    let runningJobCount = $derived(
        (ffmpegJobsData as FFmpegJobsResponse | null)?.jobs.filter(
            (j: FFmpegJobInfo) => j.processRunning,
        ).length ?? 0,
    );
    let erroredJobs = $derived(
        (ffmpegJobsData as FFmpegJobsResponse | null)?.jobs.filter(
            (j: FFmpegJobInfo) => j.error || j.status === 'error',
        ) ?? [],
    );
    let encodingMode = $derived.by(() => {
        if (!hasFFmpeg) return null;
        const config = ffmpegJobsData?.config;
        if (!config) return null;
        if (!config.enabled) return m.common_disabled();
        if (config.gpuAcceleration !== 'none') return config.gpuAcceleration;
        return m.admin_sessions_encoding_software();
    });

    let updatedAgo = $derived.by(() => {
        if (!lastUpdated) return '';
        const seconds = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
        if (seconds < 5) return m.time_just_now();
        return m.admin_sessions_seconds_ago({ seconds });
    });

    // Alphabetical sort key: for episodes use the series title so episodes of
    // the same show stay grouped; fall back to the media title otherwise.
    // Ties break on season/episode number, then username, for a stable order.
    function sessionSortKey(s: AdminPlaySession): string {
        return (s.series_title || s.title || '').toLocaleLowerCase();
    }

    let sortedSessions = $derived.by(() => {
        return [...sessions].sort((a, b) => {
            const cmp = sessionSortKey(a).localeCompare(sessionSortKey(b));
            if (cmp !== 0) return cmp;
            const seasonCmp = (a.season_number ?? 0) - (b.season_number ?? 0);
            if (seasonCmp !== 0) return seasonCmp;
            const episodeCmp = (a.episode_number ?? 0) - (b.episode_number ?? 0);
            if (episodeCmp !== 0) return episodeCmp;
            return a.username.localeCompare(b.username);
        });
    });

    // FFmpeg jobs grouped by session
    let jobsBySession = $derived.by(() => {
        const map = new SvelteMap<string, FFmpegJobInfo[]>();
        for (const job of (ffmpegJobsData as FFmpegJobsResponse | null)?.jobs ?? []) {
            const key = job.playSessionId;
            const arr = map.get(key);
            if (arr) arr.push(job);
            else map.set(key, [job]);
        }
        return map;
    });

    // Sorted FFmpeg jobs: errors first, then stale, then active
    let sortedJobs = $derived.by(() => {
        const jobs = [...((ffmpegJobsData as FFmpegJobsResponse | null)?.jobs ?? [])];
        return jobs.sort((a, b) => {
            const scoreA = jobSeverity(a);
            const scoreB = jobSeverity(b);
            return scoreA - scoreB;
        });
    });

    function jobSeverity(job: FFmpegJobInfo): number {
        if (job.error || job.status === 'error') return 0;
        if (job.lastProgressSecondsAgo > 30) return 1;
        if (job.status === 'starting' || job.status === 'ready') return 3;
        return 2; // active/healthy
    }

    // Orphan FFmpeg jobs: jobs whose playSessionId doesn't match any active session.
    // Completed transcodes (status='ready' at 100%) linger briefly until the inactivity
    // sweep clears them — those aren't orphans, just pending cleanup.
    let orphanJobs = $derived.by(() => {
        const sessionIds = new Set(sessions.map((s) => s.__id));
        return sortedJobs.filter(
            (job) =>
                !sessionIds.has(job.playSessionId) &&
                !(job.status === 'ready' && job.progressPercent >= 100),
        );
    });

    // ── Data loading ────────────────────────────────────────────────
    async function loadAll(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        const promises: Promise<void>[] = [loadSessions()];
        if (isStandalone && liveTvProxyConfigured) promises.push(loadLiveTvStatus());
        if (hasFFmpeg) {
            promises.push(loadFFmpegJobs());
        }
        // Cheap (Valkey reads, no GPU probe) and feeds the FFmpeg CPU/RAM figures in
        // the summary strip as well as the bandwidth section.
        promises.push(loadThroughput());
        await Promise.allSettled(promises);
        if (
            !sessionsError &&
            !jobsError &&
            !throughputError &&
            (!isStandalone || !liveTvProxyConfigured || !liveTvError)
        ) {
            lastUpdated = new Date();
        }
        refreshing = false;
    }

    // The 5 s poll and the SSE-triggered reload are not coalesced, and a kill
    // removes its row locally: only the newest load started after the last
    // kill may write, or an older snapshot resurrects the killed session.
    let sessionsLoadGeneration = 0;

    async function loadSessions(): Promise<void> {
        const generation = ++sessionsLoadGeneration;
        try {
            const { data, error } = await adminApi.getAdminPlaySessions();
            if (generation !== sessionsLoadGeneration) return;
            if (error) throw new Error(error);
            if (!data) throw new Error('Missing session response');
            sessions = (data?.sessions ?? []) as AdminPlaySession[];
            untrackedJellyfinSessions = (data?.untrackedJellyfinSessions ??
                []) as UntrackedJellyfinSession[];
            sessionsError = false;
        } catch {
            sessionsError = true;
            if (sessionsLoading) toasts.error(m.admin_toast_failed_to_load_active_sessions());
        } finally {
            sessionsLoading = false;
        }
    }

    async function loadLiveTvStatus(): Promise<void> {
        try {
            const { data, error } = await getProxyStatus();
            if (error) throw new Error(error);
            proxyStatus = data ?? null;
            liveTvError = false;
            liveTvWasConnected = true;
        } catch {
            if (!liveTvError && liveTvWasConnected) {
                toasts.error(m.admin_toast_livetv_proxy_connection_lost());
            }
            liveTvError = true;
            proxyStatus = null;
        }
    }

    async function loadFFmpegJobs(): Promise<void> {
        try {
            const { data, error } = await adminApi.getFfmpegJobs();
            if (error || !data) throw new Error(error || 'Missing jobs response');
            ffmpegJobsData = data;
            jobsError = false;
        } catch (error) {
            jobsError = true;
            console.error('Failed to load FFmpeg jobs:', error);
        }
    }

    async function loadThroughput(): Promise<void> {
        try {
            const { data, error } = await adminApi.getStreamThroughput();
            if (error || !data) throw new Error(error || 'Missing throughput response');
            throughput = data;
            throughputError = false;
        } catch (error) {
            throughputError = true;
            console.error('Failed to load stream throughput:', error);
        }
    }

    useAutoRefresh(loadAll, 5000);

    // Reactive refetch on session lifecycle transitions (start/stop/crash).
    // Complements the 5s poll — surfaces changes immediately without waiting
    // for the next poll tick.
    let sessionChangedBaseline = -1;
    $effect(() => {
        const rev = $sessionChangedRevision;
        if (sessionChangedBaseline === -1) {
            sessionChangedBaseline = rev;
            return;
        }
        void loadSessions();
    });

    // ── Actions ─────────────────────────────────────────────────────
    async function killSession(id: string, username: string, title: string): Promise<void> {
        // The terminate note is the difference between an operator who knows a
        // Jellyfin/Subsonic/offline stream keeps running and one who thinks it stopped.
        const source = sessions.find((s) => s.__id === id)?.source;
        const note =
            source === 'jellyfin' || source === 'subsonic'
                ? m.admin_sessions_terminate_remote_note()
                : source === 'local'
                  ? m.admin_sessions_terminate_local_note()
                  : null;
        try {
            await confirmDialog({
                title: m.admin_sessions_terminate_title(),
                body: [m.admin_sessions_confirm_terminate({ username, title }), note]
                    .filter(Boolean)
                    .join(' '),
                confirmText: m.admin_sessions_terminate_action(),
                confirmVariant: 'danger',
            });
        } catch {
            return;
        }
        killingSessionId = id;
        try {
            const { error, status } = await adminApi.killAdminPlaySession(id);
            // 404: the session ended after the last poll. The goal is met.
            if (error && status !== 404) throw new Error(error);
            toasts.success(m.admin_toast_session_terminated());
            sessionsLoadGeneration++; // drop any snapshot taken before the kill
            sessions = sessions.filter((s) => s.__id !== id);
        } catch {
            toasts.error(m.admin_toast_failed_to_terminate_session());
        } finally {
            // A second kill may have started meanwhile; don't clear its spinner.
            if (killingSessionId === id) killingSessionId = null;
        }
    }

    async function killLiveTvChannel(channelId: string, channelName: string): Promise<void> {
        try {
            await confirmDialog({
                title: m.admin_sessions_kill_livetv_title(),
                body: m.admin_sessions_confirm_kill_livetv({ channelName }),
                confirmText: m.admin_sessions_kill_livetv_action(),
                confirmVariant: 'danger',
            });
        } catch {
            return;
        }
        killingChannelId = channelId;
        try {
            const { error } = await killProxyConnection(channelId);
            if (error) throw new Error(error);
            toasts.success(m.admin_sessions_livetv_channel_terminated({ channelName }));
        } catch {
            toasts.error(m.admin_toast_failed_to_terminate_livetv_channel());
        } finally {
            killingChannelId = null;
        }
    }

    async function stopFFmpegJob(playSessionId: string): Promise<void> {
        try {
            await confirmDialog({
                title: m.admin_sessions_stop_ffmpeg_title(),
                body: m.admin_sessions_confirm_stop_ffmpeg(),
                confirmText: m.admin_sessions_stop_ffmpeg_action(),
                confirmVariant: 'danger',
            });
        } catch {
            return;
        }
        stoppingJobId = playSessionId;
        try {
            const { error } = await adminApi.cancelFfmpegJob(playSessionId);
            if (!error) {
                toasts.success(m.admin_toast_ffmpeg_job_stopped());
                await loadFFmpegJobs();
            } else {
                toasts.error(error || m.admin_sessions_toast_stop_job_failed());
            }
        } catch {
            toasts.error(m.admin_toast_failed_to_stop_ffmpeg_job());
        } finally {
            stoppingJobId = null;
        }
    }
</script>

<svelte:head><title>{m.admin_nav_page_users_sessions()} · Admin</title></svelte:head>

<div class="space-y-4">
    <!-- ── Page Header ─────────────────────────────────────────── -->
    <AdminPageHeader
        icon={adminPageIcons['/admin/users/sessions']}
        title={m.admin_nav_page_users_sessions()}
        description={m.admin_redesign_sessions_description()}>
        <div class="flex flex-wrap items-center gap-3">
            {#if lastUpdated}
                <span class="text-xs text-surface-500">
                    {m.admin_sessions_updated({ ago: updatedAgo })}
                    <span class="text-surface-600 ml-1"
                        >· {m.admin_sessions_auto_refresh_on()}</span>
                </span>
            {/if}
            <button
                class="px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg flex items-center gap-1.5 transition-colors text-sm"
                onclick={() => void loadAll()}
                disabled={refreshing}>
                <Icon
                    src={ArrowPath}
                    class="w-4 h-4 {refreshing
                        ? 'animate-spin'
                        : ''}" />{m.common_refresh()}</button>
        </div>
    </AdminPageHeader>

    {#if sessionsError || jobsError || throughputError}
        <div
            role="status"
            class="rounded-xl border border-amber-700/60 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
            <p>{m.admin_redesign_sessions_refresh_failed()}</p>
            <p class="mt-1 text-xs">
                {[
                    sessionsError ? m.admin_redesign_sessions_live_title() : null,
                    jobsError ? 'FFmpeg' : null,
                    throughputError ? m.admin_sessions_stream_throughput() : null,
                ]
                    .filter(Boolean)
                    .join(' · ')}
            </p>
        </div>
    {/if}

    <!-- ── Summary Strip ───────────────────────────────────────── -->
    <div
        class="bg-surface-800/50 border border-surface-700 rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
        <!-- Sessions -->
        <div class="flex items-center gap-1.5">
            <Icon src={PlayCircle} class="w-4 h-4 text-yellow-400" />
            <span class="text-caption">{m.admin_quality_sessions()}</span>
            <span class="font-medium text-white"
                >{sessionsLoading || sessionsError ? '—' : sessions.length}</span>
        </div>

        {#if isStandalone}
            <div class="flex items-center gap-1.5">
                <Icon src={Signal} class="w-4 h-4 text-purple-400" />
                <span class="text-surface-400">LiveTV</span>
                <span class="font-medium text-white"
                    >{proxyStatus && !liveTvError ? liveTvViewerCount : '—'}</span>
            </div>
        {/if}

        {#if hasFFmpeg}
            <div
                class="flex items-center gap-1.5"
                title={encodingMode
                    ? m.admin_sessions_encoder_tooltip({ mode: encodingMode })
                    : undefined}>
                <Icon
                    src={Cog}
                    class="w-4 h-4 text-violet-400 {runningJobCount > 0 ? 'animate-spin' : ''}" />
                <span class="text-surface-400">FFmpeg</span>
                <span class="font-medium text-white"
                    >{ffmpegJobsData && !jobsError ? activeJobCount : '—'}</span>
            </div>

            {#if erroredJobs.length > 0}
                <div class="flex items-center gap-1.5">
                    <Icon src={ExclamationTriangle} class="w-4 h-4 text-red-400" />
                    <span class="font-medium text-red-400"
                        >{m.admin_sessions_error_count({ count: erroredJobs.length })}</span>
                </div>
            {/if}

            {#if throughput?.ffmpegAggregate && runningJobCount > 0}
                <div class="flex items-center gap-2 text-xs">
                    <span class="text-surface-500">{m.admin_sessions_cpu()}</span>
                    <span
                        class={throughput.ffmpegAggregate.totalCpuPercent > 80
                            ? 'text-red-400'
                            : throughput.ffmpegAggregate.totalCpuPercent > 50
                              ? 'text-yellow-400'
                              : 'text-violet-400'}>
                        {throughput.ffmpegAggregate.totalCpuPercent}%
                    </span>
                    <span class="text-surface-500">{m.admin_sessions_ram()}</span>
                    <span class="text-violet-400"
                        >{throughput.ffmpegAggregate.totalMemoryMB} MB</span>
                </div>
            {/if}
        {/if}

        <!-- CPU, memory and GPU live per host on the cluster view, not here: this page
             is answered by one random web replica, not the machine that transcodes. -->
        <a
            href={resolve('/admin/system/health?tab=cluster')}
            class="ml-auto flex items-center gap-1.5 text-xs text-primary-300 hover:text-primary-200"
            title={m.admin_sessions_system_load_hint()}
            data-testid="sessions-system-load-link">
            <Icon src={ChartBar} class="w-4 h-4" />
            {m.admin_sessions_system_load_link()} →
        </a>
    </div>

    <!-- ── Active Play Sessions ────────────────────────────────── -->
    <ActivePlaySessionsPanel
        sessions={sortedSessions}
        loading={sessionsLoading}
        loadError={sessionsError}
        urlFilters
        {proxyStatus}
        {liveTvError}
        {isStandalone}
        {jobsBySession}
        segmentDurationSec={ffmpegJobsData?.config?.segmentDuration}
        {killingSessionId}
        {killingChannelId}
        {stoppingJobId}
        onKillSession={killSession}
        onKillChannel={killLiveTvChannel}
        onStopJob={stopFFmpegJob}
        messageUsersHref="/admin/notifications" />

    <!-- ── Untracked Jellyfin Sessions ─────────────────────────── -->
    {#if untrackedJellyfinSessions.length > 0}
        <div class="bg-surface-800/50 border border-amber-700/40 rounded-lg p-4">
            <h3
                class="text-sm font-medium text-amber-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Icon src={ExclamationTriangle} class="w-4 h-4" />
                {m.admin_sessions_untracked_title({ count: untrackedJellyfinSessions.length })}
                <span class="normal-case text-surface-400 font-normal text-xs">
                    {m.admin_sessions_untracked_subtitle()}
                </span>
            </h3>
            <div class="divide-y divide-surface-700">
                {#each untrackedJellyfinSessions as s (s.jellyfinSessionId)}
                    <div class="py-2.5 flex items-center gap-3 text-sm">
                        <Icon src={User} class="w-4 h-4 text-surface-400 shrink-0" />
                        <span class="font-medium text-white">{s.username}</span>
                        {#if s.title}
                            <span class="text-surface-400">·</span>
                            <span class="text-surface-300 truncate">{s.title}</span>
                        {/if}
                        {#if s.clientname}
                            <span class="text-surface-500 text-xs ml-auto shrink-0"
                                >{s.clientname}</span>
                        {/if}
                        <span
                            class="shrink-0 px-1.5 py-0.5 rounded text-xs font-medium {s.skipReason ===
                            'no_user_match'
                                ? 'bg-red-900/50 text-red-300'
                                : 'bg-yellow-900/50 text-yellow-300'}">
                            {s.skipReason === 'no_user_match'
                                ? m.admin_sessions_no_lumastra_user()
                                : m.admin_sessions_media_not_in_library()}
                        </span>
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- ── Stream throughput ───────────────────────────────────── -->
    <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <!-- Tracked Stream Throughput (was "Media Bandwidth") -->
        <StatCard
            icon={Signal}
            color="orange"
            title={m.admin_sessions_stream_throughput()}
            tooltip={m.admin_sessions_stream_throughput_tooltip()}
            loading={!throughput}>
            {#snippet value_snippet()}
                {#if throughput?.mediaBandwidth}
                    <p class="text-2xl font-bold text-orange-400">
                        {throughput.mediaBandwidth.totalMbps.toFixed(1)} Mbps
                    </p>
                    <div class="space-y-1 mt-2">
                        {#if throughput.mediaBandwidth.hlsSegmentsMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-caption">HLS:</span>
                                <span class="text-xs font-medium text-violet-400"
                                    >{throughput.mediaBandwidth.hlsSegmentsMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.directPlayMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-surface-500">{m.admin_sessions_direct()}</span>
                                <span class="text-xs font-medium text-emerald-400"
                                    >{throughput.mediaBandwidth.directPlayMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.liveTVMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-surface-500">{m.admin_sessions_livetv()}</span>
                                <span class="text-xs font-medium text-amber-400"
                                    >{throughput.mediaBandwidth.liveTVMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.proxiedStreamsMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-caption">Proxied:</span>
                                <span class="text-xs font-medium text-blue-400"
                                    >{throughput.mediaBandwidth.proxiedStreamsMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.imagesMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-surface-500">{m.admin_sessions_images()}</span>
                                <span class="text-xs font-medium text-pink-400"
                                    >{throughput.mediaBandwidth.imagesMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.subtitlesMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-caption">Subtitles:</span>
                                <span class="text-xs font-medium text-slate-400"
                                    >{throughput.mediaBandwidth.subtitlesMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                        {#if throughput.mediaBandwidth.trickplayMbps > 0}
                            <div class="flex justify-between items-center">
                                <span class="text-caption">Trickplay:</span>
                                <span class="text-xs font-medium text-purple-400"
                                    >{throughput.mediaBandwidth.trickplayMbps.toFixed(2)} Mbps</span>
                            </div>
                        {/if}
                    </div>
                {:else}
                    <p class="text-surface-500 text-sm">
                        {throughput ? m.admin_sessions_no_activity() : m.common_loading()}
                    </p>
                {/if}
            {/snippet}
            {#snippet details()}
                {#if throughput?.mediaBandwidth}
                    <p class="text-caption mt-2">
                        {formatBytes(throughput.mediaBandwidth.totalBytesPerSec)}
                    </p>
                {/if}
            {/snippet}
        </StatCard>
    </div>

    <!-- Media Bandwidth History Chart -->
    {#if throughput?.mediaBandwidth?.history && throughput.mediaBandwidth.history.length > 0}
        <div class="card-gradient-lg">
            <div class="between mb-4">
                <h3 class="text-lg font-bold text-white flex items-center gap-2">
                    <Icon src={Signal} class="w-5 h-5 text-orange-400" />
                    {m.admin_sessions_stream_throughput_history()}
                </h3>
                <span class="text-surface-500">{m.admin_sessions_last_60m()}</span>
            </div>
            <BandwidthChart history={throughput.mediaBandwidth.history} />
            <p class="text-hint mt-2 text-surface-500">
                {m.admin_sessions_chunked_transfers_note()}
            </p>
        </div>
    {/if}

    {#if hasFFmpeg}
        <!-- ── Orphan FFmpeg Jobs (no matching session) ──────────── -->
        {#if orphanJobs.length > 0}
            <div class="bg-surface-800/50 border border-amber-700/30 rounded-xl overflow-hidden">
                <div class="px-4 py-2.5 flex items-center gap-2">
                    <Icon
                        src={Cog}
                        class="w-4 h-4 text-amber-400 {orphanJobs.some((j) => j.processRunning)
                            ? 'animate-spin'
                            : ''}" />
                    <h3 class="text-sm font-medium text-amber-400">
                        {m.admin_sessions_unattached_ffmpeg_jobs()}
                    </h3>
                    <span class="text-xs text-surface-500">
                        {m.admin_sessions_jobs_no_session({ count: orphanJobs.length })}
                    </span>
                </div>
                <div class="border-t border-surface-700/50 px-4 py-2 space-y-1.5">
                    {#each orphanJobs as job (job.jobId)}
                        {@const isError = !!(job.error || job.status === 'error')}
                        <div class="flex items-center gap-3 text-sm py-1.5">
                            <span
                                class="px-1.5 py-0.5 text-[10px] rounded-full font-medium shrink-0
                                    {getStatusColor(
                                    getDisplayStatus(job.status, job.progressPercent),
                                )}
                                    {getStatusBg(
                                    getDisplayStatus(job.status, job.progressPercent),
                                )}">
                                {getDisplayStatus(job.status, job.progressPercent)}
                            </span>
                            <Icon src={User} class="w-3.5 h-3.5 text-surface-400 shrink-0" />
                            <span class="text-white font-medium">{job.username}</span>
                            <span
                                class="px-1.5 py-0.5 text-[10px] rounded bg-violet-900/50 text-violet-400 shrink-0"
                                >{job.mode}</span>
                            {#if job.resolution}
                                <span class="text-[11px] text-surface-400">{job.resolution}</span>
                            {/if}
                            {#if isError && job.error}
                                <span
                                    class="text-[11px] text-red-400 truncate max-w-[200px]"
                                    title={job.error}>{job.error}</span>
                            {/if}
                            <div class="flex-1"></div>
                            <div class="flex items-center gap-1.5 shrink-0">
                                <div class="w-14 h-1.5 bg-surface-700 rounded-full overflow-hidden">
                                    <div
                                        class="h-full rounded-full transition-all {isError
                                            ? 'bg-red-500'
                                            : 'bg-gradient-to-r from-violet-500 to-pink-500'}"
                                        style="width: {job.progressPercent}%">
                                    </div>
                                </div>
                                <span class="text-[11px] text-surface-400 w-8 text-right"
                                    >{job.progressPercent}%</span>
                            </div>
                            <span class="text-[11px] text-surface-500 w-12 text-right"
                                >{formatElapsed(job.elapsedSeconds)}</span>
                            <button
                                class="p-1 rounded text-surface-500 hover:text-red-400 hover:bg-red-900/20 transition-colors shrink-0"
                                onclick={() => stopFFmpegJob(job.playSessionId)}
                                disabled={stoppingJobId === job.playSessionId}
                                title={m.admin_title_stop_this_ffmpeg_job()}>
                                {#if stoppingJobId === job.playSessionId}
                                    <Icon src={ArrowPath} class="w-3.5 h-3.5 animate-spin" />
                                {:else}
                                    <Icon src={Stop} class="w-3.5 h-3.5" />
                                {/if}
                            </button>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- ── FFmpeg Config Summary ──────────────────────────────── -->
        {#if ffmpegJobsData?.config && !ffmpegJobsData.config.enabled}
            <div
                class="bg-surface-800/30 rounded-lg px-4 py-3 text-surface-500 text-sm flex items-center gap-2">
                <Icon src={XCircle} class="w-4 h-4 opacity-50" />
                {m.admin_sessions_hls_unavailable()}
            </div>
        {/if}
    {/if}
</div>
