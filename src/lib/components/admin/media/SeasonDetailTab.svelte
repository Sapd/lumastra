<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ExclamationTriangle } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import SeasonThumbnailAction from './SeasonThumbnailAction.svelte';
    import SeasonHealthPanel from './SeasonHealthPanel.svelte';
    import { setSeriesOrdering } from '$lib/api/admin';
    import * as m from '$lib/paraglide/messages';
    import { z } from 'zod';
    import { apiGet } from '$lib/api/client.js';

    interface Props {
        onsaved?: () => void;
        seasonId: string;
        seriesId: string;
        seasonNumber: number;
    }

    let { seasonId, seriesId, seasonNumber, onsaved }: Props = $props();

    interface SeasonData {
        season: { seasonNumber: number; title: string; seasonId: string };
        localCount: number;
        providerCount: number;
        match: boolean;
        episodesWithChapters: number;
        episodesWithChapterData: Array<{
            episodeNumber: number;
            chapterCount: number;
        }>;
        episodeGroups: Array<{
            groupId: string;
            groupName: string;
            groupType: string;
            episodeCount: number;
            countScore: number;
            structureScore: number;
            chapterScore: number;
            chapterNameMatch: number | null;
        }>;
        missingCount: number;
    }

    let seasonData = $state<SeasonData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let applyingGroupId = $state<string | null>(null);

    /**
     * Describe the shape rather than `z.object({}).passthrough()`, which infers
     * `{[x: string]: unknown}` — that made the `as SeasonData` below an
     * unrelated-types conversion AND meant a malformed response reached the
     * template unchecked. Mirrors the SeasonData interface above.
     */
    const SeasonDataSchema = z.object({
        season: z.object({
            seasonNumber: z.number(),
            title: z.string(),
            seasonId: z.string(),
        }),
        localCount: z.number(),
        providerCount: z.number(),
        match: z.boolean(),
        episodesWithChapters: z.number(),
        episodesWithChapterData: z.array(
            z.object({ episodeNumber: z.number(), chapterCount: z.number() }),
        ),
        episodeGroups: z.array(
            z.object({
                groupId: z.string(),
                groupName: z.string(),
                groupType: z.string(),
                episodeCount: z.number(),
                countScore: z.number(),
                structureScore: z.number(),
                chapterScore: z.number(),
                chapterNameMatch: z.number().nullable(),
            }),
        ),
        missingCount: z.number(),
    });

    async function loadSeasonData(): Promise<void> {
        loading = true;
        error = null;
        const {
            data,
            error: fetchError,
            status,
        } = await apiGet(
            `/api/admin/media/${seriesId}/health/season/${seasonNumber}`,
            SeasonDataSchema,
        );
        loading = false;
        if (fetchError) {
            error = status
                ? m.media_season_load_failed_status({ status })
                : m.media_season_load_failed();
        } else {
            seasonData = data;
        }
    }

    async function applySuggestion(groupId: string): Promise<void> {
        applyingGroupId = groupId;
        try {
            const { data, error } = await setSeriesOrdering(seriesId, {
                orderingType: 'other',
                provider: 'tmdb',
                groupId,
            });
            if (error || !data) {
                toasts.error(m.media_season_ordering_apply_failed());
                return;
            }
            toasts.success(m.media_season_ordering_applied());
            await loadSeasonData();
        } catch {
            toasts.error(m.media_season_ordering_apply_failed());
        } finally {
            applyingGroupId = null;
        }
    }

    // Load on mount
    $effect(() => {
        loadSeasonData();
    });
</script>

<div class="space-y-6">
    <SeasonThumbnailAction {seasonId} {onsaved} />
    <!-- Header -->
    <div>
        <h3 class="text-lg font-semibold text-white">
            {m.media_season_config_heading({ number: seasonNumber })}
        </h3>
        <p class="text-sm text-surface-400 mt-1">
            {m.media_season_config_description()}
        </p>
    </div>

    {#if loading}
        <div class="text-center py-8 text-surface-400">{m.media_season_loading()}</div>
    {:else if error}
        <div class="text-center py-8 text-red-400">
            {error}
            <button class="ml-2 text-primary-400 hover:underline" onclick={loadSeasonData}>
                {m.media_season_retry()}
            </button>
        </div>
    {:else if seasonData}
        <SeasonHealthPanel
            data={seasonData}
            {seasonNumber}
            detailed={true}
            {applyingGroupId}
            onapplygroup={applySuggestion} />

        <!-- No Data State -->
        {#if seasonData.localCount === 0}
            <div class="text-center py-8 text-surface-400 bg-surface-800/30 rounded-lg">
                <Icon src={ExclamationTriangle} class="w-8 h-8 mx-auto mb-2 text-yellow-400" />
                <p>{m.media_season_no_local_episodes()}</p>
                <p class="text-sm mt-1">{m.media_season_check_scanner_config()}</p>
            </div>
        {/if}
    {/if}
</div>
