<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Plugin widgets on the media detail surface.

  Mounted at the end of the detail body, below the built-in metadata, so a
  plugin adds to the page rather than competing with it for the top.

  The detail view RE-TARGETS in place — clicking a similar title swaps the item
  without closing — so every slot is keyed on the item id and remounts when it
  changes. That is deliberate: a plugin never has to diff an item, and the
  contract stays "every mount is a fresh item" instead of growing an update
  path authors would get wrong.
-->
<script lang="ts">
    import PluginWidgetSlot from './PluginWidgetSlot.svelte';

    interface DetailItem {
        id: string;
        mediaType: string;
        title: string;
        year: number | null;
        externalIds: { tmdb?: string; imdb?: string; tvdb?: string };
    }

    interface WidgetMeta {
        id: string;
        featureId: string;
        widgetId: string;
        title: string;
        entry: string;
        placement: string;
        forMediaTypes?: string[];
        minHeightPx?: number;
        chrome?: boolean;
    }

    interface Props {
        widgets: WidgetMeta[];
        item: DetailItem | null;
        /**
         * The viewer, in the SDK's `PluginUser` shape. Built once in the root
         * layout load — `userId` is the stable key a plugin stores against,
         * `username` is a mutable display handle.
         */
        user: { userId: string; username: string; groups: string[]; isAdmin: boolean } | null;
    }

    let { widgets, item, user }: Props = $props();

    // Allowlist on placement — never "everything except". A denylist admits
    // each newly-invented placement into whichever surface used it.
    let detailWidgets = $derived(
        item
            ? widgets.filter(
                  (w) =>
                      w.placement === 'detail' &&
                      (!w.forMediaTypes?.length || w.forMediaTypes.includes(item.mediaType)),
              )
            : [],
    );
</script>

{#if item && detailWidgets.length > 0}
    <div class="plugin-detail-slots">
        {#each detailWidgets as w (w.id)}
            {#key item.id}
                <PluginWidgetSlot
                    widget={{
                        featureId: w.featureId,
                        id: w.id,
                        title: w.title,
                        entry: w.entry,
                    }}
                    {user}
                    chrome={w.chrome ?? true}
                    minHeight={`${w.minHeightPx ?? 120}px`}
                    context={{ surface: 'detail', item }} />
            {/key}
        {/each}
    </div>
{/if}

<style>
    .plugin-detail-slots {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        margin-top: 1rem;
    }
</style>
