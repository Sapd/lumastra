<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { z } from 'zod';
    import { apiGet } from '$lib/api/client.js';
    import { getSystemMetrics } from '$lib/api/admin.js';
    import type { SystemMetrics } from '$lib/types/admin-metrics';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        savedValues: Record<string, unknown>;
        currentValues: Record<string, unknown>;
        envOverridesSet: ReadonlySet<string>;
        handleChange: (key: string, value: unknown) => void;
    }
    let { savedValues, currentValues, envOverridesSet, handleChange }: Props = $props();

    const DetectionSchema = z.object({
        hostname: z.string().optional(),
        ffmpegReady: z.boolean(),
        recommended: z.enum(['nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox']).nullable(),
        recommendedVendor: z.string().nullable().optional(),
        candidates: z
            .array(
                z.object({
                    accel: z.string(),
                    encoder: z.string(),
                    vendor: z.string(),
                    works: z.boolean(),
                }),
            )
            .optional(),
        inContainer: z.boolean().optional(),
        driPresent: z.boolean().optional(),
    });
    let metrics = $state<SystemMetrics | null>(null);
    let receivedAt = $state<Date | null>(null);
    let refreshing = $state(false);
    let refreshFailed = $state(false);
    let detecting = $state(false);
    let detectionFailed = $state(false);
    let detection = $state<z.infer<typeof DetectionSchema> | null>(null);
    let savedEncoder = $derived(String(savedValues.GPU_ACCELERATION ?? 'none'));
    let pendingEncoder = $derived(String(currentValues.GPU_ACCELERATION ?? 'none'));
    let pending = $derived(
        pendingEncoder !== savedEncoder ||
            currentValues.HW_ENCODING_ENABLED !== savedValues.HW_ENCODING_ENABLED,
    );
    let locked = $derived(envOverridesSet.has('GPU_ACCELERATION'));
    let encodingLocked = $derived(envOverridesSet.has('HW_ENCODING_ENABLED'));
    let recommendationMatches = $derived(
        Boolean(detection?.recommended) &&
            pendingEncoder === detection?.recommended &&
            currentValues.HW_ENCODING_ENABLED === true,
    );
    let canStage = $derived(
        Boolean(detection?.recommended) &&
            !detecting &&
            !recommendationMatches &&
            (!locked || savedEncoder === detection?.recommended) &&
            (!encodingLocked || currentValues.HW_ENCODING_ENABLED === true),
    );
    let unmatched = $derived(Boolean(metrics) && metrics?.gpu.configured !== savedEncoder);

    async function refresh(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        refreshFailed = false;
        try {
            const result = await getSystemMetrics();
            if (result.error || !result.data) refreshFailed = true;
            else {
                metrics = result.data;
                receivedAt = new Date();
            }
        } catch {
            refreshFailed = true;
        } finally {
            refreshing = false;
        }
    }
    async function detect(): Promise<void> {
        if (detecting) return;
        detecting = true;
        detectionFailed = false;
        try {
            const result = await apiGet('/api/setup/gpu-detect', DetectionSchema);
            detectionFailed = Boolean(result.error || !result.data);
            detection = result.data ?? null;
        } catch {
            detectionFailed = true;
            detection = null;
        } finally {
            detecting = false;
        }
    }
    function stageRecommendation(): void {
        if (!detection?.recommended || !canStage) return;
        if (!locked) handleChange('GPU_ACCELERATION', detection.recommended);
        // An environment-owned encoder is never replaced. Enabling encoding
        // still uses that encoder, so make this partial application explicit.
        if (!envOverridesSet.has('HW_ENCODING_ENABLED')) handleChange('HW_ENCODING_ENABLED', true);
    }
    onMount(() => {
        void refresh();
    });
</script>

