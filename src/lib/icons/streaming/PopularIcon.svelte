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

<!-- Star/Popular icon -->
<svg class={size} viewBox="0 0 24 24" fill="#FFD700">
    <path
        d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
</svg>
