<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/stores';
    import SubtitlesSection from '$lib/components/settings/SubtitlesSection.svelte';

    const highlight = $derived($page.url.searchParams.get('highlight') ?? '');
</script>

<SubtitlesSection {highlight} />
