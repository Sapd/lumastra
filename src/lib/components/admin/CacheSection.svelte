<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { Snippet } from 'svelte';

    interface Props {
        /** Header area: title, icon, and summary stats */
        header: Snippet;
        /** Main content area: table, grid, or other cache data */
        content: Snippet;
    }

    let { header, content }: Props = $props();
</script>

<div class="card-gradient-lg">
    <div class="between mb-6">
        {@render header()}
    </div>
    {@render content()}
</div>
