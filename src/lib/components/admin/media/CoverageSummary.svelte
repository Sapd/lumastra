<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    interface Coverage {
        episodesHeld: number;
        episodesListed: number;
        missing: number;
        identified: number;
        conflicted: boolean;
    }
    interface Season {
        seasonNumber: number | null;
        held: number;
        listed: number;
        catalog: number;
        missing: number | null;
        otherIssues: number;
        conflicted: boolean;
    }
    let {
        coverage,
        seasons = [],
        onissues,
    }: { coverage: Coverage | null; seasons?: Season[]; onissues?: () => void } = $props();
</script>

<section
    class="rounded-xl border border-surface-700 bg-surface-800/40 p-4 space-y-3"
    aria-label={m.media_redesign_availability()}>
    <h3 class="font-semibold text-surface-100">{m.media_redesign_availability()}</h3>
    {#if !coverage || coverage.identified === 0}
        <p class="text-sm text-surface-300">{m.media_redesign_coverage_unknown()}</p>
    {:else}
        <p class="text-sm text-surface-200">
            {m.media_redesign_regular_coverage({
                held: coverage.episodesHeld,
                listed: coverage.episodesListed,
            })}
        </p>
        {#if coverage.conflicted}
            <p class="text-sm text-amber-200">{m.media_redesign_coverage_conflict()}</p>
        {:else if coverage.missing > 0}
            <p class="text-sm text-amber-200">
                {m.media_redesign_missing({ count: coverage.missing })}
            </p>
        {/if}
    {/if}
    {#each seasons as season (season.seasonNumber)}
        <div class="rounded-lg bg-surface-900/50 px-3 py-2 text-sm space-y-1">
            <h4 class="font-medium">
                {season.seasonNumber === null
                    ? m.media_redesign_unknown_season()
                    : season.seasonNumber === 0
                      ? m.media_redesign_specials()
                      : m.admin_mediaedit_season_n({ number: season.seasonNumber })}
            </h4>
            {#if season.seasonNumber === null}
                <p class="text-surface-300">
                    {m.media_redesign_unknown_season_coverage({
                        held: season.held,
                        catalog: season.catalog,
                    })}
                </p>
            {:else if season.seasonNumber > 0}
                <p class="text-surface-300">
                    {m.media_redesign_season_coverage({
                        held: season.held,
                        listed: season.listed,
                        catalog: season.catalog,
                    })}
                </p>
                <p class="text-surface-400">
                    {season.missing === null
                        ? m.media_redesign_missing_unknown()
                        : m.media_redesign_missing({ count: season.missing })} · {m.media_redesign_other_issues(
                        { count: season.otherIssues },
                    )}
                </p>
            {:else}
                <p class="text-surface-300">
                    {m.media_redesign_special_coverage({
                        held: season.held,
                        listed: season.listed,
                        catalog: season.catalog,
                    })}
                </p>
                {#if season.missing === null}<p class="text-surface-400">
                        {m.media_redesign_missing_unknown()}
                    </p>{/if}
            {/if}
        </div>
    {/each}
    {#if onissues}<button type="button" class="text-sm text-yellow-300 underline" onclick={onissues}
            >{m.media_redesign_open_issues()}</button
        >{/if}
</section>
