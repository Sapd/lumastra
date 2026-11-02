<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

An artist/album link that reveals an informational hover card.

Renders the trigger button itself rather than wrapping one. That keeps the hover
handlers on a genuinely interactive element (a static wrapper carrying
mouseenter/mouseleave is an a11y violation) and lets the trigger point at the
card with aria-describedby.

The card is purely informational — artwork, name, counts, no controls — which is
why it can be `pointer-events: none` and needs no keep-open-on-enter path and no
focus trap.

Deliberately NOT MediaHoverCard: that is ~1800 lines of trailer/video preview
machinery, explicitly excluded from music items (see StandardSection.svelte)
because a video preview is meaningless for a track. What it does share is
`mediaHoverCoordinator`, which is generic: one body portal, one open card at a
time, one Escape listener, and force-close when a modal opens.
-->
<script lang="ts">
    import { retryImage } from './retry-image';
    import { computePosition, autoUpdate, offset, flip, shift } from '@floating-ui/dom';
    import type { Snippet } from 'svelte';
    import { mediaHoverCoordinator } from '$lib/components/ui/media-hover-coordinator.svelte';
    import {
        getMusicEntitySummary,
        type MusicEntityKind,
        type MusicEntitySummary,
    } from '$lib/api/music-summary';
    import type { MusicAlbumSummary, MusicArtistSummary } from '$lib/schemas/api-music-responses';
    import { Z } from '$lib/utils/z-index';

    interface Props {
        /** Which summary endpoint to read, and how to render the card. */
        kind: MusicEntityKind;
        /** Artist or album UUID — both the summary key and the artwork key. */
        id: string;
        /** Invoked on click; typically opens the artist/album modal. */
        onclick: (event: MouseEvent) => void;
        /** Classes for the trigger button. */
        class?: string;
        /** The link label. */
        children: Snippet;
    }

    let { kind, id, onclick, class: triggerClass = '', children }: Props = $props();

    /** Matches the Up Next popover's existing feel (MiniPlayer.svelte). */
    const HOVER_INTENT_MS = 150;

    // Unique per instance: the same artist can appear on several lines at once
    // (the player bar and an Up Next row), and each must claim the coordinator
    // separately.
    const cardId = $props.id();

    let triggerEl = $state<HTMLElement | null>(null);
    let cardEl = $state<HTMLElement | null>(null);
    let openTimer: ReturnType<typeof setTimeout> | null = null;
    let loading = false;

    // Every cached value is stamped with the entity it belongs to, and read back
    // through a $derived that only returns it while `id` still matches.
    //
    // Consumers reuse an instance across entities: the player bar's album card
    // keeps one instance and swaps `id` on every track change, and
    // TrackArtistLine's segments are positional. Plain $state would survive that
    // swap, and since load() skips work once summary is set, the card would show
    // the PREVIOUS artist's name and counts while pointing at the new one —
    // wrong information, not merely stale. Deriving off `id` resets all three for
    // free and re-arms load(), with no state-assigning $effect.
    let loaded = $state<{ id: string; data: MusicEntitySummary } | null>(null);
    let failedId = $state<string | null>(null);
    let posterFailedSrc = $state<string | null>(null);

    const summary = $derived(loaded?.id === id ? (loaded?.data ?? null) : null);
    const failed = $derived(failedId === id);

    const isOpen = $derived(mediaHoverCoordinator.activeId === cardId);
    const visible = $derived(isOpen && summary !== null && !failed);

    // `kind` — not shape-sniffing — decides which arm the payload is: the
    // endpoint was chosen by kind, so the two can never disagree.
    const artist = $derived(kind === 'artist' ? (summary as MusicArtistSummary | null) : null);
    const album = $derived(kind === 'album' ? (summary as MusicAlbumSummary | null) : null);

    // Probe the public inheriting image URL; an unavailable image falls back to a glyph.
    const coverUrl = $derived(summary?.images.primary?.variants?.thumb ?? null);
    const posterOk = $derived(posterFailedSrc !== coverUrl);

    function clearTimer(): void {
        if (openTimer !== null) {
            clearTimeout(openTimer);
            openTimer = null;
        }
    }

    async function load(): Promise<void> {
        if (summary !== null || loading || failed) return;
        // Capture the entity this call is for: `id` can change mid-flight (the
        // player bar swaps tracks), and a late response must not be stamped onto
        // whatever entity is showing by then.
        const forId = id;
        const forKind = kind;
        loading = true;
        try {
            const data = await getMusicEntitySummary(forKind, forId);
            if (data === null) {
                // Missing or inaccessible — never show a card.
                failedId = forId;
            } else {
                loaded = { id: forId, data };
            }
        } catch {
            // A hover is not worth an error toast — just never show the card.
            failedId = forId;
        } finally {
            loading = false;
        }
    }

    function show(): void {
        if (failed) return;
        clearTimer();
        openTimer = setTimeout(() => {
            mediaHoverCoordinator.ensureEscapeListener();
            mediaHoverCoordinator.claim(cardId);
            void load();
        }, HOVER_INTENT_MS);
    }

    function hide(): void {
        clearTimer();
        mediaHoverCoordinator.release(cardId);
    }

    // Track the trigger for as long as the card is open.
    $effect(() => {
        if (!visible || !triggerEl || !cardEl) return;
        return autoUpdate(triggerEl, cardEl, () => {
            if (!triggerEl || !cardEl) return;
            void computePosition(triggerEl, cardEl, {
                placement: 'top-start',
                middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
            }).then(({ x, y }) => {
                if (!cardEl) return;
                Object.assign(cardEl.style, { left: `${x}px`, top: `${y}px` });
            });
        });
    });

    // Never leave a pending open or a claimed id behind on unmount.
    $effect(() => {
        return () => {
            clearTimer();
            mediaHoverCoordinator.release(cardId);
        };
    });

    /**
     * Move the card into the coordinator's over-modal body portal, so
     * `position: fixed` resolves against the viewport (not the player bar's
     * transformed / overflow-hidden ancestors) AND the card clears an open
     * modal. The default getPortal() container is pinned at z-index 990 (below
     * the modal); since a fixed, z-indexed container is its own stacking
     * context, the card's own 1051 can't escape it — hence getOverlayPortal().
     */
    function portal(node: HTMLElement): { destroy(): void } {
        mediaHoverCoordinator.getOverlayPortal()?.appendChild(node);
        return {
            destroy(): void {
                node.remove();
            },
        };
    }

    function formatDuration(totalSeconds: number | null): string | null {
        if (totalSeconds === null || totalSeconds <= 0) return null;
        const minutes = Math.round(totalSeconds / 60);
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        return `${hours} hr ${minutes % 60} min`;
    }

    function plural(count: number, word: string): string {
        return `${count} ${count === 1 ? word : word + 's'}`;
    }

    // Joined here rather than in the markup. Svelte trims whitespace adjacent to
    // block tags, so an inline `{#if album.year}{album.year} · {/if}` loses the
    // space the formatter parks next to the boundary and renders "2003 ·14
    // tracks· 56 min". Building the string in script keeps the separators out of
    // prettier's reach entirely.
    const artistMeta = $derived(
        artist ? [plural(artist.albumCount, 'album'), plural(artist.trackCount, 'track')] : [],
    );
    const albumMeta = $derived(
        album
            ? [
                  album.year !== null ? String(album.year) : null,
                  plural(album.trackCount, 'track'),
                  formatDuration(album.durationMs == null ? null : album.durationMs / 1000),
              ].filter((part): part is string => part !== null)
            : [],
    );
