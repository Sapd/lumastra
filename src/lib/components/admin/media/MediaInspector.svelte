<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Inspector panel for the admin media browser — replaces MediaPreviewRow's
  inline `<tr>` expansion (task 4 of the media-inspector-and-selection spec).

  Two presentations, one component:
  - docked (>=1280px, caller decides): a flex sibling of the table. NON-MODAL —
    no backdrop, no focus trap, the table stays live so arrow-walking the list
    keeps the panel in sync.
  - modal (<1280px, caller decides): RunLogDrawer's presentation — fixed
    right-hand drawer, backdrop, role="dialog" aria-modal="true", focus
    trapped inside.

  `docked` is passed in by the caller rather than measured internally: the
  keyboard model differs by presentation (arrow-walking under a modal
  backdrop is incoherent), and that decision belongs to whatever owns
  selection/focus on the page, not to this component.

  Accessibility: the panel body is NOT a live region — only a single-line
  summary ("title · type · state") is announced via aria-live on item change.
  Wrapping the whole panel in aria-live would re-announce every field on every
  arrow key, which is worse than silence.
-->
<script lang="ts">
    import AudioTailDiagnosis from './AudioTailDiagnosis.svelte';
    import { Z } from '$lib/utils/z-index';
    // Z.MODAL / Z.MODAL + 1 (backdrop / panel): Tailwind z-40/z-50 sat below the
    // fixed navbar (Z.NAVBAR = 500), whose bell covered and swallowed the close button.
    import { page } from '$app/state';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { getMediaPreview } from '$lib/api/admin';
    import type { MediaPreviewResponse } from '$lib/schemas/api-admin-responses';
    import { isSeries, isMovie, isMusicType } from '$lib/shared/media-types';
    import { mediaTypeName } from './media-issue-presentation.js';
    import { resolve } from '$lib/paths';
    import { getCatalogImageUrl } from '$lib/utils/image-utils';
    import {
        artworkCandidatesFor,
        artworkShapeOf,
        type ArtworkRole,
    } from './media-inspector-artwork.js';
    import type { MediaInspectorItem } from './media-inspector-types.js';
    import {
        fileHealthIssueGuidance,
        fileHealthIssueLabel,
        fileHealthIssueReason,
        fileHealthIssueTextClass,
        isSevereHealthIssue,
    } from '$lib/utils/file-health-issue';
    import { actionsFor, type MediaActionDef, type MediaActionId } from './media-actions.js';
    import { mediaActionLabel } from './media-action-presentation.js';
    import {
        mediaIssueFix,
        mediaIssueFixLabel,
        mediaIssueLabel,
        severityBadgeClass,
        severityDotClass,
    } from './media-issue-presentation.js';
    import { noteIssues, problemIssues, type MediaIssue } from '$lib/shared/media-issues.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        getCachedPreview,
        setCachedPreview,
        clearPreviewCache,
    } from './media-inspector-cache.js';

    interface Props {
        item: MediaInspectorItem;
        docked: boolean;
        onclose: () => void;
        /**
         * Run one of the registry's actions for `item`.
         *
         * REQUIRED, not optional. Without a handler the action buttons render
         * fully live-looking and do nothing — exactly what shipped between
         * task 4 and task 5. Making it optional and hiding the Actions section
         * when absent only relocated that silent failure: a caller who forgot
         * the prop got a panel with no actions at all and no diagnostic. As a
         * required prop the omission is a compile error, at zero cost — there
         * is one call site.
         */
        onaction: (action: MediaActionId) => void;
        /**
         * Run the fix for one of the row's issues (Issues section). Optional:
         * without it the section still lists the issues, just without buttons.
         */
        onfixissue?: (issue: MediaIssue) => void;
    }

    let { item, docked, onclose, onaction, onfixissue }: Props = $props();

    // ------------------------------------------------------------------
    // Preview fetch — debounced + cached by id+updatedAt
    // ------------------------------------------------------------------

    /** Arrow-walking a list can change `item` many times a second; only the
     * item the operator actually stops on should trigger a network request. */
    const PREFETCH_DEBOUNCE_MS = 150;

    let preview = $state<MediaPreviewResponse | null>(null);
    let loading = $state(false);
    let loadError = $state<string | null>(null);

    // Monotonic token: an in-flight fetch for a superseded item must not
    // overwrite the state for whatever item is current when it resolves.
    let fetchToken = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    async function fetchPreview(id: string, updatedAt: string): Promise<void> {
        const myToken = ++fetchToken;
        loading = true;
        loadError = null;
        const { data, error } = await getMediaPreview(id);
        if (myToken !== fetchToken) return; // superseded by a newer item
        if (error || !data) {
            loadError = error ?? m.media_plain_preview_failed();
        } else {
            preview = data;
            setCachedPreview(id, updatedAt, data);
        }
        loading = false;
    }

    $effect(() => {
        const id = item.id;
        const updatedAt = item.updatedAt;

        if (debounceTimer) clearTimeout(debounceTimer);

        // Bumped on EVERY item change, cached path or not. It used to be
        // bumped only when the new item was a cache HIT, which left a real
        // window on the uncached path: a request for item A is in flight, the
        // operator arrows to an uncached B, and A resolves before B's 150ms
        // debounce has even fired a request — so `fetchToken` is still A's
        // token, A's response passes its own staleness guard, and A's payload
        // paints under B's title. Arrow-walking is precisely the workload that
        // produces those overlapping in-flight requests, so the window is the
        // normal case, not a corner. The bump has to happen BEFORE the branch
        // for the same reason.
        fetchToken++;

        // Clear on every item change too, for the same window: a panel showing
        // A's fields under B's header is worse than a panel showing nothing.
        // The cached branch reassigns immediately below, so this costs no
        // flicker there.
        //
        // UNOBSERVABLE TODAY, and kept anyway. `loading = true` below already
        // hides the body — the template gates it behind `{#if loading}` — so
        // deleting this line changes nothing a DOM test can see (measured: the
        // whole component suite still passes without it). It stays because the
        // invariant "`preview` never belongs to a superseded item" should hold
        // in the state itself, not only in whichever branch the markup happens
        // to render today. Its test coverage is honestly the `loading` gate's;
        // see the note in MediaInspector.test.ts.
        preview = null;
        loadError = null;

        const cached = getCachedPreview(id, updatedAt);
        if (cached) {
            preview = cached;
            loading = false;
            return;
        }

        loading = true;
        debounceTimer = setTimeout(() => {
            void fetchPreview(id, updatedAt);
        }, PREFETCH_DEBOUNCE_MS);

        return () => {
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    });

    // `invalidateAll()` (called after every mutating admin action on the
    // media browser page — sync, delete, unlock, ...) does NOT call the
    // router's navigate() path, so `afterNavigate` never fires for it —
    // `_invalidate()` reruns load() and does `root.$set()` directly. That
    // `$set()` is what updates `page.data`, so watching it here catches both
    // a real navigation AND an invalidateAll-triggered reload of the current
    // page. This will also clear on plain pagination — an acceptable cost
    // for not silently missing a re-probe or a sync.
    $effect(() => {
        page.data;
        clearPreviewCache();
    });

    // ------------------------------------------------------------------
    // One-line summary — announced, not the whole panel
    // ------------------------------------------------------------------

    function stateLabel(i: MediaInspectorItem): string {
        if (!i.hasFiles) return m.media_plain_unavailable();
        if (i.metadataLocked) return m.media_plain_locked();
        return m.media_plain_available();
    }

    // The DB's internal media_type ('tv') is not the operator-facing name
    // ('Series') — the same label the list's Type badge shows, computed
    // straight from `item` so neither the header nor the announced summary
    // waits on the preview fetch to say the right thing.
    let publicMediaType = $derived(mediaTypeName(item.mediaType));

    let summary = $derived(`${item.title} · ${publicMediaType} · ${stateLabel(item)}`);

    // ------------------------------------------------------------------
    // Artwork — derived from the ROW, not from a second fetch
    // ------------------------------------------------------------------

    /**
     * The panel's artwork needs nothing the row does not already carry: the
     * image endpoint is keyed by media id, so `item.id` + `item.mediaType` is
     * the whole input. That matters twice over — it costs no request beyond
     * the image itself (the preview payload has no artwork field, so pulling
     * it from there would have meant widening a response AND waiting on the
     * debounced fetch), and it paints IMMEDIATELY on arrow-walk instead of
     * appearing 150ms later under a title that is already correct.
     *
     * It is therefore rendered OUTSIDE the `{#if loading}` gate, above
     * Identity, and inside the scrolling body rather than the fixed header.
     * Inside the body is load-bearing, not cosmetic: Actions lives in that
     * same scroll container, so however tall the artwork gets, Actions stays
     * reachable by scrolling. Artwork in the header would eat panel height
     * permanently and could push Actions out of reach on a short viewport.
     */
    let artworkCandidates = $derived(artworkCandidatesFor(item.mediaType));

    /**
     * Which candidate we are currently attempting, tagged with the item it
     * belongs to.
     *
     * The tag makes the reset implicit: a new `item.id` no longer matches, so
     * the index falls back to 0 in the same derivation pass that renders the
     * new item. Resetting from an `$effect` instead would run AFTER the first
     * render of the new item — one frame in which item B is requested at item
     * A's fallback role.
     */
    let artworkAttempt = $state<{ id: string; index: number }>({ id: '', index: 0 });
    let artworkIndex = $derived(artworkAttempt.id === item.id ? artworkAttempt.index : 0);
    let artworkRole = $derived<ArtworkRole | null>(artworkCandidates[artworkIndex] ?? null);
    let artworkShape = $derived(artworkRole ? artworkShapeOf(artworkRole) : null);

    /**
     * `fallback: 'none'` is what makes a missing image COLLAPSE rather than
     * occupy the same space with something untrue. Without it the endpoint
     * answers a miss with `302 → FALLBACK_IMAGE`, which loads perfectly well:
     * `onerror` never fires, nothing knows the image is absent, and the panel
     * shows a popcorn graphic in the identity slot. With it the miss is a bare
     * 404, `onerror` fires, and we move to the next candidate or render
     * nothing at all.
     */
    let artworkUrl = $derived(
        artworkRole
            ? getCatalogImageUrl(item.id, artworkRole, {
                  size: artworkShape === 'hero' ? 'card' : 'thumb',
                  fallback: 'none',
              })
            : null,
    );

    /**
     * Recreation key for the `<img>`. Swapping `src` on a live element leaves
     * the PREVIOUS image painted until the new one decodes, which on
     * arrow-walk means row N's artwork sitting under row N+1's title — the
     * same stale-paint class the preview fetch needed `fetchToken` for. A
     * `{#key}` on this destroys the element and builds a fresh one, and a
     * fresh `<img>` has no previous frame to show.
     */
    let artworkKey = $derived(`${item.id}:${artworkRole ?? 'none'}`);

    /**
     * Advance to the next candidate — but only if the failure belongs to the
     * element we are currently showing.
     *
     * The pair is read back off the ELEMENT (`data-artwork-key`), not from a
     * closure. `onerror={() => f(item.id, artworkIndex)}` looks like it
     * captures the failing request's identity and does not: the arrow body
     * runs when the event fires, so a late `error` from item A's request
     * reads item B's id and B's index, both guards compare a value to itself
     * and pass, and B is pushed past a candidate it never tried. That is not
     * hypothetical — it is what the first version of this did, and
     * MediaInspector.test.ts's "superseded item" case is the one that caught
     * it. The element's attribute is the only value frozen at the moment the
     * request was made.
     */
    function onArtworkError(img: HTMLImageElement): void {
        if (img.dataset.artworkKey !== artworkKey) return;
        artworkAttempt = { id: item.id, index: artworkIndex + 1 };
    }

    // ------------------------------------------------------------------
    // Actions — from the registry, not a hand-rolled list
    // ------------------------------------------------------------------

    // Button labels come from `media-action-presentation.ts` — an exhaustive
    // switch over `MediaActionId`, not the `Record<MediaActionId, string>` that
    // used to be hand-copied here and in MediaActionBar.svelte. Nothing checked
    // those copies: tsgo skips `.svelte` and svelte-check-native was measured
    // not to flag a broken key in a component-local record, so an action added
    // to the registry rendered as a button with no text. That module also
    // explains why `reprobe` reads "Open Files" rather than "Re-probe".

    let actions = $derived<MediaActionDef[]>(
        actionsFor({
            mediaType: item.mediaType,
            surface: 'inspector',
            hasFiles: item.hasFiles,
            childCount: item.childCount,
            locked: item.metadataLocked,
            domainFlags: {
                supportsProviderIdentity: item.supportsProviderIdentity,
                isUnidentified: item.isUnidentifiedDomain,
            },
        }),
    );

    // Destructive actions render apart from the rest. The registry orders
    // Delete right after Watch, so in one wrapped row the most frequent action
    // and the irreversible one were adjacent buttons of the same size.
    let safeActions = $derived(actions.filter((a) => !a.destructive));
    let destructiveActions = $derived(actions.filter((a) => a.destructive));

    // ------------------------------------------------------------------
    // Formatting (small + local, matching MediaPreviewRow)
    // ------------------------------------------------------------------

    function formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        const units = ['KB', 'MB', 'GB', 'TB'];
        let i = -1;
        let val = bytes;
        do {
            val /= 1024;
            i++;
        } while (val >= 1024 && i < units.length - 1);
        return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
    }

    function formatRuntime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    function formatDate(iso: string): string {
        return new Date(iso).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
        });
    }

    function formatDateTime(iso: string): string {
        return new Date(iso).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    function resolutionLabel(p: MediaPreviewResponse): string | null {
        if (!p.videoWidth || !p.videoHeight) return null;
        return `${p.videoWidth}×${p.videoHeight}`;
    }

    // ------------------------------------------------------------------
    // External ids — followable where the URL is unambiguous, selectable
    // everywhere else
    // ------------------------------------------------------------------

    /**
     * An operator opens this panel to cross-reference an id, not to admire
     * it. The old inline preview row printed all four as inert text, which
     * meant retyping a 7-digit TMDB id into another tab by hand. So: every id
     * is rendered `select-all` (one click grabs the whole id, no dragging
     * across a truncating cell), and the two whose canonical URL is
     * unambiguous also become links.
     *
     * Which two, and why not all four:
     * - TMDB namespaces by kind (`/movie/{id}` vs `/tv/{id}`) and this row's
     *   id is whichever kind the item is. Movie and series are unambiguous.
     *   A season's or an episode's TMDB id lives under a PARENT's path that
     *   this payload does not carry, so linking one would land the operator
     *   on an unrelated title — worse than not linking at all.
     * - IMDB title ids are a single flat namespace, but only for `tt…` ids;
     *   anything else in that column (a name id, a scrape artifact) gets no
     *   link rather than a 404.
     * - TVDB's public paths are slug-based per kind, not id-based, so there
     *   is no id-only URL to build.
     * - A Jellyfin id only means anything against a specific Jellyfin
     *   instance, and this panel has no base URL for one.
     */
    interface ExternalIdEntry {
        label: string;
        value: string;
        href: string | null;
    }

    function tmdbHref(mediaType: string, id: string): string | null {
        if (isMovie(mediaType)) return `https://www.themoviedb.org/movie/${encodeURIComponent(id)}`;
        if (isSeries(mediaType)) return `https://www.themoviedb.org/tv/${encodeURIComponent(id)}`;
        return null;
    }

    function externalIdEntriesOf(
        i: MediaInspectorItem,
        p: MediaPreviewResponse,
    ): ExternalIdEntry[] {
        const entries: ExternalIdEntry[] = [];
        if (p.externalIds.tmdb) {
            entries.push({
                label: 'TMDB',
                value: p.externalIds.tmdb,
                href: tmdbHref(i.mediaType, p.externalIds.tmdb),
            });
        }
        if (p.externalIds.imdb) {
            entries.push({
                label: 'IMDB',
                value: p.externalIds.imdb,
                href: /^tt\d+$/.test(p.externalIds.imdb)
                    ? `https://www.imdb.com/title/${p.externalIds.imdb}/`
                    : null,
            });
        }
        if (p.externalIds.tvdb) {
            entries.push({ label: 'TVDB', value: p.externalIds.tvdb, href: null });
        }
        if (p.externalIds.jellyfin) {
            entries.push({ label: 'Jellyfin', value: p.externalIds.jellyfin, href: null });
        }
        return entries;
    }

    /**
     * Season fill state, as a word rather than only a colour — the inline
     * preview row signalled this with a bare coloured icon carrying no
     * accessible name, so a screen reader got "Season 3: 10 episodes (4
     * linked)" and nothing about it being a problem.
     */
    function seasonFillLabel(episodeCount: number, linkedCount: number): string {
        if (episodeCount > 0 && linkedCount === episodeCount) return m.media_plain_complete();
        if (linkedCount === 0) return m.media_plain_none_linked();
        return m.media_plain_partial();
    }

    function seasonFillClass(episodeCount: number, linkedCount: number): string {
        if (episodeCount > 0 && linkedCount === episodeCount) return 'text-green-400';
        if (linkedCount === 0) return 'text-red-400';
        return 'text-yellow-400';
    }

    // `fileHealthIssueReason` (file-health-issue.ts) reads snake_case
    // (`expected_duration`/`actual_duration`) — the probe's own on-disk
    // vocabulary. This schema's `healthIssues[]` uses camelCase like the
    // rest of this response, so the two must be mapped explicitly at this
    // call site rather than passed straight through: TS accepts the mismatch
    // silently (every field is optional, no excess-property check on a loop
    // variable), and without the mapping a `truncated_video` issue with only
    // durations (no `detail`) renders as "0s / 0s" instead of the real gap.
    function healthIssueReason(
        issue: NonNullable<MediaPreviewResponse['healthIssues']>[number],
    ): string | undefined {
        return fileHealthIssueReason({
            type: issue.type,
            basis: issue.basis,
            detail: issue.detail,
            reviewed: issue.reviewed,
            expected_duration: issue.expectedDuration,
            actual_duration: issue.actualDuration,
        });
    }

    // Row-level ancestry (plan 1) takes priority over the fetched parent
    // chain: it needs no network round trip and is generic across every
    // hierarchy (series→season, artist→album, or a plain parent), whereas
    // `preview.parentTitle`/`grandparentTitle` only ever covers the
    // episode/track case. Both are optional — an item type with neither
    // simply renders no ancestry line, and that must degrade gracefully
    // since Task 5 populates the row fields, not this component.
    function ancestryLine(i: MediaInspectorItem, p: MediaPreviewResponse): string | null {
        if (i.seriesTitle) {
            return i.seasonTitle ? `${i.seriesTitle} → ${i.seasonTitle}` : i.seriesTitle;
        }
        if (i.albumTitle) {
            return i.artistTitle ? `${i.artistTitle} → ${i.albumTitle}` : i.albumTitle;
        }
        if (i.genericParentTitle) return i.genericParentTitle;
        if (p.grandparentTitle && p.parentTitle) return `${p.grandparentTitle} → ${p.parentTitle}`;
        return p.parentTitle ?? p.grandparentTitle ?? null;
    }

    // Only wired on the modal presentation (see markup below) — the docked
    // panel is a non-modal sibling of the table and Escape has no reason to
    // dismiss it, so this is never attached there.
    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            e.stopPropagation();
            onclose();
        }
    }
