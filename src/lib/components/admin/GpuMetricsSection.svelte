<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        CheckCircle,
        XCircle,
        CpuChip,
        ExclamationTriangle,
        ArrowPath,
    } from 'svelte-hero-icons';
    import ProgressBar from './ProgressBar.svelte';
    import ActionButton from './ActionButton.svelte';
    import { toasts } from '$lib/stores/toast.store';
    import type { GpuInfo } from '$lib/types/admin-metrics';
    import { getGpuDisplayName } from '$lib/utils/metric-formatters';
    import { getPercentageColor, getPercentageBarColor } from '$lib/utils/metric-styles';
    import { getTranscodeCapabilities, resetTranscodeDecodeCache } from '$lib/api/admin.js';

    interface Props {
        gpu: GpuInfo | undefined;
        loading: boolean;
        /** Active GPU transcode jobs (more accurate than nvidia-smi session count) */
        activeGpuJobs?: number;
    }

    let { gpu, loading, activeGpuJobs }: Props = $props();

    // Local temperature color helpers
    function getTempColor(temp: number): string {
        if (temp >= 85) return 'text-red-400';
        if (temp >= 70) return 'text-yellow-400';
        return 'text-green-400';
    }

    function getTempBarColor(temp: number): string {
        if (temp >= 85) return 'bg-red-500';
        if (temp >= 70) return 'bg-yellow-500';
        return 'bg-green-500';
    }

    // Determine if this is an Intel/VAAPI GPU (has utilization field) vs NVIDIA
    let isIntel = $derived(gpu?.utilization !== undefined && gpu?.encoderUtilization === undefined);
    let isNvidia = $derived(
        gpu?.encoderUtilization !== undefined || gpu?.decoderUtilization !== undefined,
    );

    // Grid class based on GPU type
    let gridClass = $derived(
        isNvidia
            ? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3'
            : 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3',
    );

    // Status dot color
    let statusDotClass = $derived(gpu?.accessible ? 'bg-green-500' : 'bg-red-500');

    let statusText = $derived(
        !gpu
            ? 'Loading...'
            : gpu.configured === 'none'
              ? 'Not configured'
              : gpu.accessible
                ? 'Operational'
                : 'Error',
    );

    let statusTextClass = $derived(
        !gpu || gpu.configured === 'none'
            ? 'text-surface-400'
            : gpu.accessible
              ? 'text-green-400'
              : 'text-red-400',
    );

    // Troubleshooting hints per GPU type
    let troubleshootingHints = $derived.by(() => {
        if (!gpu) return [];
        switch (gpu.configured) {
            case 'nvenc':
                return [
                    'Ensure NVIDIA drivers are installed on the host',
                    'For Docker: add --gpus all or --device /dev/nvidia0',
                    'Check nvidia-docker runtime is configured',
                    'Verify user has access to /dev/nvidia* devices',
                ];
            case 'qsv':
                return [
                    'Check /dev/dri/renderD128 exists on the host',
                    'For Docker: map --device /dev/dri:/dev/dri',
                    'Ensure intel-media-driver or libva-intel-driver is installed',
                    'Verify group membership: adduser <user> render video',
                ];
            case 'vaapi':
                return [
                    'Check VA-API drivers are installed (libva-drm2)',
                    'Verify /dev/dri/renderD128 is accessible',
                    'For Docker: map --device /dev/dri:/dev/dri',
                    'Run vainfo to confirm driver is working',
                ];
            default:
                return [
                    'Check GPU device is accessible inside the container',
                    'Review server logs for FFmpeg probe output',
                ];
        }
    });

    // ── Learned GPU decode-capability cache (learn-on-failure) ──────────────
    // The VA-API family (QSV / VA-API) can't hardware-decode every source codec
    // (e.g. MPEG-4 ASP / VC-1 on Arc). When a transcode proves a codec
    // undecodable, the server records it and software-decodes that codec
    // thereafter. This lets an admin inspect and reset that learned set after a
    // GPU/driver change. Only shown for backends that use the bridge.
    interface LearnedDecodeEntry {
        codec: string;
        bitDepth?: number;
        learnedAt: string;
        sample?: string;
        /** Server-worded description of which sources this entry diverts. */
        scope?: string;
        /** Server-worded cause of the entry. */
        reason?: string;
        /** ISO instant the entry stops being enforced. */
        expiresAt?: string;
    }

    // Codec/depth combinations denied statically (e.g. Hi10P) — bridged from
    // the first playback, so they never show up as "learned".
    interface StaticSoftwareDecodeEntry {
        codec: string;
        bitDepths: string;
        reason: string;
    }

    let resettingDecodeCache = $state(false);
    let learnedEntries = $state<LearnedDecodeEntry[] | null>(null);
    let staticSoftwareDecoded = $state<StaticSoftwareDecodeEntry[]>([]);
    let hwDecodableCodecs = $state<string[]>([]);
    let hdrTonemap = $state<string>('');
    let decodeLoaded = false;
    let showDecodeCache = $derived(
        gpu?.configured === 'qsv' || gpu?.configured === 'vaapi' || gpu?.configured === 'nvenc',
    );

    function applySnapshot(data: {
        hdrTonemap?: string;
        hardwareDecodableCodecs?: string[];
        learned?: LearnedDecodeEntry[];
        staticSoftwareDecoded?: StaticSoftwareDecodeEntry[];
        message?: string;
    }): void {
        learnedEntries = (data.learned ?? []).filter((e): e is LearnedDecodeEntry => !!e.codec);
        staticSoftwareDecoded = data.staticSoftwareDecoded ?? [];
        hwDecodableCodecs = data.hardwareDecodableCodecs ?? [];
        hdrTonemap = data.hdrTonemap ?? '';
    }

    function formatLearnedAt(iso: string): string {
        if (!iso) return 'unknown';
        const t = Date.parse(iso);
        if (Number.isNaN(t) || t <= 0) return 'unknown';
        return new Date(t).toLocaleString();
    }

    /** "in 12 days" / "today" for the TTL column; '' when the date is unusable. */
    function formatExpiry(iso: string | undefined): string {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return '';
        const days = Math.round((t - Date.now()) / 86_400_000);
        if (days < 0) return 'expired';
        if (days === 0) return 'expires today';
        return `expires in ${days} day${days === 1 ? '' : 's'}`;
    }

    async function loadLearnedDecode(): Promise<void> {
        try {
            const { data, error } = await getTranscodeCapabilities();
            if (!error && data) applySnapshot(data);
        } catch {
            // Non-critical: the reset still works without the current snapshot.
        }
    }

    async function resetDecodeCache(): Promise<void> {
        resettingDecodeCache = true;
        try {
            const { data, error } = await resetTranscodeDecodeCache();
            if (!error && data) {
                applySnapshot(data);
                toasts.success(data.message ?? 'GPU decode cache reset');
            } else {
                toasts.error(error ?? 'Failed to reset GPU decode cache');
            }
        } catch {
            toasts.error('Failed to reset GPU decode cache');
        } finally {
            resettingDecodeCache = false;
        }
    }

    $effect(() => {
        if (showDecodeCache && !decodeLoaded) {
            decodeLoaded = true;
            void loadLearnedDecode();
        }
    });
