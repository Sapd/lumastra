<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Homepage tab content for Settings → Homepage & navigation (admin IA
  redesign, spec §3.6: homepage + navigation as tabs on ONE page). Ported
  near-verbatim from the deleted standalone `/admin/homepage` page.
-->
<script lang="ts">
    import { AdminSettingsPage } from '$lib/components/admin';
    import { Home } from 'svelte-hero-icons';
    import WidgetConfigEditor from '$lib/components/admin/WidgetConfigEditor.svelte';
    import type { WidgetVisibilityMap } from '$lib/config/schema';
    import type { SettingsLoadResult } from '$lib/server/admin/settings-helpers';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        data: SettingsLoadResult & {
            warnings: string[];
            featureFlags?: Record<string, boolean>;
            pluginWidgets?: { id: string; label: string }[];
        };
        form: { success?: boolean; error?: string; reloaded?: boolean } | null;
    }

    let { data, form }: Props = $props();
</script>

<AdminSettingsPage
    {data}
    {form}
    icon={Home}
    heading={m.admin_homepage_heading()}
    description={m.admin_homepage_description()}>
    {#snippet sectionSnippet({ sectionId, currentValues, envOverridesSet, handleChange })}
        {#if sectionId === 'homepage'}
            <WidgetConfigEditor
                widgetOrder={Array.isArray(currentValues.HOMEPAGE_WIDGET_ORDER)
                    ? (currentValues.HOMEPAGE_WIDGET_ORDER as string[])
                    : []}
                widgetVisibility={(currentValues.HOMEPAGE_WIDGET_VISIBILITY ??
                    {}) as WidgetVisibilityMap}
                featureFlags={(data.featureFlags ?? {}) as Record<string, boolean>}
                pluginWidgets={(data.pluginWidgets ?? []) as { id: string; label: string }[]}
                envOverrides={{
                    widgetOrder: envOverridesSet.has('HOMEPAGE_WIDGET_ORDER'),
                    widgetVisibility: envOverridesSet.has('HOMEPAGE_WIDGET_VISIBILITY'),
                }}
                onchange={(detail) => {
                    handleChange('HOMEPAGE_WIDGET_ORDER', detail.widgetOrder);
                    handleChange('HOMEPAGE_WIDGET_VISIBILITY', detail.widgetVisibility);
                }} />
        {/if}
    {/snippet}
</AdminSettingsPage>
