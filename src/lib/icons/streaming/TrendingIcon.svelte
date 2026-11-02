<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        size?: string;
    }

    let { size = 'w-4 h-4' }: Props = $props();
</script>

<!-- Fire/Trending icon -->
<svg class={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 2c0 4-4 6-4 10a6 6 0 0012 0c0-4-4-6-4-10" stroke="#FF6B35" />
    <path d="M12 12c0 2-1 3-1 4a2 2 0 004 0c0-1-1-2-1-4" fill="#FF6B35" />
</svg>
