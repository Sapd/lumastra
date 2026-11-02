<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { PageData } from './$types';
    import NonEntertainmentBrowse from '$lib/components/library/NonEntertainmentBrowse.svelte';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';

    let { data }: { data: PageData } = $props();

    const template = $derived(getLibraryTypeTemplate(data.libraryType));
    const groupKey = $derived(template?.browseConfig.groupBy[0] ?? '');
    const title = $derived(template?.label ?? data.libraryType);
</script>

<svelte:head>
    <title>{title}</title>
</svelte:head>

<NonEntertainmentBrowse
    libraryType={data.libraryType}
    items={data.items}
    total={data.total}
    filters={data.filters}
    groups={data.groups}
    activeFilter={data.activeFilter}
    limit={data.limit}
    offset={data.offset}
    defaultSort={data.defaultSort}
    progressMeaning={data.progressMeaning}
    {title}
    {groupKey}
    emptyMessage={m.library_empty_message({ title: title.toLowerCase() })} />