</script>

<div class="card-gradient-lg">
    {#if loading && !gpu}
        <!-- Loading state -->
        <p class="text-surface-500">{m.loading()}</p>
    {:else if gpu?.configured === 'none'}
        <!-- CPU-only mode -->
        <div class="flex items-center gap-3">
            <div class="p-2 bg-surface-500/20 rounded-lg">
                <Icon src={CpuChip} class="w-5 h-5 text-surface-400" />
            </div>
            <div>
                <h3 class="text-base font-semibold text-white">Software Encoding</h3>
                <p class="text-caption">CPU-only, no GPU acceleration configured</p>
            </div>
        </div>
        {#if gpu.advisory}
            <div
                class="mt-3 rounded-lg border border-amber-700/60 bg-amber-900/20 p-3 text-sm text-amber-200"
                role="note">
                {gpu.advisory}
            </div>
        {/if}
    {:else if gpu}
        <!-- Header row -->
        <div class="flex items-center justify-between mb-4">
            <!-- Left: icon + name + subtitle -->
            <div class="flex items-center gap-3">
                <div class="p-2 {gpu.accessible ? 'bg-green-500/20' : 'bg-red-500/20'} rounded-lg">
                    {#if gpu.accessible}
                        <Icon src={CheckCircle} class="w-5 h-5 text-green-400" />
                    {:else}
                        <Icon src={XCircle} class="w-5 h-5 text-red-400" />
                    {/if}
                </div>
                <div>
                    <h3 class="text-base font-semibold text-white">
                        {gpu.name ?? getGpuDisplayName(gpu.configured)}
                    </h3>
                    <p class="text-caption">
                        {getGpuDisplayName(gpu.configured)}
                        {#if gpu.driver}&nbsp;· Driver {gpu.driver}{/if}
                        {#if gpu.pstate}&nbsp;· {gpu.pstate}{/if}
                    </p>
                </div>
            </div>

            <!-- Right: status dot + text -->
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full {statusDotClass}"></span>
                <span class="text-sm {statusTextClass}">{statusText}</span>
            </div>
        </div>

        {#if gpu.capabilities && gpu.capabilities.length > 0}
            <div class="flex flex-wrap gap-1.5 mb-4">
                {#each gpu.capabilities as cap (cap)}
                    <span
                        class="px-2 py-0.5 text-[10px] font-medium rounded-full
                        {cap.includes('Tonemapping')
                            ? 'bg-violet-500/20 text-violet-300'
                            : cap.includes('NVENC') || cap.includes('Encode')
                              ? 'bg-green-500/20 text-green-300'
                              : cap.includes('NVDEC') || cap.includes('Decode')
                                ? 'bg-blue-500/20 text-blue-300'
                                : cap.includes('Scaling')
                                  ? 'bg-cyan-500/20 text-cyan-300'
                                  : 'bg-surface-500/20 text-surface-300'}">
                        {cap}
                    </span>
                {/each}
            </div>
        {/if}

        {#if gpu.accessible}
            <!-- Metric tiles grid -->
            <div class={gridClass}>
                <!-- NVIDIA: Encoder -->
                {#if gpu.encoderUtilization !== undefined}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            Encoder
                        </div>
                        <p class="text-xl font-bold {getPercentageColor(gpu.encoderUtilization)}">
                            {gpu.encoderUtilization}<span class="text-sm text-surface-500">%</span>
                        </p>
                        <ProgressBar
                            percent={gpu.encoderUtilization}
                            color={getPercentageBarColor(gpu.encoderUtilization)} />
                        <p class="text-[10px] text-surface-600 mt-1">
                            {#if gpu.encodeFps}{gpu.encodeFps} fps{/if}{#if gpu.encodeLatencyUs}
                                · {(gpu.encodeLatencyUs / 1000).toFixed(1)}ms{/if}
                        </p>
                    </div>
                {/if}

                <!-- NVIDIA: Decoder -->
                {#if gpu.decoderUtilization !== undefined}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            Decoder
                        </div>
                        <p class="text-xl font-bold {getPercentageColor(gpu.decoderUtilization)}">
                            {gpu.decoderUtilization}<span class="text-sm text-surface-500">%</span>
                        </p>
                        <ProgressBar
                            percent={gpu.decoderUtilization}
                            color={getPercentageBarColor(gpu.decoderUtilization)} />
                        <p class="text-[10px] text-surface-600 mt-1">Hardware decode</p>
                    </div>
                {/if}

                <!-- NVIDIA: VRAM -->
                {#if gpu.vramTotalMB !== undefined && gpu.vramUsedMB !== undefined}
                    {@const vramPct = Math.round((gpu.vramUsedMB / gpu.vramTotalMB) * 100)}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            VRAM
                        </div>
                        <p class="text-xl font-bold {getPercentageColor(vramPct, 90, 75)}">
                            {vramPct}<span class="text-sm text-surface-500">%</span>
                        </p>
                        <ProgressBar
                            percent={vramPct}
                            color={getPercentageBarColor(vramPct, 90, 75)} />
                        <p class="text-[10px] text-surface-600 mt-1">
                            {gpu.vramUsedMB} / {gpu.vramTotalMB} MB
                        </p>
                    </div>
                {/if}

                <!-- Sessions (uses active FFmpeg jobs, not stale nvidia-smi counter) -->
                {#if gpu.maxEncodeSessions !== undefined}
                    {@const sessions = activeGpuJobs ?? 0}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            {m.sessions()}
                        </div>
                        <p class="text-xl font-bold text-yellow-400">
                            {sessions}<span class="text-sm text-surface-500">
                                {#if gpu.maxEncodeSessions === 0}
                                    / ∞
                                {:else}
                                    / {gpu.maxEncodeSessions}
                                {/if}
                            </span>
                        </p>
                        {#if gpu.maxEncodeSessions > 0}
                            <ProgressBar
                                percent={(sessions / gpu.maxEncodeSessions) * 100}
                                color={sessions >= gpu.maxEncodeSessions
                                    ? 'bg-red-500'
                                    : 'bg-yellow-500'} />
                        {/if}
                        <p class="text-[10px] text-surface-600 mt-1">
                            {gpu.maxEncodeSessions === 0 ? 'Unlimited' : 'NVENC limit'}
                        </p>
                    </div>
                {/if}

                <!-- NVIDIA: Temperature -->
                {#if gpu.temperatureC !== undefined}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            Temperature
                        </div>
                        <p class="text-xl font-bold {getTempColor(gpu.temperatureC)}">
                            {gpu.temperatureC}<span class="text-sm text-surface-500">°C</span>
                        </p>
                        <ProgressBar
                            percent={Math.min((gpu.temperatureC / 100) * 100, 100)}
                            color={getTempBarColor(gpu.temperatureC)} />
                        <p class="text-[10px] text-surface-600 mt-1">
                            {gpu.temperatureC >= 85
                                ? 'Critical'
                                : gpu.temperatureC >= 70
                                  ? 'Warm'
                                  : 'Normal'}
                        </p>
                    </div>
                {/if}

                <!-- NVIDIA: Power -->
                {#if gpu.powerDrawW !== undefined}
                    {@const powerPct = gpu.powerLimitW
                        ? Math.round((gpu.powerDrawW / gpu.powerLimitW) * 100)
                        : 0}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            Power
                        </div>
                        <p class="text-xl font-bold text-blue-400">
                            {gpu.powerDrawW.toFixed(0)}<span class="text-sm text-surface-500"
                                >W</span>
                        </p>
                        {#if gpu.powerLimitW}
                            <ProgressBar
                                percent={powerPct}
                                color={getPercentageBarColor(powerPct)} />
                            <p class="text-[10px] text-surface-600 mt-1">
                                Limit: {gpu.powerLimitW}W
                            </p>
                        {:else}
                            <div class="mt-2 w-full h-2 bg-surface-700 rounded-full"></div>
                            <p class="text-[10px] text-surface-600 mt-1">No limit data</p>
                        {/if}
                    </div>
                {/if}

                <!-- Intel/VAAPI: GPU Busy -->
                {#if isIntel && gpu.utilization}
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            {m.admin_cluster_gpu_awake()}
                        </div>
                        <p class="text-xl font-bold text-surface-200">
                            {gpu.utilization.busy.toFixed(1)}<span class="text-sm text-surface-500"
                                >%</span>
                        </p>
                        <ProgressBar percent={gpu.utilization.busy} color="bg-violet-400" />
                        <p class="text-[10px] text-surface-500 mt-1">
                            {m.admin_health_gpu_awake_explanation()}
                        </p>
                    </div>

                    <!-- Intel/VAAPI: Frequency -->
                    <div class="bg-[#181825] rounded-lg p-3">
                        <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                            Frequency
                        </div>
                        <p class="text-xl font-bold text-blue-400">
                            {gpu.utilization.freqMhz}<span class="text-sm text-surface-500"
                                >MHz</span>
                        </p>
                        <ProgressBar percent={gpu.utilization.freqPercent} color="bg-blue-500" />
                        <p class="text-[10px] text-surface-600 mt-1">
                            Max: {gpu.utilization.freqMaxMhz} MHz
                        </p>
                    </div>

                    <!-- Intel/VAAPI: Power (if available) -->
                    {#if gpu.utilization.powerWatts !== undefined}
                        <div class="bg-[#181825] rounded-lg p-3">
                            <div class="text-[10px] text-surface-500 uppercase tracking-wider mb-1">
                                Power
                            </div>
                            <p class="text-xl font-bold text-blue-400">
                                {gpu.utilization.powerWatts.toFixed(0)}<span
                                    class="text-sm text-surface-500">W</span>
                            </p>
                            <div class="mt-2 w-full h-2 bg-surface-700 rounded-full"></div>
                            <p class="text-[10px] text-surface-600 mt-1">Current draw</p>
                        </div>
                    {/if}
                {/if}
            </div>
        {:else}
            <!-- GPU not accessible — error state -->
            <div class="section-error mt-2">
                <div class="flex items-start gap-3">
                    <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                    <div class="flex-1 min-w-0">
                        <p class="text-sm font-semibold text-red-300 mb-1">
                            GPU Acceleration Error
                        </p>
                        {#if gpu.error}
                            <p class="text-caption mb-3">{gpu.error}</p>
                        {/if}

                        <!-- Troubleshooting hints -->
                        {#if troubleshootingHints.length > 0}
                            <p class="text-xs text-surface-400 font-medium mb-1">
                                Troubleshooting:
                            </p>
                            <ul class="space-y-1 mb-3">
                                {#each troubleshootingHints as hint, i (i)}
                                    <li class="text-caption flex items-start gap-1.5">
                                        <span class="text-surface-600 shrink-0">·</span>
                                        {hint}
                                    </li>
                                {/each}
                            </ul>
                        {/if}

                        <!-- Collapsible FFmpeg test output -->
                        {#if gpu.testOutput}
                            <details class="text-xs">
                                <summary
                                    class="cursor-pointer text-surface-400 hover:text-surface-300 select-none">
                                    FFmpeg test output
                                </summary>
                                <pre
                                    class="mt-2 p-2 bg-surface-900/70 rounded text-surface-500 text-[10px] overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">{gpu.testOutput}</pre>
                            </details>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}

        {#if showDecodeCache}
            <!-- Learned GPU decode-capability cache (learn-on-failure) -->
            <div class="mt-4 rounded-lg border border-surface-700/60 bg-[#181825] p-3">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0">
                        <p class="text-sm font-medium text-surface-200">Decode fallbacks</p>
                        <p class="text-[11px] text-surface-500 mt-0.5">
                            A source the GPU can't hardware-decode is recorded after two consecutive
                            failures, then software-decoded and uploaded to the GPU for encoding.
                            Lessons are scoped by codec <em>and</em> bit depth, and expire after 30 days
                            so a GPU or driver change re-verifies itself.
                        </p>
                    </div>
                    <div class="shrink-0">
                        <ActionButton
                            variant="secondary"
                            size="sm"
                            loading={resettingDecodeCache}
                            loadingText="Resetting…"
                            disabled={learnedEntries !== null && learnedEntries.length === 0}
                            onclick={resetDecodeCache}>
                            <Icon src={ArrowPath} class="w-3 h-3" />
                            Reset decode cache
                        </ActionButton>
                    </div>
                </div>

                <!-- Hardware-decodable whitelist (context) -->
                {#if hwDecodableCodecs.length > 0}
                    <div class="mt-3 flex flex-wrap items-center gap-1.5">
                        <span class="text-[10px] uppercase tracking-wider text-surface-500"
                            >Hardware-decoded</span>
                        {#each hwDecodableCodecs as codec (codec)}
                            <span
                                class="px-2 py-0.5 text-[10px] font-medium rounded-full bg-green-500/15 text-green-300">
                                {codec}
                            </span>
                        {/each}
                    </div>
                {/if}

                <!-- Statically software-decoded combinations (never learned) -->
                {#if staticSoftwareDecoded.length > 0}
                    <div class="mt-2 flex flex-wrap items-center gap-1.5">
                        <span class="text-[10px] uppercase tracking-wider text-surface-500"
                            >Software-decoded (built-in)</span>
                        {#each staticSoftwareDecoded as entry (entry.codec + entry.bitDepths)}
                            <span
                                class="px-2 py-0.5 text-[10px] font-medium rounded-full bg-blue-500/15 text-blue-300"
                                title={entry.reason}>
                                {entry.codec} · {entry.bitDepths}
                            </span>
                            <span class="text-[10px] text-surface-500">{entry.reason}</span>
                        {/each}
                    </div>
                {/if}

                <!-- HDR → SDR tone-mapping mode -->
                {#if hdrTonemap === 'hardware' || hdrTonemap === 'software'}
                    <div class="mt-2 flex items-center gap-1.5">
                        <span class="text-[10px] uppercase tracking-wider text-surface-500"
                            >HDR tone-mapping</span>
                        <span
                            class="px-2 py-0.5 text-[10px] font-medium rounded-full {hdrTonemap ===
                            'hardware'
                                ? 'bg-green-500/15 text-green-300'
                                : 'bg-blue-500/15 text-blue-300'}">
                            {hdrTonemap === 'hardware' ? 'Hardware (GPU VPP)' : 'Software (CPU)'}
                        </span>
                    </div>
                {/if}

                <!-- Learned-undecodable details -->
                <div class="mt-3">
                    {#if learnedEntries === null}
                        <p class="text-[11px] text-surface-500">Loading…</p>
                    {:else if learnedEntries.length === 0}
                        <p class="text-[11px] text-surface-500">
                            Nothing learned yet — every source uses hardware decode where this GPU
                            supports it.
                        </p>
                    {:else}
                        <div class="flex items-center gap-1.5 mb-1.5">
                            <span class="text-[10px] uppercase tracking-wider text-surface-500"
                                >Software-decoded (learned)</span>
                            <span
                                class="px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-500/15 text-amber-300">
                                {learnedEntries.length}
                            </span>
                        </div>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-[11px]">
                                <thead class="text-surface-500">
                                    <tr class="border-b border-surface-700/60">
                                        <th class="font-medium py-1 pr-3">Codec</th>
                                        <th class="font-medium py-1 pr-3">Applies to</th>
                                        <th class="font-medium py-1 pr-3 whitespace-nowrap"
                                            >Learned at</th>
                                        <th class="font-medium py-1">Example source</th>
                                    </tr>
                                </thead>
                                <tbody class="text-surface-300">
                                    {#each learnedEntries as entry (entry.codec + (entry.bitDepth ?? ''))}
                                        <tr class="border-b border-surface-800/60 last:border-0">
                                            <td
                                                class="py-1 pr-3 font-mono text-amber-300 whitespace-nowrap align-top">
                                                {entry.codec}{#if entry.bitDepth}<span
                                                        class="text-surface-500">
                                                        · {entry.bitDepth}-bit</span
                                                    >{/if}
                                            </td>
                                            <td class="py-1 pr-3 text-surface-400 align-top">
                                                {entry.scope ?? '—'}
                                            </td>
                                            <td
                                                class="py-1 pr-3 whitespace-nowrap text-surface-400 align-top">
                                                {formatLearnedAt(entry.learnedAt)}
                                                {#if formatExpiry(entry.expiresAt)}
                                                    <span class="block text-surface-500"
                                                        >{formatExpiry(entry.expiresAt)}</span>
                                                {/if}
                                            </td>
                                            <td class="py-1 text-surface-400 break-all align-top">
                                                {entry.sample ?? '—'}
                                            </td>
                                        </tr>
                                    {/each}
                                </tbody>
                            </table>
                        </div>
                        {#if learnedEntries[0]?.reason}
                            <p class="mt-2 text-[11px] text-surface-500">
                                <span class="text-surface-400">Why these are here:</span>
                                {learnedEntries[0].reason}
                            </p>
                        {/if}
                    {/if}
                </div>
            </div>
        {/if}
    {:else}
        <!-- Fallback: no data yet -->
        <p class="text-surface-500">{m.loading()}</p>
    {/if}
</div>
