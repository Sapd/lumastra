<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Reusable progress bar component with conditional coloring
     *
     * Usage:
     *   <ProgressBar percent={75} color="bg-blue-500" />
     */

    interface Props {
        /** Progress value (0-100) */
        percent: number;
        /** Color class for the progress bar */
        color: string;
    }

    let { percent, color }: Props = $props();
</script>

<div class="mt-2 w-full h-2 bg-surface-700 rounded-full overflow-hidden">
    <div class="h-full transition-all duration-300 {color}" style="width: {percent}%"></div>
</div>
