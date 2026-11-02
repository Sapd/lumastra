<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        Trash,
        PencilSquare,
        HandThumbDown,
        HandThumbUp,
        MinusCircle,
        Heart,
        type IconSource,
    } from 'svelte-hero-icons';
    import StarRating from '$lib/components/ui/StarRating.svelte';
    import * as m from '$lib/paraglide/messages';
    import type { SocialActivity } from '$lib/utils/modal-data';
    import { createAnnotation, deleteAnnotation } from '$lib/api/content';

    interface Props {
        socialActivities?: SocialActivity[];
        showSocialActivity?: boolean;
        showReviews?: boolean;
        isSeries?: boolean;
        isEpisode?: boolean;
        /** Books are listened to, not watched — the heading has to say so. */
        isAudiobook?: boolean;
        mediaDbId?: string;
        currentUserId?: string;
        currentUserRating?: number | null;
        isAdmin?: boolean;
        onreviewchange?: () => void;
        onrated?: (rating: number) => void;
    }

    let {
        socialActivities = [],
        showSocialActivity = false,
        showReviews = false,
        isSeries = false,
        isEpisode = false,
        isAudiobook = false,
        mediaDbId,
        currentUserId,
        currentUserRating = null,
        isAdmin = false,
        onreviewchange,
        onrated,
    }: Props = $props();

    const writeReviewLabel = $derived(
        isSeries
            ? m.modal_review_write_series()
            : isEpisode
              ? m.modal_review_write_episode()
              : m.modal_review_write(),
    );

    let expandedReviews = $state<Set<string>>(new Set());

    $effect(() => {
        if (mediaDbId !== undefined) expandedReviews = new Set();
    });

    let showReviewForm = $state(false);
    let reviewText = $state('');
    let reviewSubmitting = $state(false);
    let submitError = $state<string | null>(null);
    let deleteError = $state<string | null>(null);

    const currentUserReview = $derived(
        socialActivities.find(
            (a) => a.author.userId.toLowerCase() === (currentUserId ?? '').toLowerCase(),
        ),
    );

    const MAX_REVIEW_LEN = 1000;
    const WARN_AT = 800;

    function handleAvatarError(e: Event): void {
        const img = e.currentTarget as HTMLImageElement;
        img.style.display = 'none';
        const next = img.nextElementSibling;
        if (next instanceof HTMLElement) next.style.display = 'flex';
    }

    interface QuickRatingDisplay {
        icon: IconSource;
        label: string;
    }

    function quickRatingDisplay(rating: number): QuickRatingDisplay {
        if (rating <= 3) return { icon: HandThumbDown, label: m.rating_not_for_me() };
        if (rating <= 5) return { icon: MinusCircle, label: m.rating_meh() };
        if (rating <= 8) return { icon: HandThumbUp, label: m.rating_liked() };
        return { icon: Heart, label: m.rating_loved() };
    }

    function toggleReview(userId: string): void {
        expandedReviews = new Set(
            expandedReviews.has(userId)
                ? [...expandedReviews].filter((u) => u !== userId)
                : [...expandedReviews, userId],
        );
    }

    async function handleSubmitReview(): Promise<void> {
        if (!mediaDbId || !reviewText.trim()) return;
        reviewSubmitting = true;
        submitError = null;
        try {
            const { error } = await createAnnotation(mediaDbId, {
                type: 'review',
                content: reviewText.trim(),
            });
            if (error) throw new Error(error);
            showReviewForm = false;
            reviewText = '';
            onreviewchange?.();
        } catch {
            submitError = m.modal_review_error_submit();
        } finally {
            reviewSubmitting = false;
        }
    }

    async function handleDeleteReview(reviewId: string): Promise<void> {
        if (!mediaDbId) return;
        deleteError = null;
        try {
            const { error } = await deleteAnnotation(mediaDbId, reviewId);
            if (error) throw new Error(error);
            onreviewchange?.();
        } catch {
            deleteError = m.modal_review_error_delete();
        }
    }
</script>

