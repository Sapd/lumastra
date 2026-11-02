<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  AudiobookFullScreen — the real player.

  New, not extracted: `FullScreenPlayer.svelte` is 1481 lines / 116 store
  references of music-shaped UI (queue, alchemy, mood, radio).

  ## Two scrubbers, and why only one of them is interactive

      ────────────────────────────────────────   whole book: thin, NOT interactive
              ▲                                  where you are
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   current chapter: drag to seek
         Kapitel 12 · 04:12 / 18:40

  On a 20-hour book a full-width mobile bar is ~4 minutes per pixel: useless for
  precision, and psychologically flat — an hour of listening moves it by two
  pixels. The chapter-scoped bar gives real precision, visible progress, and
  bounds a mis-tap to one chapter instead of the whole book. Losing your place
  in a 20-hour book is the worst failure this player has, because the bad
  position PROPAGATES (AudiobookShelf's progress row is last-write-wins with no
  history).

  The book-scale bar is deliberately not draggable and deliberately not a
  preference. If whole-book scrubbing is ever wanted it is a tap-to-expand.
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import {
        Icon,
        Play,
        Pause,
        ChevronDown,
        Backward,
        Forward,
        ListBullet,
        Moon,
        Check,
        SpeakerWave,
        SpeakerXMark,
    } from 'svelte-hero-icons';
    import { fly } from 'svelte/transition';
    import { Z } from '$lib/utils/z-index';
    import {
        audiobookPlayerStore,
        SKIP_BACK_MS,
        SKIP_FORWARD_MS,
    } from '$lib/stores/audiobook-player.store';
    import {
        audiobookFullScreenOpen,
        cancelSleepTimer,
        setSleepTimerEndOfChapter,
        setSleepTimerMinutes,
        sleepTimer,
        sleepTimerRemainingMs,
    } from '$lib/stores/audiobook-ui';
    import { page } from '$app/stores';
    import {
        applyVolumeCurve,
        inverseVolumeCurve,
        isVolumeCurve,
    } from '$lib/components/player/volume-control';
    import MusicChapterSheet from '$lib/components/music/MusicChapterSheet.svelte';
    import { formatChapterTime } from '$lib/utils/music-chapters';
    import {
        chapterTitlesAreUninformative,
        formatChapterLabels,
    } from '$lib/utils/audiobook-timeline';
    import type { TrackChapter as MusicChapter } from '$lib/schemas/api-music-dto';
    import { getSocialWatchActivity } from '$lib/api/integrations';
    import type { SocialActivityItem } from '$lib/schemas/api-media-responses';
    import { sampleImageAccent, type ArtworkAccent } from '$lib/utils/artwork-accent';
    import Avatar from '$lib/components/ui/Avatar.svelte';

    // NOT `state`: a local binding named `state` shadows the `$state` rune, so
    // `$state(false)` below parsed as a store subscription on this variable
    // ("Cannot use 'state' as a store") rather than as a rune call.
    const playerState = $derived($audiobookPlayerStore);
    const open = $derived($audiobookFullScreenOpen && playerState.book !== null);

    const volumeCurve = $derived.by(() => {
        const configValue = $page.data?.player?.volumeCurve;
        return isVolumeCurve(configValue) ? configValue : 'linear';
    });

    let chapterSheetOpen = $state(false);
    let speedOpen = $state(false);
    let sleepOpen = $state(false);
    let socialActivities = $state<SocialActivityItem[]>([]);
    let socialRequestGeneration = 0;

    const SOCIAL_REFRESH_MS = 5 * 60_000;

    /**
     * While dragging, the bar follows the pointer instead of the store.
     *
     * Without this the thumb snaps back on every `timeupdate` for the whole
     * drag, because the store's position is still where playback is.
     */
    let dragChapterMs = $state<number | null>(null);

    const chapterDuration = $derived(playerState.chapterDurationMs);
    const chapterPosition = $derived(dragChapterMs ?? playerState.chapterPositionMs);
    const chapterFraction = $derived(
        chapterDuration > 0 ? Math.min(1, Math.max(0, chapterPosition / chapterDuration)) : 0,
    );
    const bookFraction = $derived(
        playerState.durationMs > 0
            ? Math.min(1, Math.max(0, playerState.bookPositionMs / playerState.durationMs))
            : 0,
    );
    // The two cases are split rather than folded into one ternary chain so the
    // no-position branch narrows `positionMs` for the arithmetic below — the
    // combined form left it `number | undefined` at the division.
    const socialMarkers = $derived.by(() =>
        socialActivities.flatMap((activity) => {
            const positionMs = activity.positionMs;
            if (positionMs === undefined) {
                if (activity.recentlyFinished !== true) return [];
                return [
                    {
                        ...activity,
                        fraction: 1,
                        completedAtEnd: true,
                        label: activity.description,
                    },
                ];
            }
            const durationMs = activity.durationMs ?? playerState.durationMs;
            if (durationMs <= 0) return [];
            const fraction = Math.min(1, Math.max(0, positionMs / durationMs));
            return [
                {
                    ...activity,
                    fraction,
                    completedAtEnd: false,
                    // `displayName`, not the raw login: this string is both the
                    // hover tooltip and the slider's spoken summary.
                    label: `${(activity.author.displayName ?? m.social_someone())} — ${activity.chapterTitle ?? `${Math.round(fraction * 100)}% through the book`}`,
                },
            ];
        }),
    );
    const socialMarkerSummary = $derived(
        socialMarkers.length > 0
            ? `. Other listeners: ${socialMarkers.map((marker) => marker.label).join('; ')}`
            : '',
    );

    $effect(() => {
        const mediaId = playerState.mediaId;
        if (!open || !mediaId) {
            socialActivities = [];
            return;
        }

        const generation = ++socialRequestGeneration;
        const load = async () => {
            try {
                const result = await getSocialWatchActivity(mediaId);
                if (generation === socialRequestGeneration) {
                    socialActivities = result.data?.activities ?? [];
                }
            } catch {
                if (generation === socialRequestGeneration) socialActivities = [];
            }
        };

        void load();
        const interval = window.setInterval(load, SOCIAL_REFRESH_MS);
        return () => {
            socialRequestGeneration += 1;
            window.clearInterval(interval);
        };
    });

    /**
     * The chapter sheet's shape. Note the position handed to it is BOOK time —
     * the sheet takes whatever clock its caller holds, and an audiobook's is not
     * the backend's file time.
     *
     * Titles pass through {@link formatChapterLabels} for DISPLAY ONLY —
     * `startMs`/`endMs` below are still the timeline's own untouched spans,
     * so the sheet's seek-on-tap and active-chapter highlight key off exactly
     * what `findChapterAt` uses. `MusicChapterSheet` (shared with the music
     * player) has no dedicated "raw title" slot, so the untouched upstream
     * title rides along in `artist` — its existing subtitle line — but only
     * when the label actually changed, so an already-clean book shows nothing
     * extra there.
     */
    const chapterLabels = $derived.by(() => {
        const chapters = playerState.timeline?.chapters ?? [];
        // The untagged-tail span is excluded from the cleanup pass and re-added
        // verbatim. `formatChapterLabels` strips the prefix EVERY title shares,
        // and one foreign label ("Nach dem letzten Kapitel") among 555 uniform
        // ones collapses that shared prefix to nothing — which would put the
        // whole repeated book title back on all 555 rows. Its own title is
        // already localised by the store, so there is nothing to clean up.
        const tail = chapters.length > 0 && chapters[chapters.length - 1].untagged;
        const cleanable = tail ? chapters.slice(0, -1) : chapters;
        const labels = formatChapterLabels(cleanable.map((c) => c.title));
        if (tail) {
            const raw = chapters[chapters.length - 1].title;
            labels.push({ display: raw, raw });
        }
        return labels;
    });
    const hasUntaggedTail = $derived(
        (playerState.timeline?.chapters ?? []).at(-1)?.untagged === true,
    );
    /**
     * True when the titles are nothing but their own ordinals.
     *
     * A book split into 555 equal files carries no chapter names — after the
     * shared prefix is stripped every entry is `001`, `002`, … which the list
     * already prints in its number column. The start time is then the only
     * thing that distinguishes one row from another, so it becomes the label.
     */
    const chapterTitlesUseless = $derived(
        chapterTitlesAreUninformative(
            // Same exclusion, same reason: the tail's label is a sentence, so
            // counting it would make "every title is a bare ordinal" false for
            // exactly the books that need the timestamp fallback most.
            hasUntaggedTail ? chapterLabels.slice(0, -1) : chapterLabels,
        ),
    );
    const sheetChapters = $derived<MusicChapter[]>(
        (playerState.timeline?.chapters ?? []).map((chapter, i) => {
            const label = chapterLabels[i];
            return {
                title: label?.display ?? chapter.title,
                artist: label && label.display !== label.raw ? label.raw : undefined,
                startMs: chapter.startMs,
                endMs: chapter.endMs,
            };
        }),
    );

    const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    const SLEEP_MINUTES = [5, 15, 30, 45, 60];

    /**
     * Derived from the store constants, never typed twice.
     *
     * The seek buttons draw this number inside the arrow. An `↺` with no numeral
     * reads as "undo", which is the wrong promise for the control listeners hit
     * most; a hardcoded "30" would silently lie the day the constant moves.
     */
    const skipBackSeconds = $derived(Math.round(SKIP_BACK_MS / 1000));
    const skipForwardSeconds = $derived(Math.round(SKIP_FORWARD_MS / 1000));

    /**
     * The desktop list reads the TIMELINE, not `sheetChapters`.
     *
     * `MusicChapter` is the sheet's shared shape and its `endMs` is optional,
     * so range maths against it is unsound. The timeline's own spans are the
     * authoritative ones and are always present — the same spans `findChapterAt`
     * keys off, so the highlight cannot disagree with what is playing.
     */
    const chapterRows = $derived(
        (playerState.timeline?.chapters ?? []).map((chapter, i) => ({
            // The tail keeps its own label even when every real title has been
            // replaced by a timestamp — a start time says nothing about what
            // this row IS, and this is the one row that needs to say it.
            title:
                chapterTitlesUseless && !chapter.untagged
                    ? formatChapterTime(chapter.startMs)
                    : (chapterLabels[i]?.display ?? chapter.title),
            startMs: chapter.startMs,
            endMs: chapter.endMs,
        })),
    );

    /**
     * Chapter boundaries drawn on the book rail — but only when they would be
     * distinguishable. 555 chapters over ~1800px is a tick every three pixels:
     * a grey smear that reads as a texture, not as marks. A dozen real chapters
     * is exactly the case where they help.
     */
    const MAX_RAIL_TICKS = 40;
    const railTicks = $derived(
        playerState.durationMs > 0 && chapterRows.length > 1 && chapterRows.length <= MAX_RAIL_TICKS
            ? chapterRows.slice(1).map((chapter) => chapter.startMs / playerState.durationMs)
            : [],
    );

    /**
     * Book-scale clock.
     *
     * `formatChapterTime` drops the hours field below an hour, which put `5:20`
     * next to `-26:46:38` on the same rail — two formats for two halves of one
     * number. On a book that runs hours, both sides use hours.
     */
    function formatBookTime(ms: number): string {
        if (playerState.durationMs < 3_600_000) return formatChapterTime(ms);
        const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }

    /**
     * Is the playing chapter still on screen?
     *
     * With 555 entries, scrolling away from it strands you: there is no other
     * route back. Recomputed on scroll and whenever the chapter changes.
     */
    let activeRowVisible = $state(true);
    function syncActiveRowVisibility(): void {
        const list = chapterListEl;
        if (!list || activeChapterIndex < 0) {
            activeRowVisible = true;
            return;
        }
        const row = list.querySelector<HTMLElement>(`[data-chapter-index="${activeChapterIndex}"]`);
        if (!row) {
            activeRowVisible = true;
            return;
        }
        const top = row.offsetTop - list.scrollTop;
        activeRowVisible = top > -row.offsetHeight && top < list.clientHeight;
    }

    function scrollToActiveChapter(): void {
        chapterListEl
            ?.querySelector<HTMLElement>(`[data-chapter-index="${activeChapterIndex}"]`)
            ?.scrollIntoView({ block: 'center' });
        syncActiveRowVisibility();
    }
    const activeChapterIndex = $derived(
        chapterRows.findIndex(
            (chapter) =>
                playerState.bookPositionMs >= chapter.startMs &&
                playerState.bookPositionMs < chapter.endMs,
        ),
    );

    /**
     * Keep the playing chapter visible in the desktop list.
     *
     * `activeChapterIndex` is a `$derived`, so this re-runs when the chapter
     * CHANGES, not on every position tick. `block: 'nearest'` scrolls only when
     * the row is actually out of view, and jumps rather than animates — a list
     * that glides on its own while you are reading it is worse than one that
     * doesn't move.
     */
    /**
     * The controls take their colour from the cover.
     *
     * Sampled on the image's own `load` (and once on mount, for a cover already
     * in cache — `load` does not re-fire for those). Reset when the book
     * changes so the previous book's colour cannot outlive it for a frame.
     * `null` is a fully supported state: everything falls back to the brand
     * accent, which is what a greyscale jacket or a tainted canvas produces.
     */
    let accent = $state<ArtworkAccent | null>(null);
    let coverEl = $state<HTMLImageElement | null>(null);

    function readAccent(): void {
        accent = coverEl ? sampleImageAccent(coverEl) : null;
    }

    $effect(() => {
        // Re-runs when the cover URL changes; the read is what arms the
        // dependency, so keep it before the early return.
        const url = playerState.book?.images.primary?.href;
        const image = coverEl;
        if (!url || !image) {
            accent = null;
            return;
        }
        readAccent();
    });

    // ── Keyboard ──────────────────────────────────────────────────────────
    //
    // Same vocabulary as the video player (`video-input.ts`): space/k toggles,
    // arrows and j/l seek. Escape closes, which a `role="dialog"` owes anyone
    // who opened it.
    //
    // Bound to `window` rather than the dialog: the listener has to work
    // without the listener first having clicked something, and focus after
    // opening the player sits wherever the trigger left it.

    /**
     * Controls that own the keystroke themselves.
     *
     * A focused button already activates on space — handling it here too would
     * fire the button AND toggle playback. The chapter scrubber is a `slider`
     * with its own arrow handling at its own 10 s step, which is the ARIA
     * behaviour for a focused slider and must win over the transport's 30 s.
     */
    function ownsKeystroke(target: EventTarget | null, key: string): boolean {
        const el = target as HTMLElement | null;
        if (!el?.closest) return false;
        if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
        if (key === ' ') return el.closest('button, a[href], [role="menu"]') !== null;
        return el.closest('[role="slider"], [role="menu"]') !== null;
    }

    function onPlayerKeydown(event: KeyboardEvent): void {
        // A modifier means the browser's own shortcut (⌘← is Back, ⌘Space is
        // Spotlight). Never shadow those.
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        // Something nearer the event already claimed this key.
        if (event.defaultPrevented) return;
        if (ownsKeystroke(event.target, event.key)) return;

        switch (event.key) {
            case ' ':
            case 'k':
                event.preventDefault();
                if (playerState.isPlaying) audiobookPlayerStore.pause();
                else void audiobookPlayerStore.resume();
                return;
            case 'ArrowLeft':
            case 'j':
                event.preventDefault();
                void audiobookPlayerStore.skipBy(-SKIP_BACK_MS);
                return;
            case 'ArrowRight':
            case 'l':
                event.preventDefault();
                void audiobookPlayerStore.skipBy(SKIP_FORWARD_MS);
                return;
            case 'Escape':
                event.preventDefault();
                audiobookFullScreenOpen.set(false);
                return;
            default:
        }
    }

    $effect(() => {
        if (!open) return;
        window.addEventListener('keydown', onPlayerKeydown);
        return () => window.removeEventListener('keydown', onPlayerKeydown);
    });

    // ── Swipe down to minimise ────────────────────────────────────────────
    //
    // Same gesture and thresholds as the music full-screen player, so the two
    // players feel like one app. What differs is what has to be excluded: this
    // screen has a pointer-captured chapter scrubber (`touch-none`, so touch
    // events still reach us) and a scrolling chapter list. A dismiss gesture
    // starting on either would fight the control the finger is actually on.
    const SWIPE_CLOSE_THRESHOLD = 80;
    const SWIPE_AXIS_LOCK = 10;
    /** Selector for "this element owns the gesture, not the sheet". */
    const SWIPE_EXCLUDED = '[role="slider"], [data-testid="audiobook-chapter-list"], button';

    let swipeStartY = 0;
    let swipeStartX = 0;
    let swipeBlocked = false;
    let swipeDeltaY = $state(0);
    let isDraggingDown = $state(false);

    /**
     * Rubber-banding: the sheet follows the finger 1:1 for the first 80px — the
     * distance that commits — then resists. Past the threshold the gesture is
     * already decided, so further travel only needs to acknowledge the finger.
     */
    function swipeTranslate(dy: number): number {
        if (dy <= SWIPE_CLOSE_THRESHOLD) return dy;
        return SWIPE_CLOSE_THRESHOLD + (dy - SWIPE_CLOSE_THRESHOLD) * 0.35;
    }

    function onSwipeStart(event: TouchEvent): void {
        const touch = event.touches[0];
        if (!touch) return;
        swipeBlocked = (event.target as HTMLElement | null)?.closest(SWIPE_EXCLUDED) !== null;
        swipeStartY = touch.clientY;
        swipeStartX = touch.clientX;
        swipeDeltaY = 0;
        isDraggingDown = false;
    }

    function onSwipeMove(event: TouchEvent): void {
        if (swipeBlocked) return;
        const touch = event.touches[0];
        if (!touch) return;
        const dy = touch.clientY - swipeStartY;
        const dx = touch.clientX - swipeStartX;
        if (!isDraggingDown) {
            // Axis lock: nothing commits until the finger has clearly moved,
            // and only a vertical-dominant DOWNWARD move claims the gesture.
            if (Math.abs(dy) < SWIPE_AXIS_LOCK && Math.abs(dx) < SWIPE_AXIS_LOCK) return;
            if (Math.abs(dx) > Math.abs(dy) || dy <= 0) return;
            isDraggingDown = true;
        }
        if (dy > 0) {
            swipeDeltaY = dy;
            if (event.cancelable) event.preventDefault();
        } else {
            swipeDeltaY = 0;
        }
    }

    function onSwipeEnd(): void {
        if (isDraggingDown && swipeDeltaY >= SWIPE_CLOSE_THRESHOLD) {
            audiobookFullScreenOpen.set(false);
        }
        swipeDeltaY = 0;
        isDraggingDown = false;
        swipeBlocked = false;
    }

    let chapterListEl = $state<HTMLElement | null>(null);
    /**
     * The book whose active chapter has already been centred.
     *
     * Keyed rather than a boolean so a new book in the same open session
     * re-centres, and so the two positioning modes can't race on effect order.
     */
    let centredForMediaId: string | null = null;

    $effect(() => {
        const index = activeChapterIndex;
        const list = chapterListEl;
        const mediaId = open ? playerState.mediaId : null;
        if (!mediaId || !list || index < 0) return;
        const row = list.querySelector<HTMLElement>(`[data-chapter-index="${index}"]`);
        if (!row) return;
        // FIRST positioning for this book centres the row. `nearest` alone left
        // someone 80 chapters in staring at chapter 1 — it is a no-op whenever
        // the row is already within the scrollport, which includes the initial
        // scrollTop of 0. Afterwards `nearest` is right: it only moves when the
        // playing chapter has actually left view, so the list does not yank
        // itself away from someone reading ahead.
        row.scrollIntoView({ block: centredForMediaId === mediaId ? 'nearest' : 'center' });
        centredForMediaId = mediaId;
    });

    /**
     * Null when the geometry cannot support a meaningful position.
     *
     * A zero-width rect happens during the open transition and on a hidden tab.
     * Returning 0 there would read as "the listener dragged to the very start of
     * the chapter", which the dwell gate would then have to protect against —
     * a seek nobody asked for.
     */
    function chapterMsFromEvent(event: PointerEvent, element: HTMLElement): number | null {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || chapterDuration <= 0) return null;
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        return ratio * chapterDuration;
    }

    function onScrubStart(event: PointerEvent): void {
        const target = event.currentTarget as HTMLElement;
        const at = chapterMsFromEvent(event, target);
        if (at === null) return;
        target.setPointerCapture?.(event.pointerId);
        dragChapterMs = at;
    }

    function onScrubMove(event: PointerEvent): void {
        if (dragChapterMs === null) return;
        const at = chapterMsFromEvent(event, event.currentTarget as HTMLElement);
        if (at !== null) dragChapterMs = at;
    }

    function onScrubEnd(event: PointerEvent): void {
        if (dragChapterMs === null) return;
        const target = chapterStartMs() + dragChapterMs;
        dragChapterMs = null;
        (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
        void audiobookPlayerStore.seekTo(target, { source: 'seek' });
    }

    /**
     * Abandon the drag WITHOUT seeking.
     *
     * `pointercancel` is not a release — it is the OS taking the pointer away
     * (a back-gesture, a scroll takeover, a lost capture). Treating it like
     * `pointerup`, as an earlier revision did by sharing the handler, commits a
     * seek to wherever the interrupted drag happened to be. In a 20-hour book
     * that is the data-loss bug the dwell gate exists for, triggered by a
     * gesture the listener aborted.
     *
     * `lostpointercapture` is bound to the same handler because it is the only
     * event guaranteed to arrive when the browser drops a captured pointer
     * without delivering up-or-cancel — which on mobile is what happens when the
     * app is backgrounded mid-drag. Without it `dragChapterMs` stays pinned to a
     * stale value and the scrubber silently stops following playback until the
     * next drag.
     */
    function onScrubAbort(event: PointerEvent): void {
        dragChapterMs = null;
        (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    }

    function chapterStartMs(): number {
        return playerState.currentChapter?.startMs ?? 0;
    }

    /**
     * Keyboard scrubbing moves in 10 s steps of BOOK time.
     *
     * Each keypress is its own `seekTo`, so each re-arms the dwell gate — which
     * is correct: holding the arrow key to move five minutes should not be
     * exempt from the protection just because it arrived in small pieces.
     */
    function onScrubKeydown(event: KeyboardEvent): void {
        const step = 10_000;
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            void audiobookPlayerStore.skipBy(step);
        } else if (event.key === 'ArrowLeft') {
            event.preventDefault();
            void audiobookPlayerStore.skipBy(-step);
        }
    }
</script>

<!--
  The seek arrows carry their own numeral.

  A bare `↺` is the undo glyph; on a control the listener hits more than any
  other, "how far does this jump" has to be legible without hovering for a
  tooltip. The seconds come from the store constants, so the drawn number and
  the actual jump cannot drift apart.
-->
{#snippet seekIcon(seconds: number, direction: 'back' | 'forward')}
    <svg viewBox="0 0 24 24" class="h-7 w-7" fill="none" aria-hidden="true">
        <path
            d={direction === 'back' ? 'M12 4a8 8 0 1 1-8 8' : 'M12 4a8 8 0 1 0 8 8'}
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round" />
        <path
            d={direction === 'back' ? 'M12 1.2v5.6L8.4 4Z' : 'M12 1.2v5.6L15.6 4Z'}
            fill="currentColor" />
        <text
            x="12"
            y="15.6"
            text-anchor="middle"
            font-size="8.5"
            font-weight="600"
            fill="currentColor">{seconds}</text>
    </svg>
{/snippet}

{#if open}
    <!-- `tabindex="-1"`: a modal dialog should be programmatically focusable so
         focus can be moved into it, and the Svelte compiler requires it once the
         element carries its own handlers. -1 keeps it out of the tab order. -->
    <div
        class="fixed inset-0 flex flex-col bg-surface-900"
        style="z-index: {Z.MUSIC_FULLSCREEN}; padding-bottom: env(safe-area-inset-bottom);"
        style:transform={swipeDeltaY > 0
            ? `translateY(${swipeTranslate(swipeDeltaY)}px)`
            : undefined}
        transition:fly={{ y: 600, duration: 240 }}
        ontouchstart={onSwipeStart}
        ontouchmove={onSwipeMove}
        ontouchend={onSwipeEnd}
        ontouchcancel={onSwipeEnd}
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        aria-label="Audiobook player">
        <!-- Header -->
        <div class="flex items-center justify-between px-4 py-3">
            <button
                type="button"
                class="flex h-10 w-10 items-center justify-center rounded-full text-surface-300 hover:bg-surface-800 hover:text-white"
                aria-label="Close the player"
                onclick={() => audiobookFullScreenOpen.set(false)}>
                <Icon src={ChevronDown} class="h-6 w-6" />
            </button>
            <!-- The rail shows elapsed and remaining; the TOTAL would be a third
                 number on a hairline. It lives here instead, where the header was
                 otherwise an empty band. -->
            <p class="min-w-0 flex-1 truncate px-3 text-center text-xs text-surface-500">
                {#if playerState.durationMs > 0}
                    {formatBookTime(playerState.durationMs)}
                    {#if chapterRows.length > 1}
                        · {chapterRows.length} chapters
                    {/if}
                {/if}
            </p>
            <button
                type="button"
                class="flex h-10 w-10 items-center justify-center rounded-full text-surface-300 hover:bg-surface-800 hover:text-white lg:hidden"
                aria-label="Chapters"
                onclick={() => (chapterSheetOpen = true)}>
                <Icon src={ListBullet} class="h-5 w-5" />
            </button>
        </div>

        <!-- ── Whole book: thin, non-interactive, and deliberately far from the
             chapter scrubber. Stacked adjacently they read as one control with
             two sets of numbers; at opposite ends of the screen the ambient
             "where am I in the book" rail can't be mistaken for the thing you
             drag. Times flank the bar so each number sits with its own scale.

             Ambient is not the same as invisible. A 2px surface-400 fill on a
             surface-700 track was legible in theory and gone in practice: at
             37 minutes into a 9-hour book the filled part is a few dozen pixels
             of near-background colour. 4px, a light fill and a dimmer track fix
             the contrast without promoting it — the fill stays NEUTRAL while
             the chapter scrubber keeps the artwork accent, so colour is still
             what marks the bar you can actually drag. -->
        <div class="flex items-center gap-3 px-5 py-4">
            <span class="shrink-0 text-[11px] tabular-nums text-surface-400">
                {formatBookTime(playerState.bookPositionMs)}
            </span>
            <div
                class="relative h-1 flex-1 rounded-full bg-surface-600/70"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={Math.round(playerState.durationMs / 1000)}
                aria-valuenow={Math.round(playerState.bookPositionMs / 1000)}
                aria-label="Book progress"
                aria-valuetext="{formatChapterTime(
                    playerState.bookPositionMs,
                )} of {formatChapterTime(playerState.durationMs)}{socialMarkerSummary}">
                {#each railTicks as tick (tick)}
                    <span
                        class="absolute top-0 h-full w-px bg-surface-900/70"
                        style:left="{tick * 100}%"
                        aria-hidden="true">
                    </span>
                {/each}
                <div
                    class="absolute inset-y-0 left-0 rounded-full bg-surface-200"
                    style="width: {bookFraction * 100}%">
                </div>
                {#each socialMarkers as marker (marker.author.userId)}
                    <!-- A real tooltip, not `title`: the native one waits about a
                         second, cannot be styled, and on a 16px circle most people
                         give up before it appears. -->
                    <span
                        class="group absolute top-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
                        style:left={marker.completedAtEnd
                            ? 'calc(100% - 0.5rem)'
                            : `${marker.fraction * 100}%`}
                        aria-hidden="true"
                        data-finished={marker.completedAtEnd ? 'true' : undefined}
                        data-testid="social-listening-marker">
                        <span
                            class="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-surface-600 bg-surface-900/95 px-2 py-1 text-xs text-surface-100 shadow-lg group-hover:block"
                            data-testid="social-listening-tooltip">
                            {marker.label}
                        </span>
                        <Avatar
                            src={marker.author.images.primary.variants?.thumb ?? marker.author.images.primary.href}
                            username={marker.author.displayName ?? m.social_someone()}
                            alt={marker.label}
                            size="2xs"
                            border={marker.completedAtEnd
                                ? 'ring-2 ring-success-400'
                                : 'ring-2 ring-surface-900'} />
                        {#if marker.completedAtEnd}
                            <span
                                class="absolute -bottom-1 -right-1 flex h-3 w-3 items-center justify-center rounded-full bg-success-500 text-white ring-1 ring-surface-900"
                                data-testid="social-listening-complete">
                                <Icon src={Check} class="h-2 w-2" solid />
                            </span>
                        {/if}
                    </span>
                {/each}
            </div>
            <span class="shrink-0 text-[11px] tabular-nums text-surface-400">
                -{formatBookTime(Math.max(0, playerState.durationMs - playerState.bookPositionMs))}
            </span>
        </div>

        <!-- ── Cover + chapters ────────────────────────────────────────────
             `min-h-0` on both the row and the cover column is what lets the
             artwork shrink to the space the controls leave, instead of keeping
             its content height and pushing everything else off.

             Cover, metadata and controls are ONE column so they share one
             centre. The chapter list is a full-height sidebar next to them, not
             a third of the row that stops where the artwork does — for a
             20-hour book that list is the real navigation, and it was hidden
             behind an icon while the space sat empty. -->
        <div
            class="flex min-h-0 flex-1 gap-6 px-6 pb-4 lg:mx-auto lg:w-full lg:max-w-5xl lg:gap-10">
            <div class="relative flex min-h-0 min-w-0 flex-1 flex-col items-center gap-4">
                <!-- Ambient wash from the artwork. Behind everything, alpha
                     fixed at 0.12 by the sampler, and `hidden` from assistive
                     tech because it carries no information — it is the reason
                     the screen feels like this book rather than any book. -->
                {#if accent}
                    <div
                        class="pointer-events-none absolute inset-x-0 top-0 h-2/3 blur-3xl"
                        style:background="radial-gradient(60% 60% at 50% 40%, {accent.wash},
                        transparent 70%)"
                        aria-hidden="true">
                    </div>
                {/if}
                {#if playerState.book?.images.primary?.href}
                    <!-- drop-shadow, NOT shadow: `flex-1` grows this element to
                         fill the column while `object-contain` letterboxes the
                         artwork inside it, so a box-shadow traces the tall BOX and
                         floats far above and below a square cover. drop-shadow is
                         a filter — it follows the painted pixels, so it hugs the
                         artwork at any aspect ratio. -->
                    <img
                        bind:this={coverEl}
                        onload={readAccent}
                        src={playerState.book.images.primary?.href}
                        alt=""
                        class="relative min-h-0 w-auto max-w-full flex-1 rounded-lg object-contain drop-shadow-2xl" />
                {:else}
                    <div class="aspect-square w-full max-w-xs rounded-lg bg-surface-800"></div>
                {/if}
                <!-- Title, author and narrator are one fact about one book, so
                     they sit together. The author used to live in the header, a
                     full screen away from the title. -->
                <div class="relative w-full max-w-md text-center">
                    <h1 class="truncate text-lg font-semibold text-white">
                        {playerState.book?.title ?? ''}
                    </h1>
                    {#if playerState.book?.author || playerState.book?.narrator}
                        <p class="truncate text-sm text-surface-400">
                            {playerState.book?.author ?? ''}{playerState.book?.author &&
                            playerState.book?.narrator
                                ? ' · '
                                : ''}{playerState.book?.narrator
                                ? `Read by ${playerState.book.narrator}`
                                : ''}
                        </p>
                    {/if}
                </div>
                <!-- Metadata and controls share ONE centre with the artwork.
                     They lived in a screen-centred footer while the title was
                     centred on this column, so the title visibly sat left of
                     the scrubber beneath it. The bounded width also keeps the
                     scrubber a sane drag target on a wide window. -->
                <div class="relative w-full max-w-lg shrink-0">
                    <!-- ── Current chapter: interactive ────────────────────────────── -->
                    <div
                        class="-my-2 cursor-pointer py-2 touch-none"
                        role="slider"
                        tabindex="0"
                        aria-label="Seek within the chapter"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(chapterDuration / 1000)}
                        aria-valuenow={Math.round(chapterPosition / 1000)}
                        aria-valuetext="{formatChapterTime(chapterPosition)} of {formatChapterTime(
                            chapterDuration,
                        )}"
                        onpointerdown={onScrubStart}
                        onpointermove={onScrubMove}
                        onpointerup={onScrubEnd}
                        onpointercancel={onScrubAbort}
                        onlostpointercapture={onScrubAbort}
                        onkeydown={onScrubKeydown}>
                        <div class="relative h-1.5 w-full rounded-full bg-surface-700">
                            <div
                                class="absolute inset-y-0 left-0 rounded-full bg-primary-500"
                                style:background-color={accent?.tint}
                                style="width: {chapterFraction * 100}%">
                            </div>
                            <div
                                class="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
                                style="left: {chapterFraction * 100}%">
                            </div>
                        </div>
                    </div>

                    <div class="mt-2 flex items-baseline justify-between text-xs text-surface-400">
                        <span class="min-w-0 truncate">
                            {playerState.currentChapter?.title ?? ''}
                        </span>
                        <span class="shrink-0 tabular-nums">
                            {formatChapterTime(chapterPosition)} / {formatChapterTime(
                                chapterDuration,
                            )}
                        </span>
                    </div>

                    {#if playerState.pendingUndo}
                        <div
                            class="mt-3 flex items-center gap-2 rounded-lg bg-surface-800 px-3 py-2 text-xs text-surface-100">
                            <span class="min-w-0 flex-1 truncate">
                                Jumped to {formatChapterTime(playerState.pendingUndo.toMs)}
                            </span>
                            <button
                                type="button"
                                class="shrink-0 rounded px-2 py-0.5 font-semibold text-primary-300 hover:bg-surface-700"
                                onclick={() => void audiobookPlayerStore.undoSeek()}>
                                Undo
                            </button>
                        </div>
                    {/if}

                    <!-- Transport: centred as its own row. Speed + sleep timer get
                     a separate row below so they never have to squeeze into a
                     narrow leftover column beside the transport buttons on
                     small screens (that used to clip the sleep button off the
                     edge of the viewport). -->
                    <div class="mt-5 flex items-center justify-center gap-2">
                        <div class="flex items-center justify-center gap-4">
                            <button
                                type="button"
                                class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-800 hover:text-white"
                                aria-label="Previous chapter"
                                onclick={() => void audiobookPlayerStore.skipChapter(-1)}>
                                <Icon src={Backward} class="h-5 w-5" solid />
                            </button>
                            <button
                                type="button"
                                class="flex h-12 w-12 items-center justify-center rounded-full text-surface-200 hover:bg-surface-800 hover:text-white"
                                aria-label="Back {skipBackSeconds} seconds"
                                onclick={() => void audiobookPlayerStore.skipBy(-SKIP_BACK_MS)}>
                                {@render seekIcon(skipBackSeconds, 'back')}
                            </button>
                            <button
                                type="button"
                                data-testid="audiobook-fullscreen-toggle"
                                class="flex h-16 w-16 items-center justify-center rounded-full bg-primary-500 text-white hover:bg-primary-400"
                                style:background-color={accent?.fill}
                                aria-label={playerState.isPlaying ? 'Pause' : 'Play'}
                                onclick={() =>
                                    playerState.isPlaying
                                        ? audiobookPlayerStore.pause()
                                        : void audiobookPlayerStore.resume()}>
                                <Icon
                                    src={playerState.isPlaying ? Pause : Play}
                                    class="h-7 w-7"
                                    solid />
                            </button>
                            <button
                                type="button"
                                class="flex h-12 w-12 items-center justify-center rounded-full text-surface-200 hover:bg-surface-800 hover:text-white"
                                aria-label="Forward {skipForwardSeconds} seconds"
                                onclick={() => void audiobookPlayerStore.skipBy(SKIP_FORWARD_MS)}>
                                {@render seekIcon(skipForwardSeconds, 'forward')}
                            </button>
                            <button
                                type="button"
                                class="flex h-11 w-11 items-center justify-center rounded-full text-surface-300 hover:bg-surface-800 hover:text-white"
                                aria-label="Next chapter"
                                onclick={() => void audiobookPlayerStore.skipChapter(1)}>
                                <Icon src={Forward} class="h-5 w-5" solid />
                            </button>
                        </div>
                    </div>

                    <!-- Speed + sleep timer: own row so they always have the
                     full container width and never clip on narrow screens. -->
                    <div class="mt-3 flex items-center justify-center gap-2">
                        <div class="relative">
                            <button
                                type="button"
                                data-testid="audiobook-speed"
                                class="rounded-full bg-surface-800 px-3 py-1.5 text-xs font-semibold text-surface-100 hover:bg-surface-700"
                                aria-haspopup="menu"
                                aria-expanded={speedOpen}
                                onclick={() => (speedOpen = !speedOpen)}>
                                {playerState.playbackRate}×
                            </button>
                            {#if speedOpen}
                                <div
                                    role="menu"
                                    class="absolute bottom-full right-0 mb-2 flex flex-col rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl">
                                    {#each SPEEDS as speed (speed)}
                                        <button
                                            type="button"
                                            role="menuitemradio"
                                            aria-checked={playerState.playbackRate === speed}
                                            class="px-4 py-1.5 text-left text-xs {playerState.playbackRate ===
                                            speed
                                                ? 'text-primary-300'
                                                : 'text-surface-200 hover:bg-surface-700'}"
                                            onclick={() => {
                                                audiobookPlayerStore.setPlaybackRate(speed);
                                                speedOpen = false;
                                            }}>
                                            {speed}×
                                        </button>
                                    {/each}
                                </div>
                            {/if}
                        </div>

                        <div class="relative">
                            <button
                                type="button"
                                data-testid="audiobook-sleep"
                                class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold hover:bg-surface-700 {$sleepTimer.kind !==
                                'off'
                                    ? 'bg-surface-700 text-white ring-1 ring-inset ring-surface-500'
                                    : 'bg-surface-800 text-surface-100'}"
                                aria-haspopup="menu"
                                aria-expanded={sleepOpen}
                                onclick={() => (sleepOpen = !sleepOpen)}>
                                <Icon src={Moon} class="h-4 w-4" />
                                {#if $sleepTimer.kind === 'duration' && $sleepTimerRemainingMs !== null}
                                    <span class="tabular-nums">
                                        {formatChapterTime($sleepTimerRemainingMs)}
                                    </span>
                                {:else if $sleepTimer.kind === 'end_of_chapter'}
                                    <span>Chapter</span>
                                {/if}
                            </button>
                            {#if sleepOpen}
                                <div
                                    role="menu"
                                    class="absolute bottom-full right-0 mb-2 flex flex-col rounded-lg border border-surface-700 bg-surface-800 py-1 shadow-xl">
                                    {#each SLEEP_MINUTES as minutes (minutes)}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            class="whitespace-nowrap px-4 py-1.5 text-left text-xs text-surface-200 hover:bg-surface-700"
                                            onclick={() => {
                                                setSleepTimerMinutes(minutes);
                                                sleepOpen = false;
                                            }}>
                                            {minutes} min
                                        </button>
                                    {/each}
                                    <button
                                        type="button"
                                        role="menuitem"
                                        class="whitespace-nowrap px-4 py-1.5 text-left text-xs text-surface-200 hover:bg-surface-700"
                                        onclick={() => {
                                            setSleepTimerEndOfChapter();
                                            sleepOpen = false;
                                        }}>
                                        End of chapter
                                    </button>
                                    {#if $sleepTimer.kind !== 'off'}
                                        <button
                                            type="button"
                                            role="menuitem"
                                            class="whitespace-nowrap px-4 py-1.5 text-left text-xs text-error-300 hover:bg-surface-700"
                                            onclick={() => {
                                                cancelSleepTimer();
                                                sleepOpen = false;
                                            }}>
                                            Cancel timer
                                        </button>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                    </div>

                    <!-- Volume row: hidden on iOS/devices where browser can't
                         control volume — same reasoning and gate the music
                         full-screen player already uses for its own row. -->
                    {#if playerState.supportsVolumeControl}
                        <div class="mt-3 flex items-center gap-3">
                            <button
                                type="button"
                                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-surface-300 hover:bg-surface-800 hover:text-white"
                                aria-label={playerState.isMuted ? 'Unmute' : 'Mute'}
                                onclick={() => audiobookPlayerStore.toggleMute()}>
                                <Icon
                                    src={playerState.isMuted ? SpeakerXMark : SpeakerWave}
                                    class="h-5 w-5" />
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={inverseVolumeCurve(
                                    playerState.isMuted ? 0 : playerState.volume,
                                    volumeCurve,
                                )}
                                oninput={(e) => {
                                    const sliderPosition = Number(
                                        (e.target as HTMLInputElement).value,
                                    );
                                    audiobookPlayerStore.setVolume(
                                        applyVolumeCurve(sliderPosition, volumeCurve),
                                    );
                                }}
                                class="h-1 flex-1 accent-primary-500"
                                aria-label="Volume" />
                        </div>
                    {/if}
                </div>
            </div>

            {#if chapterRows.length > 0}
                <div class="relative hidden min-h-0 w-80 flex-col lg:flex">
                    <h2
                        class="mb-2 shrink-0 text-xs uppercase tracking-wide text-surface-400"
                        id="audiobook-chapter-list-heading">
                        Chapters
                        <span class="tabular-nums text-surface-500">
                            {activeChapterIndex >= 0
                                ? `${activeChapterIndex + 1} of ${chapterRows.length}`
                                : chapterRows.length}
                        </span>
                    </h2>
                    <ul
                        bind:this={chapterListEl}
                        aria-labelledby="audiobook-chapter-list-heading"
                        data-testid="audiobook-chapter-list"
                        onscroll={syncActiveRowVisibility}
                        class="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
                        {#each chapterRows as chapter, index (chapter.startMs)}
                            <li>
                                <button
                                    type="button"
                                    data-chapter-index={index}
                                    aria-current={index === activeChapterIndex ? 'true' : undefined}
                                    style:color={index === activeChapterIndex
                                        ? accent?.tint
                                        : undefined}
                                    class="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm {index ===
                                    activeChapterIndex
                                        ? 'bg-surface-800 text-primary-300'
                                        : 'text-surface-300 hover:bg-surface-800 hover:text-white'}"
                                    onclick={() =>
                                        void audiobookPlayerStore.seekTo(chapter.startMs, {
                                            source: 'seek',
                                        })}>
                                    <span
                                        class="flex w-6 shrink-0 justify-center tabular-nums text-xs text-surface-500">
                                        {#if index === activeChapterIndex}
                                            <!-- The row is already tinted; the glyph
                                                 adds the one thing colour cannot say,
                                                 which is whether it is running. -->
                                            <Icon
                                                src={playerState.isPlaying ? Play : Pause}
                                                class="h-3 w-3"
                                                solid />
                                        {:else}
                                            {index + 1}
                                        {/if}
                                    </span>
                                    <span class="min-w-0 flex-1 truncate">{chapter.title}</span>
                                    <span class="shrink-0 tabular-nums text-xs text-surface-500">
                                        {formatChapterTime(chapter.endMs - chapter.startMs)}
                                    </span>
                                </button>
                            </li>
                        {/each}
                    </ul>
                    <!-- With 555 rows, scrolling away from the playing chapter
                         strands you: there is no other route back to it. Shown
                         only while it is actually off screen. -->
                    {#if !activeRowVisible && activeChapterIndex >= 0}
                        <button
                            type="button"
                            data-testid="audiobook-jump-to-chapter"
                            class="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-surface-600 bg-surface-800/95 px-3 py-1.5 text-xs font-semibold text-surface-100 shadow-lg hover:bg-surface-700"
                            style:color={accent?.tint}
                            onclick={scrollToActiveChapter}>
                            Jump to chapter {activeChapterIndex + 1}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- Book time, not the backend's file time. On a multi-file book the
             two diverge after the first file and the highlight would be wrong
             for the rest of the book. -->
        <MusicChapterSheet
            open={chapterSheetOpen}
            onclose={() => (chapterSheetOpen = false)}
            chapters={sheetChapters}
            positionMs={playerState.bookPositionMs}
            durationMs={playerState.durationMs}
            heading="Chapters"
            onseek={(ms) => void audiobookPlayerStore.seekTo(ms, { source: 'seek' })} />
    </div>
{/if}
