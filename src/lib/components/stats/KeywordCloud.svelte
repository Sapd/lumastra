<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { KeywordStats } from '$lib/types/personal-stats';
    import { Icon, Tag } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        data: KeywordStats;
    }

    let { data }: Props = $props();

    // Color palette for cloud tags — full-opacity text colors, no opacity modifier.
    // Two-level palette: tier ≥ 3 uses -400 (brighter), tiers 1-2 use -300 (softer
    // but still AA-compliant contrast on gray-800 bg, unlike opacity-65/75).
    const colorsBright = [
        'text-blue-400',
        'text-purple-400',
        'text-cyan-400',
        'text-green-400',
        'text-orange-400',
        'text-pink-400',
        'text-yellow-400',
        'text-red-400',
        'text-indigo-400',
        'text-teal-400',
    ];
    const colorsMuted = [
        'text-blue-300',
        'text-purple-300',
        'text-cyan-300',
        'text-green-300',
        'text-orange-300',
        'text-pink-300',
        'text-yellow-300',
        'text-red-300',
        'text-indigo-300',
        'text-teal-300',
    ];

    /**
     * Derive a stable palette index from the keyword string so the color
     * does not change across period switches or reshuffles.
     */
    function hashColor(str: string): number {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
        }
        return Math.abs(h) % colorsBright.length;
    }

    function getColor(keyword: string, tier: number): string {
        const idx = hashColor(keyword);
        return tier >= 3 ? colorsBright[idx] : colorsMuted[idx];
    }

    // Calculate size tier based on count (1-5 scale)
    function getSizeTier(count: number, maxCount: number, minCount: number): number {
        if (maxCount === minCount) return 3;
        const normalized = (count - minCount) / (maxCount - minCount);
        return Math.ceil(normalized * 4) + 1; // 1-5 range
    }

    // Get styles based on tier — no opacity modifiers; hierarchy via font-size+weight only.
    function getSizeStyles(tier: number): string {
        switch (tier) {
            case 5:
                return 'text-3xl font-bold';
            case 4:
                return 'text-2xl font-semibold';
            case 3:
                return 'text-xl font-medium';
            case 2:
                return 'text-base';
            default:
                return 'text-sm';
        }
    }

    /**
     * Seeded Fisher-Yates shuffle using a simple xorshift32 PRNG.
     * The seed is derived from the first keyword name so the order is stable
     * for a given keyword set but visually scattered.
     */
    function shuffleForCloud<T extends { keyword: string }>(arr: T[]): T[] {
        const shuffled = [...arr];
        // Seed from first keyword (or fallback)
        const seedStr = shuffled[0]?.keyword ?? 'seed';
        let s = 0;
        for (let i = 0; i < seedStr.length; i++) {
            s = (Math.imul(31, s) + seedStr.charCodeAt(i)) | 0;
        }
        if (s === 0) s = 1; // xorshift must not be zero
        function next(): number {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            return (s >>> 0) / 0x100000000;
        }
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    let maxCount = $derived(
        data.keywords.length > 0 ? Math.max(...data.keywords.map((k) => k.count)) : 1,
    );
    let minCount = $derived(
        data.keywords.length > 0 ? Math.min(...data.keywords.map((k) => k.count)) : 1,
    );
    // Show at most 30 keywords, shuffled for cloud effect
    let shuffledKeywords = $derived(shuffleForCloud(data.keywords.slice(0, 30)));

    // True total from service field; badge shows "top 30 of N" when N > shown count
    let shownCount = $derived(Math.min(data.keywords.length, 30));
    let totalCount = $derived(data.totalKeywordsTracked);
</script>

<div class="bg-gray-800/50 rounded-xl p-6 border border-gray-700/50">
    <div class="flex items-center gap-2 mb-4">
        <Icon src={Tag} class="w-5 h-5 text-cyan-400" aria-hidden="true" />
        <h3 class="text-lg font-bold text-white">{m.stats_keywords_title()}</h3>
        <span class="text-muted ml-auto">
            {#if totalCount > shownCount}
                {m.stats_keywords_top_of({ shown: shownCount, total: totalCount })}
            {:else}
                {m.stats_keywords_tracked({ count: shownCount })}
            {/if}
        </span>
    </div>

    {#if data.keywords.length > 0}
        {@const keywordsWithStyles = shuffledKeywords.map((k) => ({
            ...k,
            tier: getSizeTier(k.count, maxCount, minCount),
        }))}
        <ul
            class="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 py-4 list-none m-0 p-0"
            aria-label={m.stats_keywords_title()}>
            {#each keywordsWithStyles as keyword (keyword.keyword)}
                {@const sizeClass = getSizeStyles(keyword.tier)}
                {@const colorClass = getColor(keyword.keyword, keyword.tier)}
                <li>
                    <button
                        type="button"
                        class="cursor-default transition-all duration-200 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-1 focus:ring-offset-gray-800 rounded bg-transparent border-0 p-0 {colorClass} {sizeClass}"
                        aria-label={m.stats_keywords_aria_label({
                            keyword: keyword.keyword,
                            count: keyword.count,
                        })}>
                        {keyword.keyword}
                    </button>
                </li>
            {/each}
        </ul>
    {:else}
        <div class="flex flex-col items-center justify-center min-h-[80px] gap-2">
            <Icon src={Tag} class="w-8 h-8 text-gray-500" aria-hidden="true" />
            <p class="text-gray-400 text-sm text-center">{m.stats_keywords_no_data()}</p>
        </div>
    {/if}
</div>
