<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /** Test-only stand-in for a real submenu panel (see ContextMenu.submenu.test.ts). */
    interface Props {
        marker: string;
        onCommit?: (() => void) | undefined;
        onDone: () => void;
    }
    let { marker, onCommit, onDone }: Props = $props();
</script>

<div>
    <span>{marker}</span>
    <button
        type="button"
        onclick={() => {
            onCommit?.();
            onDone();
        }}>commit</button>
</div>
