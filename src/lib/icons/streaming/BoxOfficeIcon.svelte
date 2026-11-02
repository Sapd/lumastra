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

<!-- Clapperboard/Box Office icon -->
<svg class={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4 4l2 2 2-2 2 2 2-2 2 2 2-2 2 2 2-2v4H4V4z" fill="#333" />
    <rect x="4" y="8" width="16" height="12" rx="1" fill="#555" />
    <path d="M4 4l2 2 2-2 2 2 2-2 2 2 2-2 2 2 2-2v4H4V4z" fill="#333" />
</svg>
