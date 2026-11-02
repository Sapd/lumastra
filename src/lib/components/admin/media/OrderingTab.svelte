<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import SeriesOrderingPicker from '$lib/components/modal/SeriesOrderingPicker.svelte';
    import { getSeriesHealth } from '$lib/api/admin';
    import * as m from '$lib/paraglide/messages';

    interface GroupScoreInfo {
        groupId: string;
        groupName: string;
        score: number;
        breakdown: string;
    }

    interface Props {
        seriesId: string;
    }

    let { seriesId }: Props = $props();

    let groupScores = $state<GroupScoreInfo[]>([]);

    $effect(() => {
        const _id = seriesId;
        void loadGroupScores();
    });

    async function loadGroupScores(): Promise<void> {
        try {
            const { data } = await getSeriesHealth(seriesId);
            if (data?.report) {
                const scores = data.report.groupScores;
                groupScores = Array.isArray(scores) ? (scores as GroupScoreInfo[]) : [];
            }
        } catch (e) {
            console.warn('[OrderingTab] Failed to load episode group scores', e);
        }
    }
</script>

<div class="space-y-4">
    <div>
        <h3 class="text-lg font-semibold text-white">{m.media_ordering_heading()}</h3>
        <p class="text-sm text-surface-400 mt-1">
            {m.media_ordering_intro()}
        </p>
    </div>

    <SeriesOrderingPicker {seriesId} isAdmin={true} {groupScores} onapply={loadGroupScores} />

    <div
        class="rounded-lg bg-surface-800/40 border border-surface-700/30 px-4 py-3 text-sm text-surface-400 space-y-2">
        <p>
            {m.media_ordering_note_files_safe()}
        </p>
        <p>
            {m.media_ordering_note_overwrite_preserved()}
        </p>
        <p>
            {m.media_ordering_note_file_links()}
        </p>
        <p>
            {m.media_ordering_note_check_health_before()}<strong class="text-surface-200"
                >{m.media_ordering_health_tab_name()}</strong
            >{m.media_ordering_note_check_health_after()}
        </p>
    </div>
</div>
