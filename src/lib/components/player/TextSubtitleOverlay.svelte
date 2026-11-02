<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    let { cue, inlineStyle, positionY }: { cue: string; inlineStyle: string; positionY: number } =
        $props();
</script>

<div
    class="portrait-subtitle-overlay"
    style:top={`${positionY}%`}
    style:transform="translateY(-50%)">
    <span class="portrait-subtitle-text" style={inlineStyle}>{cue}</span>
</div>

<style>
    .portrait-subtitle-overlay {
        display: flex;
        justify-content: center;
        align-items: center;
        position: absolute;
        left: 0;
        right: 0;
        text-align: center;
        padding: 0 16px;
        /* Overlay tier (2), under the control bar (3). */
        z-index: 2;
        pointer-events: none;
    }

    .portrait-subtitle-text {
        display: inline-block;
        max-width: 92%;
        padding: 6px 14px;
        border-radius: 4px;
        line-height: 1.5;
        white-space: pre-wrap;
        text-align: center;
    }
</style>
