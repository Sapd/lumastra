<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { browser } from '$app/environment';
    import * as m from '$lib/paraglide/messages.js';
    import { regenerateEpisodeThumbnails } from '$lib/api/admin.js';
    import { createSubjectRunsTracker, type SubjectRunsTracker } from '$lib/stores/subject-runs.js';
    import { toasts } from '$lib/stores/toast.store';
    import TaskActionButton from './TaskActionButton.svelte';

    let {
        seasonId,
        scope = 'season',
        onsaved,
    }: { seasonId: string; scope?: 'series' | 'season'; onsaved?: () => void } = $props();
    let tracker = $state<SubjectRunsTracker | null>(null);

    $effect(() => {
        const id = seasonId;
        if (!browser) return;
        const current = createSubjectRunsTracker(id, [], ['episode-thumbnail-extract']);
        untrack(() => {
            tracker = current;
        });
        const off = current.onSettled((run) => {
            if (run.taskId !== 'episode-thumbnail-extract') return;
            if (
                run.state === 'completed' &&
                run.result &&
                typeof run.result === 'object' &&
                'success' in run.result &&
                run.result.success === true
            )
                toasts.success(m.media_season_thumbnails_complete());
            else if (run.state === 'completed') toasts.warning(m.media_p5_artwork_uncertain());
            else if (run.state === 'failed') toasts.error(m.media_season_thumbnails_failed());
            onsaved?.();
        });
        return () => {
            off();
            current.destroy();
        };
    });

    async function start(): Promise<{ deduped?: boolean } | null> {
        const { data, error } = await regenerateEpisodeThumbnails(seasonId, {
            scope,
        });
        if (error || !data) {
            toasts.error(error ?? m.media_season_thumbnails_failed());
            return null;
        }
        if (!data.deduped) toasts.success(m.media_season_thumbnails_queued());
        return data;
    }
</script>

<div class="mb-4">
    {#if tracker}
        <TaskActionButton
            taskId="episode-thumbnail-extract"
            label={m.media_p5_rebuild_pictures()}
            {tracker}
            onstart={start} />
    {/if}
</div>
