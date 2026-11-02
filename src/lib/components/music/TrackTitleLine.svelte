<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

A track's title line: rendered verbatim, with remixer credits inside version
tags ("Summertime (Ekowraith Remix)") linked to their artist when the track's
remixerArtists[] carries them (legacy artists[] is also accepted). Sibling of TrackArtistLine — same hover-card link
treatment, same comment-gluing so no markup whitespace is injected.

`onPlainClick` exists for surfaces whose whole title is already a button
(MiniPlayer's title opens the album): unlinked segments become buttons firing
it, linked segments open the artist — siblings, never nested interactives.
-->
<script lang="ts">
    import { linkifyTitle } from '$lib/utils/title-linkify';
    import { openArtistModal } from '$lib/utils/modal-utils';
    import MusicEntityHoverCard from './MusicEntityHoverCard.svelte';

    interface Props {
        /** The title, exactly as it should read. */
        title: string;
        /** Known artists for this track (`MusicTrack.artists` shape). */
        artists?: ReadonlyArray<{ id?: string | null; title: string }>;
        /** Resolved version/remixer credits, separate from performers. */
        remixerArtists?: ReadonlyArray<{ id?: string | null; title: string }>;
        /** Classes for the line wrapper. */
        class?: string;
        /** Ran after the artist modal opens (fullscreen player closes itself). */
        onNavigate?: () => void;
        /** When set, unlinked segments render as buttons firing this. */
        onPlainClick?: (event: MouseEvent) => void;
        /** Classes for the plain-segment buttons (only with onPlainClick). */
        plainClass?: string;
    }

    let {
        title,
        artists,
        remixerArtists,
        class: lineClass = '',
        onNavigate,
        onPlainClick,
        plainClass = '',
    }: Props = $props();

    const segments = $derived(
        linkifyTitle(title ?? '', [...(artists ?? []), ...(remixerArtists ?? [])]),
    );
    const hasLinks = $derived(segments.some((segment) => segment.id !== undefined));
    // A blank/whitespace-only title has no accessible name — never render it
    // as an interactive control, even when the surface wants onPlainClick.
    const hasPlainClickableTitle = $derived((title ?? '').trim().length > 0);

    const LINK_CLASS = 'hover:text-primary-400 hover:underline';

    /**
     * Leading/trailing whitespace of a segment must be rendered OUTSIDE the
     * plain-segment button: at the edge of a button's inline formatting
     * context the browser collapses it, so "(Manila| Radio Edit)" rendered
     * as link + button showed as "(ManilaRadio Edit)". The DOM text is
     * unchanged either way (byte-for-byte tests can't see this) — only the
     * paint differs.
     */
    function splitEdges(text: string): { lead: string; core: string; trail: string } {
        const lead = /^\s*/.exec(text)?.[0] ?? '';
        const rest = text.slice(lead.length);
        const trail = /\s*$/.exec(rest)?.[0] ?? '';
        return { lead, core: rest.slice(0, rest.length - trail.length), trail };
    }

    function open(event: MouseEvent, id: string): void {
        // The line usually sits inside a clickable row; opening the artist
        // must not also trigger that row.
        event.stopPropagation();
        openArtistModal(id);
        onNavigate?.();
    }
</script>

<span class={lineClass}>
    <!--
        prettier-ignore — segments must butt against each other with no markup
        whitespace, or the title gains phantom spaces (same regression the
        TrackArtistLine comment-gluing prevents). Keyed by identity + index so
        Svelte cannot reuse one artist's hover card for another on track change.
    -->
    {#if hasLinks}<!--
        -->{#each segments as segment, i ((segment.id ?? segment.text) + '-' + i)}<!--
            -->{#if segment.id}<MusicEntityHoverCard
                    kind="artist"
                    id={segment.id}
                    class={LINK_CLASS}
                    onclick={(event) => open(event, segment.id as string)}
                    >{segment.text}</MusicEntityHoverCard
                >{:else if onPlainClick}{@const edges = splitEdges(
                    segment.text,
                )}{edges.lead}{#if edges.core.length > 0}<button
                        type="button"
                        class={plainClass}
                        onclick={onPlainClick}>{edges.core}</button
                    >{/if}{edges.trail}{:else}{segment.text}{/if}<!--
        -->{/each}<!--
    -->{:else if onPlainClick && hasPlainClickableTitle}<button
            type="button"
            class={plainClass}
            onclick={onPlainClick}>{title}</button
        >{:else}{title}{/if}
</span>
