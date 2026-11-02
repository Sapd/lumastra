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

<!-- Tomato/Certified Fresh icon -->
<svg class={size} viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="13" r="9" fill="#FF6347" />
    <path d="M12 4c-1 0-2 .5-2.5 1.5S9 7 10 7.5s2-.5 2-1.5.5-2 0-2z" fill="#4CAF50" />
    <path d="M12 4c1 0 2 .5 2.5 1.5S15 7 14 7.5s-2-.5-2-1.5-.5-2 0-2z" fill="#4CAF50" />
</svg>
