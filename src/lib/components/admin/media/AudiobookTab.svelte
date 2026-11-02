<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The Book tab: what the AudiobookShelf connector actually wrote for this item.

  Read-only on purpose. Every value here is owned upstream — the next sweep
  overwrites the whole `custom_metadata.audiobookshelf` blob — so an edit field
  would promise a persistence this data does not have. Editing a book's title,
  year or description still works on the Overview tab, which writes columns the
  sweep does not touch.

  Absent values read "Not reported" rather than being skipped: an operator opens
  this tab *because* a book looks wrong, and "AudiobookShelf never sent a
  narrator" is the answer they came for, not a row worth hiding.
-->

<script lang="ts">
    import { tryJoinUpstreamUrl } from '$lib/shared/upstream-url.js';
    import * as m from '$lib/paraglide/messages.js';
    import { formatDuration } from '$lib/utils/time-formatting';
    import type { AudiobookAdminDetail } from '$lib/shared/audiobook-metadata';

    interface Props {
        detail: AudiobookAdminDetail;
        /**
         * `config.AUDIOURL` — the AudiobookShelf server this install syncs from.
         * Null when the integration is unconfigured, which suppresses the deep
         * link rather than rendering one that cannot resolve.
         */
        absBaseUrl: string | null;
    }

    let { detail, absBaseUrl }: Props = $props();

    /** Trailing slash tolerated: operators paste the URL from a browser bar. */
    let absItemUrl = $derived(
        absBaseUrl && detail.absItemId
            ? tryJoinUpstreamUrl(absBaseUrl, `/item/${encodeURIComponent(detail.absItemId)}`)
            : null,
    );

    let seriesLabel = $derived.by(() => {
        if (!detail.seriesName) return null;
        return detail.seriesSequence !== null
            ? `${detail.seriesName} #${detail.seriesSequence}`
            : detail.seriesName;
    });

    const SERIES_SOURCE_LABELS: Record<string, () => string> = {
        'abs-series': m.media_book_series_source_abs,
        folder: m.media_book_series_source_folder,
        none: m.media_book_series_source_none,
    };

    let seriesSourceLabel = $derived(
        detail.seriesSource ? (SERIES_SOURCE_LABELS[detail.seriesSource]?.() ?? null) : null,
    );

    /**
     * The tail span the chapter normaliser appends when the tagged chapters stop
     * before the audio does.
     *
     * Surfaced as a banner because it is a real, recurring ingest defect rather
     * than a display detail: a book whose chapter list covers half its runtime
     * looks fine in the player until a listener tries to skip past the gap.
     */
    let untaggedTail = $derived(detail.chapters.find((c) => c.synthetic === true) ?? null);

    let untaggedTailLength = $derived(
        untaggedTail ? formatDuration(untaggedTail.end - untaggedTail.start) : null,
    );

    function formatEpochMs(value: number | null): string | null {
        if (value === null) return null;
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
    }

    function yesNo(value: boolean | null): string | null {
        if (value === null) return null;
        return value ? m.media_status_yes() : m.media_status_no();
    }

    function joinList(values: string[]): string | null {
        return values.length > 0 ? values.join(', ') : null;
    }

    let identityRows = $derived([
        { label: m.media_book_subtitle(), value: detail.subtitle },
        { label: m.media_book_authors(), value: joinList(detail.authors) },
        { label: m.media_book_narrators(), value: joinList(detail.narrators) },
        { label: m.media_book_series(), value: seriesLabel, hint: seriesSourceLabel },
        { label: m.media_book_publisher(), value: detail.publisher },
        { label: m.media_book_published(), value: detail.publishedYear },
        { label: m.media_book_language(), value: detail.language },
        { label: m.media_book_genres(), value: joinList(detail.genres) },
        {
            label: m.media_book_duration(),
            value: detail.durationSeconds !== null ? formatDuration(detail.durationSeconds) : null,
        },
        { label: m.media_book_abridged(), value: yesNo(detail.abridged) },
        { label: m.media_book_explicit(), value: yesNo(detail.explicit) },
        { label: m.media_book_isbn(), value: detail.isbn },
        { label: m.media_book_asin(), value: detail.asin },
    ]);

    let upstreamRows = $derived([
        { label: m.media_book_item_id(), value: detail.absItemId, mono: true },
        { label: m.media_book_library_id(), value: detail.libraryId, mono: true },
        { label: m.media_book_path(), value: detail.relPath, mono: true },
        { label: m.media_book_added_at(), value: formatEpochMs(detail.addedAt), mono: false },
        { label: m.media_book_updated_at(), value: formatEpochMs(detail.updatedAt), mono: false },
        { label: m.media_book_mtime(), value: formatEpochMs(detail.mtimeMs), mono: false },
    ]);

    const sectionClass = 'rounded-lg border border-surface-700 bg-surface-800/40 p-4 space-y-3';
    const headingClass = 'text-xs text-surface-400 font-medium uppercase tracking-wide';
    const labelClass = 'text-xs text-surface-500';
    const cellClass = 'px-3 py-1.5 text-surface-300';
