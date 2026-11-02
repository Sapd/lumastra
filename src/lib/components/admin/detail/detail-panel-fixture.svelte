<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Test fixture for DetailPanel.svelte.test.ts — hosts DetailPanel with a
snippet child so the test file can pass plain props (snippets can't be
constructed from a test file directly).
-->
<script lang="ts">
    import DetailPanel from './DetailPanel.svelte';
    import ContentProbe from './detail-panel-content-probe.svelte';

    interface Props {
        titleText: string;
        subtitle?: string;
        description?: string;
        tabs: { id: string; label: string; badge?: number }[];
        activeTab: string;
        onTabChange: (id: string) => void;
        mode?: 'auto' | 'panel' | 'page';
        onclose?: () => void;
        backHref?: string;
        onContentMount?: () => void;
        onContentDestroy?: () => void;
    }

    let {
        titleText,
        subtitle,
        description,
        tabs,
        activeTab,
        onTabChange,
        mode = 'auto',
        onclose,
        backHref,
        onContentMount,
        onContentDestroy,
    }: Props = $props();
</script>

<DetailPanel
    {titleText}
    {subtitle}
    {description}
    {tabs}
    {activeTab}
    {onTabChange}
    {mode}
    {onclose}
    {backHref}>
    {#snippet children(tab)}
        <ContentProbe {tab} {onContentMount} {onContentDestroy} />
    {/snippet}
</DetailPanel>
