<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        tokenPrefix: string;
    }

    let { tokenPrefix }: Props = $props();
</script>

<td class="px-4 py-3">
    <code class="text-sm bg-surface-900 px-2 py-1 rounded">{tokenPrefix}...</code>
</td>
