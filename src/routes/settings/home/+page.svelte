<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/stores';
    import type { PageData } from './$types';
    import HomeWidgetsSection from '$lib/components/settings/HomeWidgetsSection.svelte';
    import FeedSectionsSection from '$lib/components/settings/FeedSectionsSection.svelte';
    import {
        buildHomeWidgetModel,
        resolveWidgetName,
        type WidgetVisibilityData,
    } from '$lib/config/home-widgets';
    import { DEFAULT_FEED_PREFS, type FeedPrefs } from '$lib/shared/feed-section-kinds';

    interface Props {
        data: PageData;
    }
    let { data }: Props = $props();

    // Resolve the permission/admin-filtered widget model from layout data (same
    // inputs the homepage uses). `pluginWidgets` (home-placement, from this
    // route's server load) flow in via $page.data so plugin widgets are listed
    // and can be reordered/hidden like built-ins.
    const widgetData = $derived(($page.data ?? {}) as WidgetVisibilityData);
    const model = $derived(buildHomeWidgetModel(widgetData));

    // Names include plugin widget titles (built-ins win, then plugin titles).
    function getWidgetName(id: string): string {
        return resolveWidgetName(id, widgetData);
    }

    // The user's personal order/hidden set is canonical in the DB (no longer
    // localStorage). The server load (forwarded via +page.ts) provides it as
    // `data.userWidgetOrder` / `data.userHiddenWidgets`, so HomeWidgetsSection —
    // which builds its editable list once — seeds from the same source the home
    // page SSRs from.
    function initialWidgetOrder(): string[] {
        return data.userWidgetOrder ?? [];
    }

    function initialHiddenWidgets(): string[] {
        return data.userHiddenWidgets ?? [];
    }

    const widgetOrder = initialWidgetOrder();
    const hiddenWidgets = initialHiddenWidgets();

    // For You feed preferences (injected by +layout.server.ts).
    const feedPrefs = $derived(
        ($page.data?.feedPreferences as FeedPrefs | undefined) ?? DEFAULT_FEED_PREFS,
    );

    // Kinds the user can't meaningfully toggle because the underlying feature is
    // off — rendered locked, mirroring admin-disabled widgets. Only the clearly
    // derivable case (AI off) is marked; the AI-derived discovery rows can't be
    // produced without recommendations enabled.
    const adminDisabledKinds = $derived.by(() => {
        const out: string[] = [];
        if ($page.data?.features?.aiRecommendations === false) {
            out.push(
                'taste',
                'mood-recommendations',
                'because-you-watched',
                'featured-pick',
                'explore-keywords',
            );
        }
        return out;
    });
</script>

<div>
    <HomeWidgetsSection
        {widgetOrder}
        {hiddenWidgets}
        allWidgetIds={model.allWidgetIds}
        adminDisabledWidgets={model.adminDisabledWidgets}
        {getWidgetName} />

    <FeedSectionsSection
        feedMode={feedPrefs.mode}
        hiddenSectionKinds={[...feedPrefs.hiddenKinds]}
        {adminDisabledKinds} />
</div>
