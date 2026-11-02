<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { page } from '$app/stores';
    import PlaybackSection from '$lib/components/settings/PlaybackSection.svelte';
    import ConnectionSection from '$lib/components/settings/ConnectionSection.svelte';

    const highlight = $derived($page.url.searchParams.get('highlight') ?? '');
</script>

<PlaybackSection {highlight} />
<ConnectionSection />
