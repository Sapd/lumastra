<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import type {
        FileLanguageSummary,
        LanguageTrack,
    } from '$lib/schemas/admin-language-summary.js';
    import { localizedLanguageName } from '$lib/shared/language-codes.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import LanguageOverflow from '$lib/components/media/LanguageOverflow.svelte';
    import { sortLanguageCodes } from '$lib/utils/language-codes';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages.js';
    let {
        summary,
        scope,
        detailsLabel,
        children,
    }: {
        summary?: FileLanguageSummary | null;
        scope?: string;
        detailsLabel?: string;
        children?: Snippet;
    } = $props();
    function languageName(track: LanguageTrack): string {
        return (
            localizedLanguageName(track.language, getLocale()) ||
            m.media_languages_unknown_language()
        );
    }
    function names(tracks: LanguageTrack[]): string[] {
        return sortLanguageCodes(
            tracks.map((track) => track.language ?? 'und'),
            $page.data?.mediaLanguagePriority,
            summary?.originalLanguage,
        ).map((code) =>
            code === '??'
                ? m.media_languages_unknown_language()
                : localizedLanguageName(code, getLocale()) || m.media_languages_unknown_language(),
        );
    }
    function trackLabel(track: LanguageTrack): string {
        return [
            languageName(track),
            track.isDefault ? m.media_languages_default() : null,
            track.isForced ? m.media_languages_forced() : null,
            track.source === 'sidecar' ? m.media_languages_external() : null,
        ]
            .filter(Boolean)
            .join(' · ');
    }
    function emptyLabel(): string {
        return summary?.probed ? m.media_languages_none() : m.media_languages_unprobed();
    }
</script>

{#snippet languageLine(
    label: string,
    tracks: LanguageTrack[],
    playbackScope?: string,
    disclosure = false,
)}
    {@const languages = names(tracks)}
    <span class="block"
        ><span class="font-medium text-surface-400"
            >{playbackScope ? `${label} (${playbackScope}):` : `${label}:`}</span>
        {languages.length
            ? languages.slice(0, 3).join(', ')
            : emptyLabel()}{#if languages.length > 3}
            <LanguageOverflow {label} names={languages} hiddenCount={languages.length - 3} />
        {/if}{#if disclosure}<span aria-hidden="true" class="ml-1 text-surface-400">⌄</span
            >{/if}</span>
{/snippet}
<div
    class="min-w-0 break-words text-xs text-surface-300"
    role="region"
    aria-label={m.media_languages_file()}
    data-testid="file-language-summary">
    <details class="min-w-0">
        <summary
            aria-label={detailsLabel ?? m.media_languages_details()}
            class="cursor-pointer list-none">
            {@render languageLine(
                m.media_languages_audio(),
                summary?.audio ?? [],
                [scope, summary?.isMissing ? m.media_languages_missing_short() : null]
                    .filter(Boolean)
                    .join('; ') || undefined,
            )}
            {@render languageLine(
                m.media_languages_subtitles(),
                summary?.subtitles ?? [],
                undefined,
                true,
            )}
        </summary>
        <div class="mt-2 space-y-2">
            <p class="text-surface-400">{m.media_languages_details()}</p>
            {#if summary?.isMissing}<p class="text-amber-200">
                    {m.media_languages_missing_file()}
                </p>{/if}
            <div>
                <p class="font-medium">{m.media_languages_audio()}</p>
                {#if summary?.audio.length}<ul>
                        {#each summary.audio as track, index (index)}<li>
                                {trackLabel(track)}
                            </li>{/each}
                    </ul>{:else}<p>{emptyLabel()}</p>{/if}
            </div>
            <div>
                <p class="font-medium">{m.media_languages_subtitles()}</p>
                {#if summary?.subtitles.length}<ul>
                        {#each summary.subtitles as track, index (index)}<li>
                                {trackLabel(track)}
                            </li>{/each}
                    </ul>{:else}<p>{emptyLabel()}</p>{/if}
            </div>
            {@render children?.()}
        </div>
    </details>
</div>
