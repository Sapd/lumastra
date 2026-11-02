<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { onMount } from 'svelte';
    import { page } from '$app/stores';
    import { Icon, SpeakerWave, ChatBubbleBottomCenterText } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import { getLocale } from '$lib/paraglide/runtime';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import {
        sortLanguageCodes,
        localizedLanguageName,
        iso639ToDisplayName,
    } from '$lib/utils/language-codes';
    import LanguageOverflow from './LanguageOverflow.svelte';

    interface Props {
        originalLanguage?: string;
        audioLanguages?: string[];
        subtitleLanguages?: string[];
        max?: number;
        interactive?: boolean;
    }
    let {
        originalLanguage = undefined,
        audioLanguages = [],
        subtitleLanguages = [],
        max = 2,
        interactive = true,
    }: Props = $props();
    let host: HTMLSpanElement;
    let narrow = $state(false);
    let limit = $derived(narrow ? 1 : Math.max(1, max));
    let groups = $derived([
        {
            kind: 'audio',
            label: m.tech_audio_track(),
            icon: SpeakerWave,
            codes: sortLanguageCodes(
                audioLanguages,
                $page.data?.mediaLanguagePriority,
                originalLanguage,
            ),
            tone: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
        },
        {
            kind: 'subtitles',
            label: m.tech_subtitles(),
            icon: ChatBubbleBottomCenterText,
            codes: sortLanguageCodes(
                subtitleLanguages,
                $page.data?.mediaLanguagePriority,
                originalLanguage,
            ),
            tone: 'bg-green-500/15 text-green-400 border-green-500/25',
        },
    ]);
    function name(code: string): string {
        return code === '??'
            ? m.media_languages_unknown_language()
            : localizedLanguageName(code, getLocale()) || iso639ToDisplayName(code);
    }
    onMount(() => {
        const query = window.matchMedia('(max-width: 640px)');
        const parent = host.parentElement;
        const update = (): void => {
            const width = parent?.getBoundingClientRect().width ?? 0;
            narrow = query.matches || (width > 0 && width < 360);
        };
        const observer = new ResizeObserver(update);
        if (parent) observer.observe(parent);
        update();
        query.addEventListener('change', update);
        return () => {
            query.removeEventListener('change', update);
            observer.disconnect();
        };
    });
</script>

<span bind:this={host} class="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
    {#each groups as group (group.kind)}
        {#if group.codes.length}
            <span
                class="inline-flex shrink-0 items-center gap-1 {group.kind === 'audio'
                    ? 'text-blue-400'
                    : 'text-green-400'}"
                data-language-kind={group.kind}>
                {#each group.codes.slice(0, limit) as code (code)}
                    {@const label = `${group.label} ${name(code)}`}
                    <Tooltip text={label} position="top" fixed inline triggerClass="shrink-0">
                        <span
                            class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold tracking-wide border {group.tone}"
                            aria-label={label}>
                            <Icon size="10" src={group.icon} class="w-2.5 h-2.5" />{code}
                        </span>
                    </Tooltip>
                {/each}
                {#if group.codes.length > limit}
                    {#if interactive}
                        <LanguageOverflow
                            label={group.label}
                            names={group.codes.map(name)}
                            hiddenCount={group.codes.length - limit} />
                    {:else}
                        <Tooltip
                            text={`${group.label}: ${group.codes.map(name).join(' · ')}`}
                            fixed
                            inline
                            wrap>
                            <span class="text-[9px] font-bold">+{group.codes.length - limit}</span>
                        </Tooltip>
                    {/if}
                {/if}
            </span>
        {/if}
    {/each}
</span>
