<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Z } from '$lib/utils/z-index';
    import { untrack } from 'svelte';
    import { z } from 'zod';
    import { Icon, XMark, Check } from 'svelte-hero-icons';
    import StarRating from '$lib/components/ui/StarRating.svelte';
    import { stopPropagation } from '$lib/utils/event-helpers';
    import { trapFocus } from '$lib/utils/focus-trap';
    import * as aiApi from '$lib/api/ai';
    import { apiGet } from '$lib/api/client';
    import { getExternalIdFor } from '$lib/utils/external-ids';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { ApiMediaTypeInput } from '$lib/types/api-common';

    interface Props {
        open: boolean;
        title: string;
        externalIds: ExternalIds;
        /** Storage token, not the response token: it goes VERBATIM into the
         *  `tmdb:<id>:<type>` composite key that `resolveComposite()` matches
         *  against `external_ids.media_type`, which holds 'tv' (never 'series'). */
        mediaType: ApiMediaTypeInput;
        /** Optional caller-supplied prior rating. If absent (or null),
         * the modal fetches the current user rating from
         * /api/media/{id}/rating on open and prefills the picker. */
        initialRating?: number | null;
        onClose: () => void;
        onSaved?: (rating: number) => void;
    }

    let {
        open,
        title,
        externalIds,
        mediaType,
        initialRating = null,
        onClose,
        onSaved,
    }: Props = $props();

    let rating = $state<number | null>(null);
    let saving = $state(false);

    const RatingResponseSchema = z.object({ rating: z.number().nullable() });

    /** Build the GET /api/media/{id}/rating path — UUID first, composite
     * key as fallback. Returns null when the item carries neither. */
    function buildRatingFetchPath(): string | null {
        const internal = getExternalIdFor(externalIds, 'internal');
        if (internal) {
            return `/api/media/${encodeURIComponent(internal)}/rating`;
        }
        const tmdb = getExternalIdFor(externalIds, 'tmdb');
        if (tmdb) {
            return `/api/media/${encodeURIComponent(`tmdb:${tmdb}:${mediaType}`)}/rating`;
        }
        const imdb = getExternalIdFor(externalIds, 'imdb');
        if (imdb) {
            return `/api/media/${encodeURIComponent(`imdb:${imdb}:${mediaType}`)}/rating`;
        }
        return null;
    }

    $effect(() => {
        if (!open) return;
        untrack(() => {
            rating = initialRating ?? null;
        });
        // Prefill from server when caller didn't pass an initialRating.
        // Caller-supplied values win — they may carry optimistic state.
        if (initialRating != null) return;
        const path = buildRatingFetchPath();
        if (!path) return;
        let cancelled = false;
        void apiGet(path, RatingResponseSchema).then((res) => {
            if (cancelled) return;
            const fetched = res.data?.rating;
            if (typeof fetched === 'number' && fetched > 0 && rating == null) {
                rating = fetched;
            }
        });
        return () => {
            cancelled = true;
        };
    });

    async function save(): Promise<void> {
        if (!rating || saving) return;
        saving = true;
        try {
            const { error } = await aiApi.submitRating(
                externalIds,
                mediaType,
                rating,
                `User rated "${title}" from card menu`,
            );
            if (error) {
                toasts.error(m.card_rate_failed());
                return;
            }
            toasts.info(m.card_rate_saved({ rating: String(rating) }));
            onSaved?.(rating);
            onClose();
        } finally {
            saving = false;
        }
    }

    function handleBackdrop(e: MouseEvent): void {
        if (e.target === e.currentTarget) onClose();
    }

    function handleKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    }
</script>

{#if open}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/50 px-4"
        style="z-index: {Z.FLOATING_MODAL}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rating-picker-title"
        tabindex="-1"
        onclick={handleBackdrop}
        onkeydown={handleKey}>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
            use:trapFocus
            role="document"
            class="w-full max-w-sm rounded-lg border border-surface-700 bg-surface-900 shadow-2xl"
            onclick={stopPropagation()}
            onkeydown={handleKey}>
            <header
                class="flex items-start justify-between gap-3 border-b border-surface-700 px-4 py-3">
                <div class="min-w-0">
                    <h2
                        id="rating-picker-title"
                        class="truncate text-base font-semibold text-surface-100">
                        {m.card_rate_this()}
                    </h2>
                    <p class="truncate text-xs text-surface-400">{title}</p>
                </div>
                <button
                    type="button"
                    class="text-surface-400 hover:text-surface-100"
                    aria-label={m.close()}
                    onclick={onClose}>
                    <Icon src={XMark} class="h-5 w-5" />
                </button>
            </header>

            <div class="px-4 py-5">
                <div class="flex items-center justify-center">
                    <StarRating
                        value={rating}
                        max={10}
                        interactive
                        size="base"
                        onchange={(r) => (rating = r)} />
                </div>
                <p class="mt-3 text-center text-xs text-surface-400">
                    {rating ? `${rating}/10` : m.card_rate_pick_prompt()}
                </p>
            </div>

            <footer
                class="flex items-center justify-end gap-2 border-t border-surface-700 px-4 py-3">
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-surface"
                    onclick={onClose}
                    disabled={saving}>
                    {m.cancel()}
                </button>
                <button
                    type="button"
                    class="btn btn-sm variant-filled-primary"
                    onclick={save}
                    disabled={!rating || saving}>
                    <Icon src={Check} class="mr-1 h-4 w-4" />
                    {saving ? m.card_rate_saving() : m.card_rate_save()}
                </button>
            </footer>
        </div>
    </div>
{/if}
