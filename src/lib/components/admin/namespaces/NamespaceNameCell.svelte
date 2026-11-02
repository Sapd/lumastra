<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        namespace: string;
    }

    let { namespace }: Props = $props();
</script>

<td class="py-4">
    <span class="font-medium text-white">{namespace}</span>
</td>
