<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Read-only view of the lineup as viewers and /j clients actually receive it.

  The admin channel list renders every channel row, but only a backup group's
  primary reaches viewers — so a row can show a green "visible" eye and still be
  withheld. This is the ground truth to check that list against; a channel
  missing here is a channel nobody can watch.
-->
<script lang="ts">
    import { apiGet } from '$lib/api/client.js';
    import { ViewerPreviewResponseSchema } from '$lib/schemas/livetv.js';
    import type { ViewerPreviewChannel } from '$lib/schemas/livetv.js';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages.js';

    let channels = $state<ViewerPreviewChannel[]>([]);
    let loading = $state(true);

    async function load(): Promise<void> {
        loading = true;
        const { data, error } = await apiGet(
            '/api/admin/livetv/channels/preview',
            ViewerPreviewResponseSchema,
        );
        if (error) toasts.error(error);
        else if (data) channels = data.channels;
        loading = false;
    }

    $effect(() => {
        void load();
    });

    // The endpoint already returns viewer order (category-blocked), so grouping
    // just inserts headers — it must never re-sort.
    interface PreviewGroup {
        name: string;
        channels: ViewerPreviewChannel[];
    }
    let groups = $derived.by((): PreviewGroup[] => {
        const out: PreviewGroup[] = [];
        for (const channel of channels) {
            const name = channel.categoryName ?? m.admin_livetv_uncategorized();
            const last = out.at(-1);
            if (last && last.name === name) last.channels.push(channel);
            else out.push({ name, channels: [channel] });
        }
        return out;
    });
</script>

<div class="space-y-4">
    <p class="text-sm text-surface-400">
        {m.admin_livetv_viewer_preview_description()}
    </p>

    {#if loading}
        <div class="bg-surface-800 rounded-lg overflow-hidden">
            {#each Array(8) as _, i (i)}
                <div class="px-4 py-3 border-b border-surface-700">
                    <div class="h-5 bg-surface-700 rounded animate-pulse"></div>
                </div>
            {/each}
        </div>
    {:else if channels.length === 0}
        <div class="bg-surface-800 rounded-lg p-8 text-center">
            <p class="text-surface-400">{m.admin_livetv_viewer_preview_empty()}</p>
        </div>
    {:else}
        <p class="text-sm text-surface-400">
            {m.admin_livetv_viewer_preview_count({ count: channels.length })}
        </p>
        <div class="bg-surface-800 rounded-lg overflow-hidden">
            {#each groups as group (group.name)}
                <div
                    class="px-4 py-2 bg-surface-700/50 text-sm font-medium text-surface-200 sticky top-0">
                    {group.name}
                    <span class="text-surface-400 font-normal">({group.channels.length})</span>
                </div>
                {#each group.channels as channel (channel.id)}
                    <div
                        class="flex items-center gap-3 px-4 py-2 border-b border-surface-700/50 text-sm">
                        <span class="w-16 shrink-0 tabular-nums text-surface-400"
                            >{channel.number}</span>
                        <span class="flex-1 truncate text-white">{channel.name}</span>
                        {#if channel.qualityTier}
                            <span class="shrink-0 text-xs text-surface-400 uppercase">
                                {channel.qualityTier}
                            </span>
                        {/if}
                    </div>
                {/each}
            {/each}
        </div>
    {/if}
</div>