<section
    class="rounded-xl border border-surface-700 bg-surface-800/40 p-4 space-y-3"
    aria-label={m.admin_hardware_title()}
    data-testid="hardware-status">
    <h2 class="text-lg font-semibold text-white">{m.admin_hardware_title()}</h2>
    <p class="text-sm text-surface-300">{m.admin_hardware_description()}</p>
    <dl class="grid gap-3 text-sm sm:grid-cols-2">
        <div>
            <dt class="text-muted">{m.admin_hardware_saved_encoder()}</dt>
            <dd>{savedEncoder.toUpperCase()}</dd>
        </div>
        <div>
            <dt class="text-muted">{m.admin_hardware_pending_encoder()}</dt>
            <dd>{pendingEncoder.toUpperCase()}</dd>
        </div>
        <div>
            <dt class="text-muted">{m.admin_hardware_encoding()}</dt>
            <dd>
                {currentValues.HW_ENCODING_ENABLED === true
                    ? m.admin_hardware_enabled()
                    : m.admin_hardware_disabled()}
            </dd>
        </div>
        {#if metrics}<div>
                <dt class="text-muted">{m.admin_hardware_detected()}</dt>
                <dd>
                    {metrics.gpu.name ??
                        (metrics.gpu.detected
                            ? m.admin_hardware_device_detected()
                            : metrics.gpu.configured !== 'none'
                              ? m.admin_hardware_probe_failed()
                              : m.admin_hardware_not_checked())}
                </dd>
            </div>{/if}
    </dl>
    {#if pending}<p class="text-sm text-amber-300" data-testid="hardware-pending">
            {m.admin_hardware_pending_notice()}
        </p>{/if}
    {#if locked}<p class="text-sm text-amber-300" data-testid="hardware-env-lock">
            {m.admin_hardware_env_lock()}
        </p>{/if}
    {#if encodingLocked}<p class="text-sm text-amber-300" data-testid="hardware-encoding-lock">
            {m.admin_hardware_encoding_lock()}
        </p>{/if}
    {#if metrics}
        {#if unmatched}<p class="text-sm text-amber-300" data-testid="hardware-unmatched">
                {m.admin_hardware_unmatched()}
            </p>{/if}
        <p class="text-sm" data-testid="hardware-verification">
            {m.admin_hardware_verification({ encoder: metrics.gpu.configured.toUpperCase() })}
            {unmatched
                ? m.admin_hardware_unmatched_result()
                : metrics.gpu.configured === 'none'
                  ? m.admin_hardware_cpu()
                  : metrics.gpu.accessible
                    ? m.admin_hardware_verified()
                    : m.admin_hardware_unverified()}
        </p>
        {#if metrics.gpu.advisory}<p class="text-sm text-amber-300">{metrics.gpu.advisory}</p>{/if}
        {#if metrics.gpu.error}<p class="text-sm text-red-300">{metrics.gpu.error}</p>{/if}
        <p class="text-xs text-muted">
            {m.admin_hardware_replica({
                hostname: metrics.hostname,
                time: receivedAt?.toLocaleString() ?? '',
            })}
        </p>
        <p class="text-xs text-muted">{m.admin_hardware_cached_probe()}</p>
        {#if metrics.ffmpegVersion}<p class="text-xs text-muted">
                FFmpeg {metrics.ffmpegVersion}
            </p>{/if}
    {/if}
    {#if refreshFailed}<p role="alert" class="text-sm text-red-300">
            {m.admin_hardware_refresh_failed()}
        </p>{/if}
    <p class="text-sm text-muted">{m.admin_hardware_direct_play()}</p>
    <div class="flex flex-wrap items-center gap-4 text-sm">
        <button
            type="button"
            class="btn btn-sm btn-surface"
            disabled={refreshing}
            onclick={() => void refresh()}
            >{refreshing ? m.admin_hardware_loading() : m.admin_hardware_refresh()}</button>
        <button
            type="button"
            class="btn btn-sm btn-surface"
            disabled={detecting}
            onclick={() => void detect()}
            >{detecting ? m.admin_hardware_loading() : m.admin_hardware_detect()}</button>
        <a
            class="text-primary-300 underline"
            href={resolve('/admin/system/health?tab=cluster#hardware-encoder-check')}
            >{m.admin_hardware_activity_link()}</a>
    </div>
    {#if detectionFailed}<p role="alert" class="text-sm text-red-300">
            {m.admin_hardware_detection_failed()}
        </p>
    {:else if detection}
        <p class="text-xs text-muted">
            {detection.hostname
                ? m.admin_hardware_detection_source({ hostname: detection.hostname })
                : m.admin_hardware_detection_source_unknown()}
        </p>
        <p class="text-xs text-muted">{m.admin_hardware_detection_scope()}</p>
        {#each detection.candidates ?? [] as candidate (candidate.accel)}
            <p class="text-xs text-muted">
                {candidate.vendor} · {candidate.encoder} · {candidate.works
                    ? m.admin_hardware_verified()
                    : m.admin_hardware_unverified()}
            </p>
        {/each}
        {#if !detection.ffmpegReady}<p class="text-sm text-amber-300">
                {m.admin_hardware_ffmpeg_missing()}
            </p>
        {:else if !detection.recommended}<p class="text-sm text-amber-300">
                {m.admin_hardware_no_candidate()}
            </p>
            {#if detection.inContainer && !detection.driPresent}<p class="text-sm text-muted">
                    {m.admin_hardware_container_hint()}
                </p>{/if}
        {:else}
            <p class="text-sm">
                {m.admin_hardware_recommendation({ encoder: detection.recommended.toUpperCase() })}
            </p>
            {#if detection.recommendedVendor}<p class="text-sm">
                    {detection.recommendedVendor}
                </p>{/if}
            <p class="text-xs text-muted">{m.admin_hardware_stage_help()}</p>
            {#if locked}<p class="text-xs text-amber-300">
                    {m.admin_hardware_partial_stage()}
                </p>{/if}
            <button
                type="button"
                class="btn btn-sm btn-primary"
                disabled={!canStage}
                onclick={stageRecommendation}>{m.admin_hardware_stage()}</button>
            {#if recommendationMatches && pending}<p role="status" class="text-sm text-amber-300">
                    {m.admin_hardware_staged()}
                </p>{:else if recommendationMatches}<p role="status" class="text-sm text-muted">
                    {m.admin_hardware_already_matches()}
                </p>{/if}
        {/if}
    {/if}
</section>
