<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    SetSeriesProgressModal.svelte

    Manual progress correction for a series. Two modes:

      - "Through episode" (default): linear "I'm at S3:E5". Server marks
        every episode <= the picked one as watched, every one > as
        unwatched. Common case for users whose forward-only progress has
        drifted.

      - "Per episode": explicit toggle of individual episodes. Useful for
        anthologies (Black Mirror), filler-skipping (One Piece arcs), and
        any series that isn't watched in strict order. The server still
        only emits events for episodes that actually changed state — a
        no-op toggle of an already-watched row would otherwise bump its
        last_watched_at to "now" and scramble the NextUp anchor.

    Used when Lumastra's `user_media_state` has drifted from the user's
    mental model in a way no upstream sync can fix (watched outside
    Jellyfin, Jellyfin's flags wrong, sparse migration import). The
    Jellyfin "Refresh Watch State" admin tool covers the inverse
    direction (Lumastra drifted from Jellyfin).
-->
<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { untrack } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, XMark, Check, ListBullet } from 'svelte-hero-icons';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import * as contentApi from '$lib/api/content';
    import { setSeriesProgress, markWatched, unmarkWatched } from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';

    interface Episode {
        id?: string;
        name?: string;
        episodeNumber: number;
        seasonNumber: number;
        isWatched?: boolean;
    }

    type Mode = 'through' | 'per';

    interface Props {
        open: boolean;
        seriesId: string;
        seriesTitle?: string;
        /**
         * Which tab to show first when the modal opens. Different entry
         * points want different defaults: the main "Mark watched" button
         * lands on `per` (single-episode toggling — what users coming from
         * "I just watched one episode" expect), while drift-correction
         * flows pre-select `through`.
         */
        defaultMode?: Mode;
        onClose: () => void;
        /** Fired after a successful save so the caller can refresh state. */
        onSaved?: (result: { markedWatched: number; markedUnwatched: number }) => void;
    }

    let {
        open,
        seriesId,
        seriesTitle,
        defaultMode = 'through',
        onClose,
        onSaved,
    }: Props = $props();

    type LoadState =
        | { kind: 'idle' }
        | { kind: 'loading' }
        | { kind: 'error'; message: string }
        | { kind: 'loaded'; seasons: SeasonGroup[] };

    interface SeasonGroup {
        seasonNumber: number;
        episodes: Episode[];
    }

    let loadState: LoadState = $state({ kind: 'idle' });
    let saving = $state(false);
    let mode: Mode = $state(untrack(() => defaultMode));
    let pendingThrough = $state<Episode | null>(null);

    // Per-episode mode tracks "what state should the episode end up in?"
    // Initialised from the loaded `isWatched` flags so unchanged toggles
    // produce a clean zero-delta save. Wrapped in a Set keyed by episode
    // id so toggle ops are O(1).
    let perEpisodeWatched = new SvelteSet<string>();
    // Snapshot of the initial state at load time, used to compute the
    // delta for the footer count + the API payload.
    let perEpisodeInitial = new SvelteSet<string>();

    // Fetch all episodes for the series whenever the modal opens. Skip
    // re-fetching on subsequent re-opens within the same component
    // lifetime so quick close-then-open doesn't thrash the API.
    //
    // loadState is read via untrack so our own writes inside this effect
    // don't loop back as a dependency — without that guard, the
    // `loadState = { kind: 'loading' }` write below re-triggers the effect,
    // which sees kind!=='loaded', re-writes loading, and spams the API
    // with fetches forever.
    // Reset the per-mode picker to a clean baseline when the seriesId
    // prop changes (host swaps which series the modal is targeting). Without
    // this the next load would seed onto stale state from the previous
    // series's episodes.
    let lastSid: string | undefined = undefined;
    $effect(() => {
        if (!open) {
            pendingThrough = null;
            return;
        }
        // Reset to the caller's preferred starting tab on each open.
        // Without this, a user who switched tabs during a previous open
        // would land back in the wrong mode for the new entry point.
        untrack(() => {
            mode = defaultMode;
        });
        // Track open/seriesId as inputs; loadState/pendingThrough writes
        // below must not feed back in as dependencies.
        const sid = seriesId;
        const seriesChanged = lastSid !== undefined && lastSid !== sid;
        lastSid = sid;
        if (seriesChanged) {
            untrack(() => {
                pendingThrough = null;
                perEpisodeInitial.clear();
                perEpisodeWatched.clear();
            });
            loadState = { kind: 'idle' };
        }
        const currentKind = untrack(() => loadState.kind);
        if (currentKind === 'loaded' || currentKind === 'loading') return;
        loadState = { kind: 'loading' };
        void (async () => {
            try {
                const { data: seasonsData, error: seasonsErr } =
                    await contentApi.getSeriesSeasons(sid);
                if (seasonsErr || !seasonsData) {
                    loadState = {
                        kind: 'error',
                        message: seasonsErr || m.modal_progress_error_load_seasons(),
                    };
                    return;
                }
                const seasons = seasonsData.items ?? [];
                const groups: SeasonGroup[] = [];
                for (const season of seasons) {
                    const { data: epsData, error: epsErr } = await contentApi.getSeriesEpisodes(
                        sid,
                        season.seasonNumber,
                        { href: season.episodes.href },
                    );
                    if (epsErr || !epsData) {
                        // Fail the whole load on a per-season fetch
                        // error. Silently dropping a season would seed
                        // perEpisodeInitial without those episodes' real
                        // state, and a save would emit spurious
                        // mark_unwatched events for them.
                        loadState = {
                            kind: 'error',
                            message:
                                epsErr ||
                                m.modal_progress_error_load_season({
                                    seasonNumber: String(season.seasonNumber),
                                }),
                        };
                        return;
                    }
                    groups.push({
                        seasonNumber: season.seasonNumber,
                        episodes: epsData.items.map((ep) => ({
                            id: ep.id,
                            name: ep.title,
                            episodeNumber: ep.context?.episodeNumber ?? 0,
                            seasonNumber: ep.context?.seasonNumber ?? 0,
                            isWatched: ep.progress?.finished ?? false,
                        })),
                    });
                }
                if (seriesId !== sid) return; // raced — discard
                loadState = { kind: 'loaded', seasons: groups };
                // Seed per-episode state from the just-loaded watched
                // flags. perEpisodeInitial is the immutable baseline;
                // perEpisodeWatched starts as a copy and mutates as the
                // user toggles. SvelteSets are reactive on mutation, so
                // we clear+repopulate in-place rather than reassign.
                perEpisodeInitial.clear();
                perEpisodeWatched.clear();
                for (const g of groups) {
                    for (const ep of g.episodes) {
                        if (ep.id && ep.isWatched) {
                            perEpisodeInitial.add(ep.id);
                            perEpisodeWatched.add(ep.id);
                        }
                    }
                }
            } catch (e) {
                loadState = {
                    kind: 'error',
                    message: e instanceof Error ? e.message : String(e),
                };
            }
        })();
    });

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape' && !saving) onClose();
    }

    function pickThrough(ep: Episode): void {
        if (saving) return;
        pendingThrough = ep;
    }

    function togglePer(ep: Episode): void {
        if (saving || !ep.id) return;
        if (perEpisodeWatched.has(ep.id)) perEpisodeWatched.delete(ep.id);
        else perEpisodeWatched.add(ep.id);
    }

    function setMode(next: Mode): void {
        if (saving || mode === next) return;
        mode = next;
        // Drop the through-mode pick when leaving that tab; otherwise
        // flipping back would surface a stale selection without the
        // user re-confirming.
        if (next !== 'through') pendingThrough = null;
    }

    // Compute the delta for per-episode mode. Episodes the user newly
    // checked relative to the loaded baseline; episodes they newly
    // unchecked. The server applies these as a delta against the
    // canonical DB state — equivalent here because the modal loaded
    // from the same source.
    let perDelta = $derived.by(() => {
        const watched: string[] = [];
        const unwatched: string[] = [];
        for (const id of perEpisodeWatched) {
            if (!perEpisodeInitial.has(id)) watched.push(id);
        }
        for (const id of perEpisodeInitial) {
            if (!perEpisodeWatched.has(id)) unwatched.push(id);
        }
        return { watched, unwatched };
    });

    let canSave = $derived(
        mode === 'through'
            ? !!pendingThrough?.id
            : perDelta.watched.length + perDelta.unwatched.length > 0,
    );

    // Drives the visibility of the bulk quick-action buttons. We only show
    // "Mark all watched" when at least one episode is currently unwatched,
    // and "Mark all unwatched" when at least one is currently watched —
    // hiding no-op buttons keeps the header focused.
    let totalEpisodes = $derived.by(() => {
        if (loadState.kind !== 'loaded') return 0;
        let n = 0;
        for (const g of loadState.seasons) n += g.episodes.length;
        return n;
    });
    let hasAnyUnwatched = $derived(perEpisodeInitial.size < totalEpisodes);
    let hasAnyWatched = $derived(perEpisodeInitial.size > 0);

    async function markAllWatched(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const { error } = await markWatched(seriesId);
            if (error) {
                toasts.error(error || m.modal_progress_error_mark_watched());
                return;
            }
            toasts.success(m.modal_progress_marked_all_watched());
            // Counts are unknown to us here; the server fanned out without
            // returning a delta. Pass zeros — the parent only cares that
            // *something* changed so it can refresh.
            onSaved?.({ markedWatched: 0, markedUnwatched: 0 });
            onClose();
        } catch (e) {
            toasts.error(e instanceof Error ? e.message : m.modal_progress_error_mark_watched());
        } finally {
            saving = false;
        }
    }

    async function markAllUnwatched(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const { error } = await unmarkWatched(seriesId);
            if (error) {
                toasts.error(error || m.modal_progress_error_mark_unwatched());
                return;
            }
            toasts.success(m.modal_progress_marked_all_unwatched());
            onSaved?.({ markedWatched: 0, markedUnwatched: 0 });
            onClose();
        } catch (e) {
            toasts.error(e instanceof Error ? e.message : m.modal_progress_error_mark_unwatched());
        } finally {
            saving = false;
        }
    }

    async function confirmSave(): Promise<void> {
        if (saving || !canSave) return;
        saving = true;
        try {
            const body =
                mode === 'through' && pendingThrough?.id
                    ? { throughEpisodeId: pendingThrough.id }
                    : {
                          watchedIds: perDelta.watched,
                          unwatchedIds: perDelta.unwatched,
                      };
            const { data, error } = await setSeriesProgress(seriesId, body);
            if (error || !data) {
                toasts.error(error || m.modal_progress_error_save());
                return;
            }
            // Server returns delta-counts (only episodes that actually
            // flipped state). A zero-delta save is a legitimate outcome
            // (user re-confirmed their existing progress, or the
            // server already matched the picked through-episode); show
            // a distinct "no change" message instead of the misleading
            // "0 watched, 0 unwatched".
            if (data.markedWatched === 0 && data.markedUnwatched === 0) {
                toasts.success(m.modal_progress_no_change_toast());
            } else {
                toasts.success(
                    m.modal_progress_change_toast({
                        watched: String(data.markedWatched),
                        unwatched: String(data.markedUnwatched),
                    }),
                );
            }
            onSaved?.(data);
            onClose();
        } catch (e) {
            toasts.error(e instanceof Error ? e.message : m.modal_progress_error_save());
        } finally {
            saving = false;
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="modal-overlay modal-overlay-50"
        style="z-index: {Z.MODAL}"
        role="dialog"
        aria-modal="true"
        aria-label={m.modal_progress_title()}
        tabindex="-1"
        onclick={() => (saving ? undefined : onClose())}
        onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
            class="card-bordered p-6 max-w-2xl w-full mx-4 shadow-xl flex flex-col"
            style="max-height: 85vh"
            role="document"
            use:trapFocus
            onclick={stopPropagation()}>
            <!-- Header -->
            <div class="flex items-start justify-between gap-3 mb-2">
                <div class="flex-1 min-w-0">
                    <h3 class="text-xl font-semibold text-white inline-flex items-center gap-2">
                        <Icon src={ListBullet} class="w-5 h-5 text-blue-400 shrink-0" />
                        {m.modal_progress_title()}
                    </h3>
                    {#if seriesTitle}
                        <p class="text-sm text-gray-400 mt-0.5 truncate">
                            {seriesTitle}
                        </p>
                    {/if}
                </div>
                <button
                    type="button"
                    class="p-2 -m-2 hover:bg-surface-700 rounded-lg transition-colors shrink-0"
                    onclick={onClose}
                    disabled={saving}
                    aria-label={m.close()}>
                    <Icon src={XMark} class="w-5 h-5 text-gray-400" />
                </button>
            </div>

            <!--
                Bulk quick-actions. One-click shortcuts that bypass the
                tab-based picker entirely for the two most common cases:
                "I just finished the whole series" and "wipe my progress
                here." Hidden when they'd be a no-op (everything already
                in the target state) so the header doesn't show buttons
                that do nothing. Shown only after episodes have loaded —
                before that we don't know which buttons are no-ops.
            -->
            {#if loadState.kind === 'loaded' && (hasAnyUnwatched || hasAnyWatched)}
                <div class="flex flex-wrap gap-2 mb-3">
                    {#if hasAnyUnwatched}
                        <button
                            type="button"
                            class="btn btn-sm variant-soft-success inline-flex items-center gap-1.5"
                            onclick={() => void markAllWatched()}
                            disabled={saving}>
                            <Icon src={Check} class="w-4 h-4" aria-hidden="true" />
                            {m.modal_progress_mark_all_watched()}
                        </button>
                    {/if}
                    {#if hasAnyWatched}
                        <button
                            type="button"
                            class="btn btn-sm variant-soft-surface inline-flex items-center gap-1.5"
                            onclick={() => void markAllUnwatched()}
                            disabled={saving}>
                            <Icon src={XMark} class="w-4 h-4" aria-hidden="true" />
                            {m.modal_progress_mark_all_unwatched()}
                        </button>
                    {/if}
                </div>
            {/if}

            <!--
                Mode tabs. The default tab is set by the `defaultMode`
                prop — `per` for the "Mark watched" button entry (single-
                episode toggling matches user intent), `through` for
                drift-correction flows. Per-episode is the escape hatch
                for non-linear viewing that the through-mode can't express.
            -->
            <div class="flex gap-1 mb-3 border-b border-gray-800/60">
                <button
                    type="button"
                    class="px-3 py-2 text-sm border-b-2 -mb-px transition-colors {mode === 'through'
                        ? 'border-blue-400 text-blue-300'
                        : 'border-transparent text-gray-400 hover:text-gray-200'}"
                    onclick={() => setMode('through')}
                    disabled={saving}>
                    {m.modal_progress_tab_through()}
                </button>
                <button
                    type="button"
                    class="px-3 py-2 text-sm border-b-2 -mb-px transition-colors {mode === 'per'
                        ? 'border-blue-400 text-blue-300'
                        : 'border-transparent text-gray-400 hover:text-gray-200'}"
                    onclick={() => setMode('per')}
                    disabled={saving}>
                    {m.modal_progress_tab_per()}
                </button>
            </div>

            {#if mode === 'through'}
                <p class="text-xs text-gray-500 mb-4">
                    {m.modal_progress_through_description()}
                </p>
            {:else}
                <p class="text-xs text-gray-500 mb-4">
                    {m.modal_progress_per_description()}
                </p>
            {/if}

            <!-- Body -->
            <div class="flex-1 overflow-y-auto -mx-2 px-2">
                {#if loadState.kind === 'loading'}
                    <div
                        class="bg-gray-800/30 rounded-lg px-4 py-8 text-center text-gray-400 text-sm">
                        {m.modal_progress_loading()}
                    </div>
                {:else if loadState.kind === 'error'}
                    <div
                        class="bg-red-900/20 border border-red-700/40 rounded-lg px-4 py-3 text-red-200 text-sm">
                        {loadState.message}
                    </div>
                {:else if loadState.kind === 'loaded'}
                    <div class="space-y-4">
                        {#each loadState.seasons as group (group.seasonNumber)}
                            <div>
                                <div class="text-xs uppercase tracking-wider text-gray-500 mb-1.5">
                                    {#if group.seasonNumber === 0}
                                        {m.modal_progress_specials()}
                                    {:else}
                                        {m.modal_progress_season({
                                            seasonNumber: String(group.seasonNumber),
                                        })}
                                    {/if}
                                </div>
                                <div class="grid grid-cols-1 sm:grid-cols-2 gap-1">
                                    {#each group.episodes as ep (ep.id)}
                                        {@const isPending =
                                            mode === 'through' && pendingThrough?.id === ep.id}
                                        {@const isCheckedPer =
                                            mode === 'per' &&
                                            !!ep.id &&
                                            perEpisodeWatched.has(ep.id)}
                                        {@const isChangedPer =
                                            mode === 'per' &&
                                            !!ep.id &&
                                            isCheckedPer !== perEpisodeInitial.has(ep.id)}
                                        <button
                                            type="button"
                                            class="text-left px-3 py-2 rounded transition-colors flex items-center gap-2 {isPending
                                                ? 'bg-blue-900/40 border border-blue-700/60 text-blue-100'
                                                : isCheckedPer
                                                  ? 'bg-green-900/30 border border-green-700/50 text-green-100'
                                                  : 'bg-gray-800/40 hover:bg-gray-800/80 border border-gray-700/40 text-gray-200'} {isChangedPer
                                                ? 'ring-1 ring-blue-500/40'
                                                : ''}"
                                            onclick={() =>
                                                mode === 'through'
                                                    ? pickThrough(ep)
                                                    : togglePer(ep)}
                                            disabled={saving || !ep.id}>
                                            <span
                                                class="font-mono text-[11px] text-gray-500 shrink-0">
                                                S{String(ep.seasonNumber).padStart(
                                                    2,
                                                    '0',
                                                )}E{String(ep.episodeNumber).padStart(
                                                    2,
                                                    '0',
                                                )}
                                            </span>
                                            <span class="truncate text-sm flex-1">
                                                {ep.name ?? ''}
                                            </span>
                                            {#if mode === 'per'}
                                                {#if isCheckedPer}
                                                    <Icon
                                                        src={Check}
                                                        class="w-4 h-4 text-green-400 shrink-0"
                                                        solid />
                                                {:else}
                                                    <span
                                                        class="w-4 h-4 rounded border border-gray-600 shrink-0"
                                                    ></span>
                                                {/if}
                                            {:else if ep.isWatched}
                                                <Icon
                                                    src={Check}
                                                    class="w-4 h-4 text-green-400/70 shrink-0"
                                                    solid />
                                            {/if}
                                        </button>
                                    {/each}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            <!-- Footer -->
            <div class="flex items-center gap-3 mt-4 pt-3 border-t border-gray-800/60">
                {#if mode === 'through'}
                    {#if pendingThrough}
                        <p class="text-sm text-gray-300 flex-1 truncate font-mono">
                            {m.modal_progress_mark_through({
                                episode: `S${String(pendingThrough.seasonNumber).padStart(
                                    2,
                                    '0',
                                )}E${String(pendingThrough.episodeNumber).padStart(2, '0')}`,
                            })}
                        </p>
                    {:else}
                        <p class="text-sm text-gray-500 flex-1">
                            {m.modal_progress_pick_to_continue()}
                        </p>
                    {/if}
                {:else}
                    {@const w = perDelta.watched.length}
                    {@const u = perDelta.unwatched.length}
                    {#if w + u === 0}
                        <p class="text-sm text-gray-500 flex-1">
                            {m.modal_progress_no_changes()}
                        </p>
                    {:else}
                        <p class="text-sm text-gray-300 flex-1 truncate">
                            <span class="font-medium"
                                >{w + u === 1
                                    ? m.modal_progress_changes_one({
                                          count: String(w + u),
                                      })
                                    : m.modal_progress_changes_many({
                                          count: String(w + u),
                                      })}</span>
                            {#if w}
                                · <span class="text-green-300"
                                    >{m.modal_progress_to_watch({
                                        count: String(w),
                                    })}</span>
                            {/if}
                            {#if u}
                                · <span class="text-orange-300"
                                    >{m.modal_progress_to_unwatch({
                                        count: String(u),
                                    })}</span>
                            {/if}
                        </p>
                    {/if}
                {/if}
                <button class="btn btn-gray" onclick={onClose} disabled={saving}>
                    {m.cancel()}
                </button>
                <button
                    class="btn btn-blue font-medium"
                    onclick={() => void confirmSave()}
                    disabled={saving || !canSave}>
                    {saving ? m.modal_progress_saving() : m.modal_progress_save()}
                </button>
            </div>
        </div>
    </div>
{/if}
