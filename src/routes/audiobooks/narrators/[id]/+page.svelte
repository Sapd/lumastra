<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import AudiobookResourcePage from '$lib/components/audiobook/AudiobookResourcePage.svelte';
    import type { PageData } from './$types';
    let { data }: { data: PageData } = $props();
</script>

<AudiobookResourcePage {data} />
