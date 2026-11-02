<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    interface Props {
        /** Tailwind sizing classes, e.g. "w-5 h-5" */
        class?: string;
    }

    let { class: className = 'w-5 h-5' }: Props = $props();

    // Unique gradient id so multiple instances on a page don't collide
    const uid = $props.id();
    const gradientId = `lumastra-request-gradient-${uid}`;
</script>

<!-- viewBox is cropped tighter than the source 0 0 512 512 so the plus fills more
     of the icon box. The gradient uses userSpaceOnUse coords in the original 512
     space, so it still maps correctly across the path. -->
<svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="64 64 384 384"
    role="img"
    aria-label="Request media"
    class={className}>
    <defs>
        <linearGradient
            id={gradientId}
            x1="38"
            y1="392"
            x2="454"
            y2="94"
            gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="#006BFF" />
            <stop offset="0.5" stop-color="#4540FF" />
            <stop offset="1" stop-color="#BE2DFF" />
        </linearGradient>
    </defs>
    <path
        fill="url(#{gradientId})"
        d="M210.0 126.0 A22 22 0 0 1 232.0 104.0 L280.0 104.0 A22 22 0 0 1 302.0 126.0 L302.0 194.0 A16 16 0 0 0 318.0 210.0 L386.0 210.0 A22 22 0 0 1 408.0 232.0 L408.0 280.0 A22 22 0 0 1 386.0 302.0 L318.0 302.0 A16 16 0 0 0 302.0 318.0 L302.0 386.0 A22 22 0 0 1 280.0 408.0 L232.0 408.0 A22 22 0 0 1 210.0 386.0 L210.0 318.0 A16 16 0 0 0 194.0 302.0 L126.0 302.0 A22 22 0 0 1 104.0 280.0 L104.0 232.0 A22 22 0 0 1 126.0 210.0 L194.0 210.0 A16 16 0 0 0 210.0 194.0 Z" />
</svg>
