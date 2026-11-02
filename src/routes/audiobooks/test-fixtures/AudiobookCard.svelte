<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
    let { item, onclick }: { item: UniversalMediaItem; onclick: () => void } = $props();
</script>

<button type="button" {onclick}>{item.title}</button>
