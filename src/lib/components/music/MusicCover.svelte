<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Album / track cover art with the note-glyph placeholder as its ERROR state,
  not its default.

  Every music surface used to gate the `<img>` on the row's own
  `custom_poster_url`, which is not what the byte route serves — it inherits up
  the parent chain (track -> album -> artist). See `musicCoverUrl` for the full
  ladder and the numbers.
-->

<script lang="ts">
    import { retryImage } from './retry-image';
    import { musicCoverUrl } from '$lib/utils/music-cover';
    import type { ImageSize } from '$lib/utils/image-utils';

    interface Props {
        /**
         * Album or track id — the row whose parent chain resolves the art.
         * Omit when passing a ready-made `src` (a `MusicTrack.images` URL that
         * `musicCoverUrl` already built upstream).
         */
        id?: string;
        /** Pre-built cover URL. Takes precedence over `id`. */
        src?: string | null;
        alt?: string | null;
        size?: ImageSize;
        /** True when this row carries its own `custom_poster_url`. */
        hasOwnPoster?: boolean;
        /** True for a Various Artists compilation (album, or a track on one). */
        variousArtists?: boolean;
        /** Classes for the `<img>`; the glyph box always fills its parent. */
        imgClass?: string;
        /** Tailwind size class for the note glyph, e.g. `text-6xl`. */
        glyphClass?: string;
        /** Placeholder mark; `null` leaves an empty tinted box (compact rows). */
        glyph?: string | null;
        loading?: 'lazy' | 'eager';
        onImageError?: (src: string | null) => void;
    }

    let {
        id,
        src: srcProp = null,
        alt = null,
        size = 'thumb',
        hasOwnPoster = false,
        variousArtists = false,
        imgClass = 'h-full w-full object-cover',
        glyphClass = 'text-3xl',
        glyph = '♪',
        loading = 'lazy',
        onImageError,
    }: Props = $props();

    const src = $derived(
        srcProp ?? (id ? musicCoverUrl({ id, size, hasOwnPoster, variousArtists }) : null),
    );

    // Keyed on the URL, not on a bare boolean: these components are reused
    // across items (a modal swapping albums, a virtualised row), so a failure
    // recorded for one id would otherwise stick to the next one and hide an
    // image that resolves perfectly well.
    let failedSrc = $state<string | null>(null);
    const posterOk = $derived(src !== null && failedSrc !== src);
</script>

{#if posterOk}
    <img
        {src}
        alt={alt ?? ''}
        class={imgClass}
        {loading}
        use:retryImage={{
            src,
            onerror: () => {
                failedSrc = src;
                onImageError?.(src);
            },
        }} />
{:else}
    <div class="flex h-full w-full items-center justify-center bg-surface-700" aria-hidden="true">
        {#if glyph}<span class="text-surface-500 {glyphClass}">{glyph}</span>{/if}
    </div>
{/if}