</script>

<button
    bind:this={triggerEl}
    type="button"
    class={triggerClass}
    aria-describedby={visible ? cardId : undefined}
    {onclick}
    onmouseenter={show}
    onmouseleave={hide}
    onfocus={show}
    onblur={hide}>
    {@render children()}
</button><!--
    prettier-ignore — glued to the trigger button with no markup whitespace
    between them. This component's whole output sits inline inside a text
    line (TrackArtistLine/TrackTitleLine's linked segments): a source
    newline here is inter-sibling whitespace at the root of THIS component's
    fragment, which Svelte collapses to a single space rather than trimming
    to nothing, so every render silently appended a trailing space after the
    trigger even while this block renders empty (not visible).
    -->{#if visible && summary}
    <!-- MUSIC_OVER_MODAL_POPUP (not MEDIA_HOVER_PREVIEW): every trigger context
         of this card — MiniPlayer/queue (lifted to MUSIC_OVER_MODAL when a music
         modal is open), the album/artist modal tracklists, the fullscreen player
         — sits at or above the modal layer, so this card must too. The lift is
         actually carried by getOverlayPortal()'s container (baseline 1051,
         raised to track the modal stack): this card lives inside that fixed,
         z-indexed container's stacking context, so this inline z-index only
         orders it there — it can't clear the modal on its own. Kept at the
         container's baseline so the two never disagree at a single modal. -->
    <div
        bind:this={cardEl}
        use:portal
        id={cardId}
        role="tooltip"
        style:z-index={Z.MUSIC_OVER_MODAL_POPUP}
        class="pointer-events-none fixed left-0 top-0 w-64 rounded-lg border border-surface-700/60
               bg-surface-900/95 p-3 shadow-xl backdrop-blur-sm">
        <div class="flex items-center gap-3">
            {#if coverUrl && posterOk}
                <img
                    src={coverUrl}
                    alt=""
                    class="h-14 w-14 shrink-0 rounded object-cover"
                    use:retryImage={{
                        src: coverUrl,
                        onerror: () => (posterFailedSrc = coverUrl),
                    }} />
            {:else}
                <div
                    class="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-surface-800
                           text-lg text-surface-500"
                    aria-hidden="true">
                    ♪
                </div>
            {/if}

            <div class="min-w-0">
                <p class="truncate text-sm font-semibold text-surface-50">{summary.title}</p>

                {#if artist}
                    <p class="mt-0.5 text-xs text-surface-400">{artistMeta.join(' · ')}</p>
                {:else if album}
                    {#if album.artist.title}
                        <p class="mt-0.5 truncate text-xs text-surface-300">{album.artist.title}</p>
                    {/if}
                    <p class="mt-0.5 text-xs text-surface-400">{albumMeta.join(' · ')}</p>
                {/if}
            </div>
        </div>
    </div>
{/if}
