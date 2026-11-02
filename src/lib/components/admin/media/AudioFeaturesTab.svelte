<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { Icon, ArrowPath } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { rescanMediaAudioFeatures } from '$lib/api/admin';

    interface AudioFeatures {
        bpm?: number;
        key?: string;
        energy?: number;
        danceability?: number;
        loudness_lufs?: number;
        essentia_analyzed?: boolean;
        mood_tags?: string[];
        sample_rate?: number;
        channels?: number;
        codec?: string;
        bitrate?: number;
    }

    interface Props {
        mediaId: string;
        audioFeatures?: Record<string, unknown>;
    }

    let { mediaId, audioFeatures }: Props = $props();

    function toAudioFeatures(raw: Record<string, unknown> | undefined): AudioFeatures | null {
        if (!raw) return null;
        const ess: Record<string, unknown> =
            raw.essentia && typeof raw.essentia === 'object'
                ? (raw.essentia as Record<string, unknown>)
                : {};
        return {
            bpm: typeof ess.bpm === 'number' ? ess.bpm : undefined,
            key: typeof ess.key === 'string' ? ess.key : undefined,
            energy: typeof ess.energy === 'number' ? ess.energy : undefined,
            danceability: typeof ess.danceability === 'number' ? ess.danceability : undefined,
            loudness_lufs: typeof ess.loudness_lufs === 'number' ? ess.loudness_lufs : undefined,
            essentia_analyzed:
                typeof ess.essentia_analyzed === 'boolean' ? ess.essentia_analyzed : undefined,
            mood_tags: Array.isArray(ess.mood_tags) ? (ess.mood_tags as string[]) : undefined,
            sample_rate: typeof raw.sample_rate === 'number' ? raw.sample_rate : undefined,
            channels: typeof raw.channels === 'number' ? raw.channels : undefined,
            codec: typeof raw.codec === 'string' ? raw.codec : undefined,
            bitrate: typeof raw.bitrate === 'number' ? raw.bitrate : undefined,
        };
    }

    let parsed = $derived(toAudioFeatures(audioFeatures));

    let hasTechnicalInfo = $derived(
        parsed !== null &&
            (parsed.codec !== undefined ||
                parsed.bitrate !== undefined ||
                parsed.sample_rate !== undefined ||
                parsed.channels !== undefined),
    );

    let reanalyzing = $state(false);

    async function handleReanalyze(): Promise<void> {
        reanalyzing = true;
        try {
            const { data, error } = await rescanMediaAudioFeatures(mediaId);
            if (error || !data) {
                toasts.error(m.media_audiofeatures_queue_failed());
            } else {
                toasts.success(m.media_audiofeatures_queue_success());
            }
        } catch {
            toasts.error(m.media_audiofeatures_queue_failed());
        } finally {
            reanalyzing = false;
        }
    }
</script>