</script>

<div class="space-y-6">
    <!-- Identity -->
    <section class={sectionClass}>
        <h3 class={headingClass}>{m.media_book_section_identity()}</h3>
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {#each identityRows as row (row.label)}
                <div class="flex flex-col gap-0.5">
                    <dt class={labelClass}>{row.label}</dt>
                    <dd
                        class="text-sm {row.value
                            ? 'text-surface-200'
                            : 'text-surface-600 italic'}">
                        {row.value ?? m.media_book_not_reported()}
                        {#if row.value && row.hint}
                            <span class="text-xs text-surface-500">({row.hint})</span>
                        {/if}
                    </dd>
                </div>
            {/each}
        </dl>
    </section>

    <!-- Upstream identity -->
    <section class={sectionClass}>
        <div class="flex items-center justify-between gap-3">
            <h3 class={headingClass}>{m.media_book_section_upstream()}</h3>
            {#if absItemUrl}
                <a
                    href={absItemUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-xs text-primary-400 hover:text-primary-300 underline">
                    {m.media_book_open_in_abs()}
                </a>
            {/if}
        </div>
        <dl class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            {#each upstreamRows as row (row.label)}
                <div class="flex flex-col gap-0.5 min-w-0">
                    <dt class={labelClass}>{row.label}</dt>
                    <dd
                        class="text-sm break-all {row.mono ? 'font-mono text-xs' : ''} {row.value
                            ? 'text-surface-200'
                            : 'text-surface-600 italic'}">
                        {row.value ?? m.media_book_not_reported()}
                    </dd>
                </div>
            {/each}
        </dl>
    </section>

    <!-- Chapters -->
    <section class={sectionClass}>
        <h3 class={headingClass}>
            {m.media_book_section_chapters()}
            {#if detail.chapters.length > 0}
                <span class="text-surface-500 normal-case">({detail.chapters.length})</span>
            {/if}
        </h3>

        {#if untaggedTail && untaggedTailLength}
            <p
                class="rounded border border-yellow-700/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-300">
                {m.media_book_chapter_gap({ length: untaggedTailLength })}
            </p>
        {/if}

        {#if detail.chapters.length === 0}
            <p class="text-sm text-surface-500">{m.media_book_no_chapters()}</p>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-left text-xs text-surface-500 border-b border-surface-700">
                            <th class="px-3 py-1.5 w-12">#</th>
                            <th class="px-3 py-1.5">{m.media_book_col_title()}</th>
                            <th class="px-3 py-1.5 w-24">{m.media_book_col_start()}</th>
                            <th class="px-3 py-1.5 w-24">{m.media_book_col_end()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each detail.chapters as chapter, index (chapter.id)}
                            <tr class="border-b border-surface-800/60 last:border-0">
                                <td class="{cellClass} text-surface-500">{index + 1}</td>
                                <td class={cellClass}>
                                    {#if chapter.synthetic}
                                        <span class="text-yellow-400/80 italic"
                                            >{m.audiobook_chapter_untagged_tail()}</span>
                                    {:else}
                                        {chapter.title}
                                    {/if}
                                </td>
                                <td class="{cellClass} font-mono text-xs"
                                    >{formatDuration(chapter.start)}</td>
                                <td class="{cellClass} font-mono text-xs"
                                    >{formatDuration(chapter.end)}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>

    <!-- Audio files -->
    <section class={sectionClass}>
        <h3 class={headingClass}>
            {m.media_book_section_files()}
            {#if detail.audioFiles.length > 0}
                <span class="text-surface-500 normal-case">({detail.audioFiles.length})</span>
            {/if}
        </h3>

        {#if detail.audioFiles.length === 0}
            <p class="text-sm text-surface-500">{m.media_book_no_files()}</p>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead>
                        <tr class="text-left text-xs text-surface-500 border-b border-surface-700">
                            <th class="px-3 py-1.5 w-12">#</th>
                            <th class="px-3 py-1.5">{m.media_book_col_inode()}</th>
                            <th class="px-3 py-1.5 w-28">{m.media_book_col_duration()}</th>
                            <th class="px-3 py-1.5 w-40">{m.media_book_col_format()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each detail.audioFiles as file (file.index)}
                            <tr class="border-b border-surface-800/60 last:border-0">
                                <td class="{cellClass} text-surface-500">{file.index}</td>
                                <td class="{cellClass} font-mono text-xs"
                                    >{file.ino ?? m.media_book_not_reported()}</td>
                                <td class="{cellClass} font-mono text-xs">
                                    {file.duration !== null
                                        ? formatDuration(file.duration)
                                        : m.media_book_not_reported()}
                                </td>
                                <td class="{cellClass} text-xs">
                                    {[file.codec, file.mimeType].filter(Boolean).join(' · ') ||
                                        m.media_book_not_reported()}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>
</div>
