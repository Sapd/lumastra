<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    let { section = {} }: { section?: Record<string, unknown> } = $props();
</script>

<div data-testid="section-renderer-stub" data-section-id={String(section?.id ?? '')}></div>