<div class="space-y-6">
    <!-- Header -->
    <div class="flex items-center gap-3">
        <h3 class="text-lg font-semibold text-white">{m.media_audiofeatures_heading()}</h3>
        {#if parsed?.essentia_analyzed}
            <span
                class="px-2 py-0.5 text-xs rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                {m.media_audiofeatures_essentia_analyzed()}
            </span>
        {:else}
            <span
                class="px-2 py-0.5 text-xs rounded-full bg-surface-700/60 text-surface-400 border border-surface-600/30">
                {m.media_audiofeatures_not_analyzed()}
            </span>
        {/if}
    </div>

    {#if parsed}
        <!-- Metric cards grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {#if parsed.bpm !== undefined}
                <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                    <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                        {m.media_audiofeatures_bpm()}
                    </div>
                    <div class="text-surface-100 text-lg font-semibold">
                        {parsed.bpm.toFixed(1)}
                    </div>
                </div>
            {/if}

            {#if parsed.key}
                <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                    <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                        {m.media_audiofeatures_key()}
                    </div>
                    <div class="text-surface-100 text-lg font-semibold">
                        {parsed.key}
                    </div>
                </div>
            {/if}

            {#if parsed.energy !== undefined}
                <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                    <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                        {m.media_audiofeatures_energy()}
                    </div>
                    <div class="text-surface-100 text-lg font-semibold">
                        {(parsed.energy * 100).toFixed(0)}%
                    </div>
                    <div class="w-full h-2 bg-surface-700/50 rounded-full overflow-hidden mt-1">
                        <div
                            class="h-full bg-primary-500 rounded-full"
                            style="width: {parsed.energy * 100}%">
                        </div>
                    </div>
                </div>
            {/if}

            {#if parsed.danceability !== undefined}
                <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                    <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                        {m.media_music_danceability_label()}
                    </div>
                    <div class="text-surface-100 text-lg font-semibold">
                        {m.media_music_danceability_score({
                            score: parsed.danceability.toLocaleString(undefined, {
                                maximumFractionDigits: 2,
                            }),
                        })}
                    </div>
                    <div class="w-full h-2 bg-surface-700/50 rounded-full overflow-hidden mt-1">
                        <div
                            class="h-full bg-primary-500 rounded-full"
                            style="width: {(Math.max(0, Math.min(3, parsed.danceability)) / 3) *
                                100}%">
                        </div>
                    </div>
                </div>
            {/if}

            {#if parsed.loudness_lufs !== undefined}
                <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                    <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                        {m.media_audiofeatures_loudness()}
                    </div>
                    <div class="text-surface-100 text-lg font-semibold">
                        {parsed.loudness_lufs.toFixed(1)} LUFS
                    </div>
                </div>
            {/if}
        </div>

        <!-- Mood tags -->
        {#if parsed.mood_tags && parsed.mood_tags.length > 0}
            <div class="space-y-2">
                <div class="text-xs text-surface-500 uppercase tracking-wide font-medium">
                    {m.media_audiofeatures_mood_tags()}
                </div>
                <div class="flex flex-wrap gap-1.5">
                    {#each parsed.mood_tags as tag, tagIdx (tag + '__' + tagIdx)}
                        <span
                            class="px-2 py-0.5 text-xs rounded-full bg-primary-500/15 text-primary-300 border border-primary-500/20">
                            {tag}
                        </span>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Technical info -->
        {#if hasTechnicalInfo}
            <div class="space-y-2">
                <div class="text-xs text-surface-500 uppercase tracking-wide font-medium">
                    {m.media_audiofeatures_technical_info()}
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {#if parsed.codec}
                        <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                                {m.player_tt_codec()}
                            </div>
                            <div class="text-surface-100 text-sm font-semibold">
                                {parsed.codec}
                            </div>
                        </div>
                    {/if}
                    {#if parsed.bitrate !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                                {m.media_audiofeatures_bitrate()}
                            </div>
                            <div class="text-surface-100 text-sm font-semibold">
                                {parsed.bitrate} kbps
                            </div>
                        </div>
                    {/if}
                    {#if parsed.sample_rate !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                                {m.media_audiofeatures_sample_rate()}
                            </div>
                            <div class="text-surface-100 text-sm font-semibold">
                                {parsed.sample_rate} Hz
                            </div>
                        </div>
                    {/if}
                    {#if parsed.channels !== undefined}
                        <div class="bg-surface-800/40 rounded-lg px-4 py-3">
                            <div class="text-xs text-surface-500 uppercase tracking-wide mb-1">
                                {m.tab_channels()}
                            </div>
                            <div class="text-surface-100 text-sm font-semibold">
                                {parsed.channels}
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    {:else}
        <!-- Empty state -->
        <p class="text-sm text-surface-500">
            {m.media_audiofeatures_empty_state()}
        </p>
    {/if}

    <!-- Re-analyze button -->
    <div class="pt-2">
        <button
            class="btn variant-ghost-surface text-sm px-4 py-2 inline-flex items-center gap-2"
            onclick={handleReanalyze}
            disabled={reanalyzing}>
            <Icon src={ArrowPath} class="w-4 h-4" />
            {reanalyzing ? m.media_audiofeatures_analyzing() : m.media_audiofeatures_reanalyze()}
        </button>
    </div>
</div>
