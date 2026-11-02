<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    let { isAvailable = false }: { isAvailable?: boolean } = $props();
</script>

<div data-testid="watchlist-button" data-available={String(isAvailable)}></div>
