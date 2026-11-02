<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    let {
        beforeSections,
        sectionSnippet,
    }: { beforeSections?: Snippet; sectionSnippet?: Snippet<[{ sectionId: string }]> } = $props();
</script>

{@render beforeSections?.()}

{@render sectionSnippet?.({ sectionId: 'push' })}
