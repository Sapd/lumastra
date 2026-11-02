<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        namespace: string;
        onClear: (namespace: string) => void;
    }

    let { namespace, onClear }: Props = $props();
</script>

<td class="py-4 text-center">
    <button class="btn btn-sm btn-soft-red !py-1 !text-xs" onclick={() => onClear(namespace)}>
        Clear
    </button>
</td>
