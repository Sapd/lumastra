<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

A track's artist line, with each known artist independently linked.

Renders the raw display-artist string with the resolved names turned into
links and everything between them — "`, `", "` feat. `", "` & `" — kept
verbatim, so the line still reads the way the file's tag wrote it.

Shared by the player bar, the fullscreen player, the Up Next rows, and the
album/artist modal track lists, so all four behave identically.

Degrades in two steps:
  * no structured candidates but `artistId` is set → one link over the whole string
    (the historical behaviour, minus the Various Artists mis-target);
  * nothing at all → plain text.
-->
<script lang="ts">
    import { linkifyArtists } from '$lib/utils/artist-linkify';
    import { openArtistModal } from '$lib/utils/modal-utils';
    import MusicEntityHoverCard from './MusicEntityHoverCard.svelte';

    interface Props {
        /** The display string, exactly as it should read. */
        artist: string;
        /** Known artists for this track, when the source carries them. */
        artists?: ReadonlyArray<{ id?: string | null; title: string }>;
        /** Fallback single artist target when there are no structured candidates. */
        artistId?: string;
        /** Classes for the line wrapper. */
        class?: string;
        /**
         * Ran after the artist modal opens. The fullscreen player uses this to
         * close itself, so the modal is not left stranded behind the overlay.
         */
        onNavigate?: () => void;
    }

    let { artist, artists, artistId, class: lineClass = '', onNavigate }: Props = $props();

    const segments = $derived(linkifyArtists(artist ?? '', artists));
    const hasLinks = $derived(segments.some((segment) => segment.id !== undefined));

    const LINK_CLASS = 'hover:text-primary-400 hover:underline';

    function open(event: MouseEvent, id: string): void {
        // The line usually sits inside a clickable row (a queue item, a track
        // row); opening the artist must not also trigger that row.
        event.stopPropagation();
        openArtistModal(id);
        onNavigate?.();
    }
</script>

<span class={lineClass}>
    <!--
        prettier-ignore — the segments must not be separated by any markup
        whitespace. The separators ("`, `", "` feat. `") are themselves segments,
        so a newline between them and the links renders an extra space and the
        line reads "John Oates , Daryl Hall". That forces the tags to butt
        directly against each other; prettier would otherwise break them apart
        and silently reintroduce the gap.

        Keyed by identity rather than position: a bare index would let Svelte
        reuse one artist's card instance for a different artist when the track
        changes. MusicEntityHoverCard scopes its own cache to `id` too, so this
        is belt-and-braces.
    -->
    {#if hasLinks}<!--
        -->{#each segments as segment, i ((segment.id ?? segment.text) + '-' + i)}<!--
            -->{#if segment.id}<MusicEntityHoverCard
                    kind="artist"
                    id={segment.id}
                    class={LINK_CLASS}
                    onclick={(event) => open(event, segment.id as string)}
                    >{segment.text}</MusicEntityHoverCard
                >{:else}{segment.text}{/if}<!--
        -->{/each}<!--
    -->{:else if artistId && !artists?.length}
        <MusicEntityHoverCard
            kind="artist"
            id={artistId}
            class={LINK_CLASS}
            onclick={(event) => open(event, artistId)}>{artist}</MusicEntityHoverCard>
    {:else}{artist}{/if}
</span>