{#if (showSocialActivity && socialActivities.length > 0) || (showReviews && mediaDbId && currentUserId)}
    <div class="social-activity-section mt-4">
        <!-- Section heading for other instance users -->
        {#if showSocialActivity && socialActivities.some((a) => !a.isSelf)}
            <h4 class="text-sm font-semibold text-surface-300 mb-2 flex items-center gap-2">
                <svg
                    class="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {isAudiobook
                    ? m.modal_friends_listened()
                    : isEpisode
                      ? m.modal_friends_watched_episode()
                      : isSeries
                        ? m.modal_friends_watched_series()
                        : m.modal_friends_watched()}
            </h4>
        {/if}

        <!-- Delete error (shown outside form, near the activity list) -->
        {#if deleteError}
            <p class="text-xs text-error-400 mb-2">{deleteError}</p>
        {/if}

        <!-- Activity list -->
        {#if socialActivities.length > 0}
            <div class="space-y-2">
                {#each socialActivities as activity (activity.author.userId)}
                    <div class="flex items-center gap-3 bg-surface-700/50 rounded-lg px-3 py-2">
                        <!-- Avatar -->
                        <div class="w-8 h-8 rounded-full overflow-hidden bg-surface-600 shrink-0">
                            <img
                                src={activity.author.images.primary.href}
                                alt={activity.author.displayName ?? m.social_someone()}
                                class="w-full h-full object-cover"
                                onerror={handleAvatarError} />
                            <div
                                class="w-full h-full items-center justify-center text-xs font-bold text-surface-300 hidden">
                                {(activity.author.displayName ?? m.social_someone())
                                    .charAt(0)
                                    .toUpperCase()}
                            </div>
                        </div>
                        <!-- Content -->
                        <div class="flex-1 min-w-0">
                            <p class="text-sm text-surface-200">
                                {activity.isSelf
                                    ? m.modal_review_your_review()
                                    : activity.description}
                            </p>
                            <!-- Rating display (read-only): stars for precise ratings, thumbs/label for quick semantic taps -->
                            {#if activity.isSelf ? currentUserRating : activity.rating}
                                {@const displayRating = activity.isSelf
                                    ? currentUserRating!
                                    : activity.rating!}
                                <div class="flex items-center gap-0 mt-0.5">
                                    {#if activity.ratingStyle === 'quick'}
                                        {@const quick = quickRatingDisplay(displayRating)}
                                        <Icon
                                            src={quick.icon}
                                            class="w-3.5 h-3.5 text-surface-300"
                                            aria-hidden="true" />
                                        <span class="text-xs text-surface-400 ml-1.5"
                                            >{quick.label}</span>
                                    {:else}
                                        <StarRating value={displayRating} />
                                        <span class="text-xs text-surface-400 ml-1.5"
                                            >{displayRating}/10</span>
                                    {/if}
                                </div>
                            {/if}
                            <!-- Review text expand/collapse -->
                            {#if showReviews && activity.review}
                                {@const PREVIEW_LEN = 80}
                                {@const isExpanded = expandedReviews.has(activity.author.userId)}
                                <div class="mt-1.5 text-xs text-surface-300 italic leading-relaxed">
                                    {isExpanded || activity.review.length <= PREVIEW_LEN
                                        ? `"${activity.review}"`
                                        : `"${activity.review.slice(0, PREVIEW_LEN)}…"`}
                                    {#if activity.review.length > PREVIEW_LEN}
                                        <button
                                            class="ml-1 text-primary-400 hover:text-primary-300 not-italic"
                                            onclick={() => toggleReview(activity.author.userId)}>
                                            {isExpanded
                                                ? m.modal_review_show_less()
                                                : m.modal_review_read_more()}
                                        </button>
                                    {/if}
                                </div>
                            {/if}
                        </div>
                        <!-- Own review actions (edit + delete) -->
                        {#if showReviews && activity.isSelf && activity.reviewId && !showReviewForm}
                            <div class="flex items-center gap-1 shrink-0">
                                <button
                                    class="p-1 text-surface-400 hover:text-primary-400 transition-colors"
                                    onclick={() => {
                                        reviewText = activity.review ?? '';
                                        showReviewForm = true;
                                    }}
                                    title={m.modal_review_edit()}>
                                    <Icon
                                        src={PencilSquare}
                                        class="w-3.5 h-3.5"
                                        aria-hidden="true" />
                                    <span class="sr-only">{m.modal_review_edit()}</span>
                                </button>
                                <button
                                    class="p-1 text-surface-400 hover:text-error-400 transition-colors"
                                    onclick={() => handleDeleteReview(activity.reviewId!)}
                                    title={m.modal_review_delete()}>
                                    <Icon src={Trash} class="w-3.5 h-3.5" aria-hidden="true" />
                                    <span class="sr-only">{m.modal_review_delete()}</span>
                                </button>
                            </div>
                        {:else if showReviews && isAdmin && !activity.isSelf && activity.reviewId}
                            <!-- Admin delete -->
                            <button
                                class="p-1 text-surface-400 hover:text-error-400 transition-colors shrink-0"
                                onclick={() => handleDeleteReview(activity.reviewId!)}
                                title={m.modal_review_delete()}>
                                <Icon src={Trash} class="w-3.5 h-3.5" aria-hidden="true" />
                                <span class="sr-only">{m.modal_review_delete()}</span>
                            </button>
                        {/if}
                    </div>
                {/each}
            </div>
        {/if}

        <!-- Review form (write/edit your review) — visible on all screen sizes -->
        {#if showReviews && mediaDbId && currentUserId}
            <div class="mt-3">
                {#if submitError}
                    <p class="text-xs text-error-400 mb-2">{submitError}</p>
                {/if}
                {#if !showReviewForm && !currentUserReview?.reviewId}
                    <button
                        class="text-xs text-surface-400 hover:text-surface-200 transition-colors flex items-center gap-1"
                        onclick={() => {
                            reviewText = '';
                            showReviewForm = true;
                        }}>
                        <Icon src={PencilSquare} class="w-3 h-3" aria-hidden="true" />
                        {writeReviewLabel}
                    </button>
                {/if}
                {#if showReviewForm}
                    <div class="space-y-2">
                        <!-- Interactive star rating using StarRating component -->
                        {#if onrated}
                            <StarRating
                                value={currentUserRating}
                                interactive
                                size="base"
                                onchange={(r) => onrated!(r)} />
                        {/if}
                        <textarea
                            class="w-full bg-surface-700/50 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary-500"
                            rows={4}
                            maxlength={MAX_REVIEW_LEN}
                            placeholder={m.modal_review_placeholder()}
                            bind:value={reviewText}></textarea>
                        {#if reviewText.length >= WARN_AT}
                            <p class="text-xs text-warning-400 text-right">
                                {reviewText.length}/{MAX_REVIEW_LEN}
                            </p>
                        {/if}
                        <div class="flex gap-2 justify-end">
                            <button
                                class="btn btn-sm variant-ghost"
                                onclick={() => {
                                    showReviewForm = false;
                                    submitError = null;
                                }}>
                                {m.modal_review_cancel()}
                            </button>
                            <button
                                class="btn btn-sm variant-filled-primary"
                                disabled={reviewSubmitting || reviewText.trim().length === 0}
                                onclick={handleSubmitReview}>
                                {reviewSubmitting
                                    ? m.modal_review_submitting()
                                    : m.modal_review_submit()}
                            </button>
                        </div>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
{/if}