</script>

{#snippet panelContent()}
    <!-- Announced, one line, on item change. The rest of the panel is
         deliberately NOT wrapped in aria-live. -->
    <div aria-live="polite" class="sr-only">{summary}</div>

    <div class="flex items-center justify-between border-b border-surface-700 p-4">
        <div class="min-w-0">
            <h3 class="truncate text-lg font-medium text-white">{item.title}</h3>
            <p class="text-sm text-surface-400">{publicMediaType}</p>
        </div>
        <!-- The panel is a preview; this is the way into the full item. Without
             it the detail page was reachable only by double-clicking the row. -->
        <a
            href={resolve(`/admin/library/media/${item.id}`)}
            data-sveltekit-preload-data="hover"
            class="ml-auto mr-2 shrink-0 rounded border border-surface-600 px-2 py-1 text-xs font-medium text-surface-200 hover:border-primary-500 hover:text-white">
            {m.media_plain_open_details()}
        </a>
        <button
            class="p-1 text-surface-400 hover:text-white"
            onclick={onclose}
            data-autofocus
            aria-label={m.media_plain_close_inspector()}
            title={m.media_plain_close()}>
            ✕
        </button>
    </div>

    <div class="flex-1 space-y-4 overflow-y-auto p-4">
        <!-- Issues first: the panel is where a row's problems get fixed
             (triage spec). Row-derived, so it paints before the preview. -->
        {#if item.issues}
            <section class="space-y-2" data-testid="inspector-issues">
                <h4 class="text-xs font-semibold uppercase text-surface-500">
                    {m.media_issues_heading()}
                </h4>
                {#each problemIssues(item.issues) as issue, i (issue.kind + (issue.subtype ?? '') + i)}
                    <div
                        class="space-y-2 rounded-lg border border-surface-700 bg-surface-900/60 p-2.5">
                        <div class="flex items-center justify-between gap-2">
                            <span
                                class="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium {severityBadgeClass(
                                    issue.severity,
                                )}">
                                <span
                                    class="h-1.5 w-1.5 rounded-full {severityDotClass(
                                        issue.severity,
                                    )}"></span>
                                {mediaIssueLabel(issue, item.mediaType)}
                            </span>
                            {#if onfixissue}
                                <button
                                    type="button"
                                    class="rounded border border-surface-600 bg-surface-700 px-2.5 py-1 text-xs font-medium text-surface-100 hover:bg-surface-600"
                                    onclick={() => onfixissue(issue)}>
                                    {mediaIssueFixLabel(mediaIssueFix(issue))}
                                </button>
                            {/if}
                        </div>
                        {#if issue.detail}
                            <details class="text-xs text-surface-400">
                                <summary>{m.media_plain_technical_details()}</summary>
                                <p class="break-words">{issue.detail}</p>
                            </details>
                        {/if}
                    </div>
                {:else}
                    <p class="text-xs text-surface-400">{m.media_issues_none()}</p>
                {/each}
                <!-- Info notes (Not linked to Jellyfin): muted, not a problem card. -->
                {#each noteIssues(item.issues) as note (note.kind)}
                    <p class="flex items-center gap-2 text-xs text-surface-500">
                        <span>{mediaIssueLabel(note, item.mediaType)}</span>
                        {#if onfixissue}
                            <button
                                type="button"
                                class="text-surface-400 underline hover:text-surface-200"
                                onclick={() => onfixissue(note)}>
                                {mediaIssueFixLabel(mediaIssueFix(note))}
                            </button>
                        {/if}
                    </p>
                {/each}
            </section>
        {/if}
        <!-- Artwork. Deliberately OUTSIDE the loading/error/preview gate
             below: it derives from the row alone, so it has no reason to wait
             on (or disappear during) the preview fetch.

             `alt=""` on purpose. The title sits two lines above in the header
             and the announced summary already names the item, so an alt text
             here would make a screen reader say the title twice for an image
             that carries nothing the title does not.

             `max-h-[min(30dvh,15rem)]` is the cap the panel needs: 15rem
             bounds it on a tall display, and 30dvh makes it SHRINK on a short
             one rather than holding 240px on a 600px-tall window. Actions is
             a sibling inside this same scroll container either way, so the
             cap is about keeping the fields visible without scrolling, not
             about reachability. -->
        {#if artworkUrl && artworkRole}
            {#key artworkKey}
                <img
                    src={artworkUrl}
                    alt=""
                    data-testid="inspector-artwork"
                    data-artwork-role={artworkRole}
                    data-artwork-key={artworkKey}
                    class={artworkShape === 'hero'
                        ? 'block w-full max-h-[min(30dvh,15rem)] rounded object-cover'
                        : 'block w-[120px] max-h-[min(30dvh,15rem)] rounded object-contain'}
                    onerror={(e) => onArtworkError(e.currentTarget as HTMLImageElement)} />
            {/key}
        {/if}
        {#if loading}
            <p class="text-sm text-surface-400">{m.media_plain_loading()}</p>
        {:else if loadError}
            <p class="text-sm text-red-300">{loadError}</p>
        {:else if preview}
            <!-- Identity -->
            <section class="space-y-1">
                <h4 class="text-xs font-semibold uppercase text-surface-500">
                    {m.media_plain_identity()}
                </h4>
                {#if ancestryLine(item, preview)}
                    <p class="text-xs text-surface-400">
                        <span class="text-surface-300">{ancestryLine(item, preview)}</span>
                    </p>
                {/if}
                {#if preview.overview}
                    <p class="text-sm text-surface-300">{preview.overview}</p>
                {/if}
                <!-- Runtime / year / premiere on one line, as the inline
                     preview row had them. Each is independently optional, so
                     the separators are conditional on what precedes them
                     rather than emitted unconditionally. -->
                {#if preview.runtime_seconds || preview.year || preview.premiere_date}
                    <p class="text-xs text-surface-500">
                        {#if preview.runtime_seconds}
                            {m.media_plain_runtime()}:
                            <span class="text-surface-400"
                                >{formatRuntime(preview.runtime_seconds)}</span
                            >{preview.year || preview.premiere_date ? ' · ' : ''}
                        {/if}
                        {#if preview.year}
                            {m.media_plain_year()}:
                            <span class="text-surface-400">{preview.year}</span
                            >{preview.premiere_date ? ' · ' : ''}
                        {/if}
                        {#if preview.premiere_date}
                            {m.media_plain_premiered()}:
                            <span class="text-surface-400"
                                >{formatDate(preview.premiere_date)}</span>
                        {/if}
                    </p>
                {/if}
                {#if externalIdEntriesOf(item, preview).length > 0}
                    <details>
                        <summary class="text-xs text-surface-400"
                            >{m.media_plain_online_records()}</summary>
                        <p
                            class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-surface-500">
                            {#each externalIdEntriesOf(item, preview) as ext (ext.label)}
                                <span>
                                    {ext.label}:
                                    {#if ext.href}
                                        <a
                                            href={ext.href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            class="select-all font-mono text-primary-400 underline decoration-dotted underline-offset-2 hover:text-primary-300"
                                            >{ext.value}</a>
                                    {:else}
                                        <span class="select-all font-mono text-surface-400"
                                            >{ext.value}</span>
                                    {/if}
                                </span>
                            {/each}
                        </p>
                    </details>
                {/if}
                <!-- Music only. `audioFeatures` is derived from
                     `custom_metadata.essentia`, which the audio pipeline
                     writes and nothing else does — but the query emits the
                     field on type alone, so a non-music item that ever
                     acquired an `essentia` key (a bad import, a plugin) would
                     otherwise render a BPM row on a film. -->
                {#if isMusicType(item.mediaType) && preview.audioFeatures}
                    <p class="text-xs text-surface-500">
                        {#if preview.audioFeatures.bpm}
                            BPM: <span class="text-surface-400">{preview.audioFeatures.bpm}</span>
                        {/if}
                        {#if preview.audioFeatures.key}
                            {preview.audioFeatures.bpm ? ' · ' : ''}{m.media_plain_key()}:
                            <span class="text-surface-400">{preview.audioFeatures.key}</span>
                        {/if}
                        {#if preview.audioFeatures.energy}
                            {preview.audioFeatures.bpm || preview.audioFeatures.key ? ' · ' : ''}
                            Energy:
                            <span class="text-surface-400">{preview.audioFeatures.energy}</span>
                        {/if}
                    </p>
                {/if}
                <!-- Per-season fill, not just a season COUNT. This is the
                     detail an operator opens a series for ("which season is
                     missing files"), and hiding it behind a disclosure on a
                     surface that exists to show more would be perverse.
                     `max-h-40` is the compromise: the block scrolls in place
                     from roughly the sixth season on, so a 40-season series
                     cannot push Actions off the bottom of the panel. -->
                {#if isSeries(item.mediaType) && preview.seasons && preview.seasons.length > 0}
                    <div class="space-y-0.5 pt-1">
                        <p class="text-xs text-surface-400">
                            {m.admin_library_season_count({ count: preview.seasons.length })}
                        </p>
                        <div class="max-h-40 space-y-0.5 overflow-y-auto pr-1">
                            {#each preview.seasons as season, seasonIdx (season.seasonNumber + '-' + seasonIdx)}
                                <p class="font-mono text-xs text-surface-500">
                                    {season.seasonNumber === 0
                                        ? m.media_plain_specials()
                                        : m.media_plain_season({ number: season.seasonNumber })}:
                                    <span class="text-surface-400"
                                        >{m.media_plain_episodes({
                                            count: season.episodeCount,
                                        })}</span>
                                    <span
                                        class={seasonFillClass(
                                            season.episodeCount,
                                            season.linkedCount,
                                        )}
                                        >({m.media_plain_linked({ count: season.linkedCount })} — {seasonFillLabel(
                                            season.episodeCount,
                                            season.linkedCount,
                                        )})</span>
                                </p>
                            {/each}
                        </div>
                    </div>
                {/if}
            </section>

            <!-- State -->
            <section class="space-y-1">
                <h4 class="text-xs font-semibold uppercase text-surface-500">
                    {m.media_plain_state()}
                </h4>
                <p class="text-xs text-surface-400">
                    {m.media_plain_files()}:
                    <span class="text-surface-300">{preview.fileCount}</span>
                    {#if preview.totalFileSize}
                        <span class="text-surface-300">({formatBytes(preview.totalFileSize)})</span>
                    {/if}
                </p>
                {#if resolutionLabel(preview) || preview.videoCodec}
                    <p class="text-xs text-surface-400">
                        {#if resolutionLabel(preview)}{resolutionLabel(preview)}{/if}
                        {#if preview.videoCodec}
                            {resolutionLabel(preview) ? ' · ' : ''}<span class="text-surface-300"
                                >{preview.videoCodec}</span>
                        {/if}
                        {#if preview.videoRange}
                            · {preview.videoRange}
                        {/if}
                    </p>
                {/if}
                {#if preview.audioCodec}
                    <p class="text-xs text-surface-400">
                        {m.media_plain_audio()}:
                        <span class="text-surface-300">{preview.audioCodec}</span>
                        {#if preview.audioChannels}({preview.audioChannels}ch){/if}
                    </p>
                {/if}
                <p class="text-xs text-surface-400">
                    {m.media_plain_availability()}:
                    <span class="text-surface-300"
                        >{item.hasFiles
                            ? m.media_plain_available()
                            : m.media_plain_unavailable()}</span>
                    {#if preview.isLocalOnly}({m.media_plain_local_only()}){/if}
                    {#if preview.filesLostAt}
                        — {m.media_plain_lost()} {formatDateTime(preview.filesLostAt)}
                    {/if}
                </p>
                <p class="text-xs text-surface-400">
                    {m.media_plain_updates()}:
                    <span class="text-surface-300"
                        >{preview.metadataLocked
                            ? m.media_plain_locked()
                            : m.media_plain_unlocked()}</span>
                    {#if preview.metadataLocked && preview.lockedBy}
                        {m.media_plain_edited_by()} {preview.lockedBy}
                    {/if}
                    {#if preview.metadataLocked && preview.lockedAt}
                        ({formatDateTime(preview.lockedAt)})
                    {/if}
                </p>
                {#if preview.lastProbedAt}
                    <p class="text-xs text-surface-400">
                        {m.media_plain_last_checked()}:
                        <span class="text-surface-300">{formatDateTime(preview.lastProbedAt)}</span>
                    </p>
                {/if}
                {#if preview.lastUpdatedAt}
                    <p class="text-xs text-surface-400">
                        {m.media_plain_last_updated()}:
                        <span class="text-surface-300"
                            >{formatDateTime(preview.lastUpdatedAt)}</span>
                    </p>
                {/if}
            </section>

            {#if preview.healthStatus}<section class="space-y-1">
                    <h4 class="text-xs font-semibold uppercase text-surface-500">
                        {m.media_plain_coverage()}
                    </h4>
                    <p class="text-xs text-surface-400">
                        <span class="text-surface-300"
                            >{preview.healthStatus === 'healthy'
                                ? m.media_plain_coverage_complete()
                                : preview.healthStatus === 'unknown'
                                  ? m.media_plain_coverage_unknown()
                                  : preview.healthStatus === 'mismatch'
                                    ? m.media_plain_coverage_conflict()
                                    : m.media_plain_coverage_incomplete()}</span>
                    </p>
                </section>{/if}
            <!-- Health, verbatim -->
            <section class="space-y-1">
                <h4 class="text-xs font-semibold uppercase text-surface-500">
                    {m.media_plain_file_findings()}
                </h4>
                {#if preview.healthIssues && preview.healthIssues.length > 0}
                    <ul class="space-y-1">
                        {#each preview.healthIssues as issue, issueIdx (issue.type + '-' + issueIdx)}
                            <li class={fileHealthIssueTextClass(issue.type, issue.basis)}>
                                <span class="font-medium"
                                    >{issue.reviewed
                                        ? m.admin_health_review_classification()
                                        : fileHealthIssueLabel(
                                              issue.type,
                                              issue.basis,
                                          )}{isSevereHealthIssue(issue.type, issue.basis)
                                        ? ` (${m.media_plain_severe()})`
                                        : ''}</span>
                                {#if healthIssueReason(issue)}
                                    <details class="text-xs text-surface-400">
                                        <summary>{m.media_plain_technical_details()}</summary
                                        >{healthIssueReason(issue)}
                                    </details>
                                {/if}
                                {#if fileHealthIssueGuidance(issue)}
                                    <span class="block text-surface-400">
                                        {fileHealthIssueGuidance(issue)}
                                    </span>
                                {/if}
                                {#if issue.filePath}
                                    <span class="block truncate font-mono text-surface-500"
                                        >{issue.filePath}</span>
                                {/if}
                            </li>
                        {/each}
                    </ul>
                    {#if preview.healthIssuesOmitted}
                        <p class="text-xs text-surface-400">
                            {m.media_plain_more_findings({ count: preview.healthIssuesOmitted })}
                        </p>
                    {/if}
                {:else}
                    <p class="text-xs text-surface-500">{m.media_plain_no_file_findings()}</p>
                {/if}
            </section>

            {#each preview.tailAssessments ?? [] as tail (tail.fileId)}
                <AudioTailDiagnosis assessment={tail.assessment} />
            {/each}
            <!-- Files -->
            {#if preview.filePaths.length > 0}
                <section class="space-y-1">
                    <h4 class="text-xs font-semibold uppercase text-surface-500">
                        {m.media_plain_files()}
                    </h4>
                    {#each preview.filePaths as path, pathIdx (path + '-' + pathIdx)}
                        <p class="truncate font-mono text-xs text-surface-500">{path}</p>
                    {/each}
                </section>
            {/if}

            <!-- Actions -->
            {#if actions.length > 0}
                <section class="space-y-2 border-t border-surface-700 pt-3">
                    <h4 class="text-xs font-semibold uppercase text-surface-500">
                        {m.media_plain_actions()}
                    </h4>
                    {#if safeActions.length > 0}
                        <div class="flex flex-wrap gap-2">
                            {#each safeActions as action (action.id)}
                                <button
                                    type="button"
                                    onclick={() => onaction(action.id)}
                                    class="rounded border border-surface-600 bg-surface-700 px-2.5 py-1 text-xs text-surface-300 hover:bg-surface-600">
                                    {mediaActionLabel(action.id)}
                                </button>
                            {/each}
                        </div>
                    {/if}
                    {#if destructiveActions.length > 0}
                        <div
                            class="mt-4 flex flex-wrap items-center gap-2 border-t border-red-900/40 pt-3"
                            data-testid="inspector-danger-actions">
                            <span class="mr-auto text-xs font-semibold uppercase text-red-400/80"
                                >{m.media_plain_danger()}</span>
                            {#each destructiveActions as action (action.id)}
                                <button
                                    type="button"
                                    onclick={() => onaction(action.id)}
                                    class="rounded border border-red-700/60 bg-red-900/30 px-2.5 py-1 text-xs font-medium text-red-200 hover:bg-red-800/50 hover:text-white">
                                    {mediaActionLabel(action.id)}
                                </button>
                            {/each}
                        </div>
                    {/if}
                </section>
            {/if}
        {/if}
    </div>
{/snippet}

{#if docked}
    <!-- Docked: plain flex sibling. No backdrop, no focus trap, no dialog
         role, no keydown interception — the table beside it must stay fully
         interactive and Escape has no reason to dismiss a non-modal panel.

         STICKY, not static. The whole point of the non-modal presentation is
         that the operator can arrow-walk the list and watch the panel follow;
         a statically positioned panel scrolls off the top long before a real
         catalogue page (50 rows) is walked to the end, so the panel they are
         walking WITH leaves the screen. Measured before the fix: at
         scrollY 1400 the panel's top was -350 beside a 1280px-tall table.

         `position: sticky` is silently inert if any ancestor between here and
         the scroll container clips overflow, so the chain was walked rather
         than assumed. The scroll container is `main.main-content`
         (`overflow-y: auto`, `max-height: 100dvh` at >=1024px; `html, body`
         are `overflow: hidden` there, so the DOCUMENT does not scroll).
         Between this element and it: the media page's
         `.flex.items-start.gap-4`, `#domain-tabpanel`, `.admin-content`,
         `.admin-body`, `.container`, `.admin-page` — none set `overflow`,
         `transform`, `filter` or `contain`.

         `top-20` (5rem) clears the fixed `.navbar` chrome from app.html,
         matching the `lg:pt-20` the admin shell already uses for the same
         clearance. The parent's `items-start` is LOAD-BEARING: it keeps this
         panel at content height inside a container as tall as the table, which
         is the room a sticky element needs to travel. Under the default
         `items-stretch` it would fill the container and never move.

         `max-h` + `overflow-hidden` bound the panel to the viewport so a long
         one scrolls in its own body (`flex-1 overflow-y-auto` in
         `panelContent`) instead of growing the page. -->
    <div
        class="sticky top-20 flex max-h-[calc(100dvh-6rem)] w-[420px] shrink-0 flex-col overflow-hidden border-l border-surface-700 bg-surface-800">
        {@render panelContent()}
    </div>
{:else}
    <div
        class="fixed inset-0 bg-black/50"
        style="z-index: {Z.MODAL}"
        onclick={onclose}
        role="presentation"
        tabindex="-1">
    </div>
    <div
        style="z-index: {Z.MODAL + 1}"
        class="fixed right-0 top-0 bottom-0 flex w-[480px] max-w-full flex-col border-l border-surface-700 bg-surface-800"
        role="dialog"
        aria-modal="true"
        aria-label={m.media_plain_inspector()}
        tabindex="-1"
        use:trapFocus
        onkeydown={handleKeydown}>
        {@render panelContent()}
    </div>
{/if}
