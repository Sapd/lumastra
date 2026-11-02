<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';

    interface Props {
        totalWatchTimeSeconds: number;
        nightOwlScore: number;
        weekendWarriorScore: number;
        bingeScore: number;
        completionRate: number;
    }

    let {
        totalWatchTimeSeconds,
        nightOwlScore,
        weekendWarriorScore,
        bingeScore,
        completionRate,
    }: Props = $props();

    type Archetype = {
        emoji: string;
        title: () => string;
        description: () => string;
        gradient: string;
    };

    // Pure client-side scoring over stats the API already computes — no extra
    // queries. Ordered most-distinctive-first; the first matching rule wins.
    let archetype = $derived.by((): Archetype => {
        if (nightOwlScore >= 40 && bingeScore >= 40) {
            return {
                emoji: '🦉',
                title: m.stats_personality_night_owl_binger_title,
                description: m.stats_personality_night_owl_binger_desc,
                gradient: 'from-indigo-900/40 to-purple-900/40 border-indigo-700/40',
            };
        }
        if (bingeScore >= 50) {
            return {
                emoji: '🍿',
                title: m.stats_personality_marathoner_title,
                description: m.stats_personality_marathoner_desc,
                gradient: 'from-red-900/40 to-orange-900/40 border-red-700/40',
            };
        }
        if (completionRate >= 85) {
            return {
                emoji: '✅',
                title: m.stats_personality_completionist_title,
                description: m.stats_personality_completionist_desc,
                gradient: 'from-green-900/40 to-emerald-900/40 border-green-700/40',
            };
        }
        if (weekendWarriorScore >= 55) {
            return {
                emoji: '🎉',
                title: m.stats_personality_weekend_warrior_title,
                description: m.stats_personality_weekend_warrior_desc,
                gradient: 'from-amber-900/40 to-yellow-900/40 border-amber-700/40',
            };
        }
        if (nightOwlScore >= 45) {
            return {
                emoji: '🌙',
                title: m.stats_personality_night_owl_title,
                description: m.stats_personality_night_owl_desc,
                gradient: 'from-blue-900/40 to-indigo-900/40 border-blue-700/40',
            };
        }
        if (completionRate > 0 && completionRate < 40) {
            return {
                emoji: '🦋',
                title: m.stats_personality_sampler_title,
                description: m.stats_personality_sampler_desc,
                gradient: 'from-teal-900/40 to-cyan-900/40 border-teal-700/40',
            };
        }
        return {
            emoji: '⚖️',
            title: m.stats_personality_balanced_title,
            description: m.stats_personality_balanced_desc,
            gradient: 'from-gray-800/60 to-gray-700/40 border-gray-600/40',
        };
    });

    let totalHours = $derived(Math.round(totalWatchTimeSeconds / 3600));
    let totalDays = $derived(totalWatchTimeSeconds / 86400);
    // Relatable comparison: ~2 hours per feature film.
    let filmEquivalent = $derived(Math.round(totalWatchTimeSeconds / 3600 / 2));

    let hoursFmt = $derived(totalHours.toLocaleString(getLocale()));
    let daysFmt = $derived(
        totalDays.toLocaleString(getLocale(), {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
        }),
    );
    let filmsFmt = $derived(filmEquivalent.toLocaleString(getLocale()));
</script>

<div
    class="bg-gradient-to-br {archetype.gradient} rounded-xl p-6 border"
    aria-labelledby="viewing-personality-title">
    <p class="text-muted mb-3" id="viewing-personality-title">{m.stats_personality_title()}</p>

    <div class="flex items-center gap-4">
        <span class="text-5xl leading-none" aria-hidden="true">{archetype.emoji}</span>
        <div class="min-w-0">
            <h3 class="text-xl font-bold text-white truncate">{archetype.title()}</h3>
            <p class="text-subtitle mt-1">{archetype.description()}</p>
        </div>
    </div>

    {#if totalHours > 0}
        <div class="mt-5 pt-4 border-t border-white/10 space-y-1">
            <p class="text-white font-medium">
                {m.stats_personality_hours_of_life({ hours: hoursFmt })}
            </p>
            <p class="text-subtitle">
                {m.stats_personality_days_equiv({ days: daysFmt })}
                {#if filmEquivalent > 0}
                    · {m.stats_personality_films_equiv({ count: filmsFmt })}
                {/if}
            </p>
        </div>
    {/if}
</div>
