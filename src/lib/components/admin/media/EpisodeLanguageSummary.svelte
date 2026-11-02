<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import type { EpisodeLanguageSummary } from '$lib/schemas/admin-language-summary.js';
    import FileLanguageSummary from './FileLanguageSummary.svelte';
    import * as m from '$lib/paraglide/messages.js';
    let { summary }: { summary?: EpisodeLanguageSummary | null } = $props();
    const selected = $derived(
        summary?.files.find((file) => file.fileId === summary.selectedFileId),
    );
    const alternates = $derived(
        summary?.files.filter((file) => file.fileId !== summary.selectedFileId) ?? [],
    );
    const scope = $derived(
        summary?.selection === 'default'
            ? m.media_languages_default_file()
            : summary?.selection === 'fallback'
              ? m.media_languages_fallback_file()
              : m.media_languages_no_file(),
    );
</script>

<section
    class="min-w-0 whitespace-normal"
    aria-label={m.media_languages_episode()}
    data-testid="episode-language-summary">
    <div role="region" aria-label={m.media_languages_playback()} class="min-w-0">
        <FileLanguageSummary summary={selected} {scope}>
            {#if selected}<p class="break-words text-surface-400">
                    {scope} · {selected.label}
                </p>{/if}
            {#if alternates.length}<div class="space-y-2">
                    <h4 class="font-medium">
                        {m.media_languages_alternates({ count: alternates.length })}
                    </h4>
                    <ul class="space-y-2">
                        {#each alternates as file (file.fileId)}<li class="min-w-0 space-y-1">
                                <p class="break-words font-medium">{file.label}</p>
                                <FileLanguageSummary
                                    summary={file}
                                    detailsLabel={m.media_languages_version_details({
                                        version: file.label,
                                    })} />
                            </li>{/each}
                    </ul>
                </div>{/if}
        </FileLanguageSummary>
    </div>
</section>
