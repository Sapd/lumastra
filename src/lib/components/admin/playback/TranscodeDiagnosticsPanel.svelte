<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { z } from 'zod';
    import { Icon, ArrowPath, CheckCircle, CpuChip, ShieldExclamation } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';
    import { getTranscodeCapabilities, resetTranscodeDecodeCache } from '$lib/api/admin.js';
    import { toasts } from '$lib/stores/toast.store';
    import { resolve } from '$lib/paths';
    import type { TranscodeCapabilitiesResponse } from '$lib/api/admin.js';

    const GpuCandidateSchema = z.object({
        accel: z.enum(['nvenc', 'qsv', 'vaapi']),
        encoder: z.string(),
        vendor: z.string().optional(),
        works: z.boolean(),
    });

    const GpuDetectSchema = z.object({
        ffmpegReady: z.boolean(),
        recommended: z.enum(['nvenc', 'qsv', 'vaapi']).nullable(),
        recommendedVendor: z.string().nullable().optional(),
        candidates: z.array(GpuCandidateSchema),
    });

    type GpuDetectResult = z.infer<typeof GpuDetectSchema>;

    let loading = $state(false);
    let detecting = $state(false);
    let resetting = $state(false);
    let result = $state<TranscodeCapabilitiesResponse | null>(null);
    let detection = $state<GpuDetectResult | null>(null);
    let error = $state<string | null>(null);
    let detectError = $state<string | null>(null);

    async function loadCapabilities(): Promise<void> {
        loading = true;
        error = null;
        const response = await getTranscodeCapabilities();
        loading = false;
        if (response.error || !response.data) {
            error = response.error ?? 'Could not load transcode capabilities.';
            result = null;
            return;
        }
        result = response.data;
    }

    async function detectGpu(): Promise<void> {
        detecting = true;
        detectError = null;
        const response = await apiGet('/api/admin/playback/gpu-detect', GpuDetectSchema, {
            timeout: 30_000,
        });
        detecting = false;
        if (response.error || !response.data) {
            detectError = response.error ?? 'Could not detect hardware transcode support.';
            detection = null;
            return;
        }
        detection = response.data;
    }

    async function resetCache(): Promise<void> {
        resetting = true;
        const response = await resetTranscodeDecodeCache();
        resetting = false;
        if (response.error || !response.data) {
            toasts.error(response.error ?? 'Failed to reset decode cache');
            return;
        }
        result = response.data;
        toasts.success(response.data.message ?? 'Decode cache reset');
    }
</script>

<section class="card-bordered p-4 space-y-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
            <h3 class="text-sm font-semibold text-surface-100">Transcode diagnostics</h3>
            <p class="mt-1 text-xs text-surface-500">
                Checks saved hardware transcode capability and learned decode fallbacks.
            </p>
        </div>
        <div class="flex gap-2">
            <a
                href={resolve('/admin/system/transcode-failures')}
                class="btn btn-secondary btn-sm inline-flex items-center gap-1">
                <Icon src={ShieldExclamation} class="h-4 w-4" />
                <span>Failure reports</span>
            </a>
            <button
                type="button"
                class="btn btn-secondary btn-sm inline-flex items-center gap-1"
                onclick={detectGpu}
                disabled={detecting}>
                <Icon src={ArrowPath} class="h-4 w-4 {detecting ? 'animate-spin' : ''}" />
                <span>Detect GPU</span>
            </button>
            <button
                type="button"
                class="btn btn-secondary btn-sm inline-flex items-center gap-1"
                onclick={loadCapabilities}
                disabled={loading}>
                <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
                <span>Check</span>
            </button>
            <button
                type="button"
                class="btn btn-ghost btn-sm inline-flex items-center gap-1"
                onclick={resetCache}
                disabled={resetting || !result}>
                <Icon src={ArrowPath} class="h-4 w-4 {resetting ? 'animate-spin' : ''}" />
                <span>Reset cache</span>
            </button>
        </div>
    </div>

    {#if detectError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {detectError}
        </div>
    {:else if detection}
        <div class="rounded border border-cyan-800/50 bg-cyan-950/20 px-3 py-2">
            <div class="flex flex-wrap items-center gap-3 text-sm text-surface-200">
                <span
                    >FFmpeg: <span class="font-mono"
                        >{detection.ffmpegReady ? 'ready' : 'missing'}</span
                    ></span>
                <span>Recommended: <span class="font-mono">{detection.recommended}</span></span>
                {#if detection.recommendedVendor}
                    <span
                        >Vendor: <span class="font-mono">{detection.recommendedVendor}</span></span>
                {/if}
            </div>
            {#if detection.candidates.length}
                <div class="mt-2 flex flex-wrap gap-1.5">
                    {#each detection.candidates as candidate (candidate.accel)}
                        <span
                            class={candidate.works
                                ? 'badge-soft-green'
                                : 'inline-flex items-center rounded-full bg-surface-700/60 px-2 py-0.5 text-xs font-medium text-surface-300'}>
                            {candidate.vendor ?? candidate.accel}
                        </span>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    {#if error}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
        </div>
    {:else if result}
        <div class="rounded border border-surface-700/60 bg-surface-900/30 px-3 py-2">
            <div class="flex flex-wrap items-center gap-3 text-sm text-surface-200">
                <span class="inline-flex items-center gap-1.5">
                    <Icon
                        src={result.gpuAcceleration === 'none' ? CpuChip : CheckCircle}
                        class="h-4 w-4 text-cyan-300" />
                    GPU: <span class="font-mono">{result.gpuAcceleration ?? 'unknown'}</span>
                </span>
                {#if result.hdrTonemap}
                    <span>HDR tonemap: <span class="font-mono">{result.hdrTonemap}</span></span>
                {/if}
                <span>
                    Learned fallbacks:
                    <span class="font-mono">{result.learned?.length ?? 0}</span>
                </span>
            </div>
            {#if result.hardwareDecodableCodecs?.length}
                <div class="mt-2 flex flex-wrap gap-1.5">
                    {#each result.hardwareDecodableCodecs as codec (codec)}
                        <span class="badge-soft-cyan">{codec}</span>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
</section>
