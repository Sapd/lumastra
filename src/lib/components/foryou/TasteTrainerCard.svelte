<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
	TasteTrainerCard.svelte

	Compact promo card for the /rate trainer, used two ways by
	RecommendationFeed (see the 'taste' rail wiring there):

	- `variant="trailing"` — a slim strip rendered directly under the taste
	  rail once it has content, nudging an already-engaged user to keep
	  rating.
	- `variant="replacement"` — a larger card that stands in for the ENTIRE
	  rail when the user hasn't rated enough yet
	  (`totalRatings < minRatings`) or the rail is genuinely empty
	  (`status === 'exhausted'`).

	Purely presentational: the caller computes nothing beyond passing the
	raw counts — this component derives the locked/unlocked copy itself.

	`message` (optional, additive) overrides the derived locked/unlocked
	subtitle entirely. Used for the "unlocked but no positive signal" honest
	state (RecommendationFeed's tasteStatus === 'generating' gate): the user
	has cleared minRatings so `locked` would read false, but there's no
	profile embedding yet because none of their ratings were positive
	(≥6) — the default "N titles rated so far" copy would be misleading
	there, so the caller passes `m.taste_trainer_no_positive()` instead.
-->
<script lang="ts">
    import { Icon, Sparkles } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** Lifetime rating count — `getUserStats().stats.totalRatings`. */
        totalRatings: number;
        /** `MIN_RATINGS_FOR_RECOMMENDATIONS` — passed in, not imported, to keep this component presentational. */
        minRatings: number;
        variant?: 'trailing' | 'replacement';
        /** Overrides the default locked/unlocked subtitle copy — see doc comment above. */
        message?: string;
    }

    let { totalRatings, minRatings, variant = 'trailing', message }: Props = $props();

    let locked = $derived(totalRatings < minRatings);
</script>

<div
    class="taste-trainer-card taste-trainer-card--{variant} flex items-center gap-3 rounded-xl border p-4">
    <span class="taste-trainer-icon shrink-0">
        <Icon src={Sparkles} class="w-6 h-6 text-purple-400" />
    </span>
    <div class="min-w-0 flex-1">
        <p class="font-heading text-sm text-gray-100">{m.taste_trainer_title()}</p>
        <p class="text-xs text-surface-400">
            {#if message}
                {message}
            {:else if locked}
                {m.taste_trainer_locked({ current: totalRatings, needed: minRatings })}
            {:else}
                {m.taste_trainer_count({ count: totalRatings })}
            {/if}
        </p>
    </div>
    <a href={resolve('/rate')} class="btn btn-sm variant-ghost-primary shrink-0 whitespace-nowrap">
        {m.rec_rate_more()} →
    </a>
</div>

<style>
    .taste-trainer-card {
        border-color: rgba(255, 255, 255, 0.08);
        background: rgba(255, 255, 255, 0.03);
    }

    .taste-trainer-card--replacement {
        border-color: rgba(168, 85, 247, 0.25);
        background: linear-gradient(135deg, rgba(168, 85, 247, 0.1), rgba(236, 72, 153, 0.06));
        padding: 1.25rem 1.5rem;
    }
</style>
