<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, ExclamationTriangle } from 'svelte-hero-icons';
    import { resolve } from '$lib/paths';
    import { ADMIN_MEDIA_FILE_ISSUES_PATH } from '$lib/shared/admin-media-links.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        fileHealthIssueLabel,
        fileHealthIssueGuidance,
        fileHealthIssueTextClass,
        fileHealthIssueReason,
        isSevereHealthIssue,
    } from '$lib/utils/file-health-issue';

    /**
     * "What is actually wrong with this media" panel for the detail Overview.
     *
     * The media browser row already shows these on hover, but that tooltip is
     * gone the moment you click through to the item — which is exactly when you
     * want to act on it. Shows the recorded reason verbatim (for decode-time
     * issues that is the ffmpeg error including its byte offset), because
     * "Video ends early" on its own tells nobody which file to re-download.
     */
    /**
     * Stored shape, snake_case — matches `media_files.health_issues` and what
     * the Files tab gets from the API, so one formatter serves both.
     */
    interface IssueEntry {
        type: string;
        basis?: string;
        reviewed?: boolean;
        detail?: string;
        detected_at?: string;
        expected_duration?: number;
        actual_duration?: number;
    }

    interface FileEntry {
        fileId: string;
        filePath: string;
        mediaItemId: string;
        mediaTitle: string | null;
        seasonNumber: number | null;
        episodeNumber: number | null;
        issues: IssueEntry[];
    }

    interface Props {
        /** This item's id — used to tell own files from descendants'. */
        mediaId: string;
        files: FileEntry[];
    }

    let { mediaId, files }: Props = $props();

    let totalIssues = $derived(files.reduce((n, f) => n + f.issues.length, 0));
    let anySevere = $derived(
        files.some((f) => f.issues.some((i) => isSevereHealthIssue(i.type, i.basis))),
    );

    /** Just the filename — the library path is noise here. */
    function baseName(path: string): string {
        const parts = path.split('/');
        return parts[parts.length - 1] || path;
    }

    /** "S01E10 · Title" for a descendant, nothing for the item's own file. */
    function scopeLabel(f: FileEntry): string | null {
        if (f.mediaItemId === mediaId) return null;
        const se =
            f.seasonNumber != null && f.episodeNumber != null
                ? `S${String(f.seasonNumber).padStart(2, '0')}E${String(f.episodeNumber).padStart(2, '0')}`
                : null;
        return [se, f.mediaTitle].filter(Boolean).join(' · ') || null;
    }
</script>

{#if totalIssues > 0}
    <section
        class="rounded-lg border {anySevere
            ? 'border-red-800/40 bg-red-950/20'
            : 'border-amber-800/40 bg-amber-950/20'} p-4"
        aria-label={m.admin_media_file_issues_label()}>
        <div class="mb-3 flex items-center gap-2">
            <Icon
                src={ExclamationTriangle}
                class="w-4 h-4 shrink-0 {anySevere ? 'text-red-400' : 'text-amber-400'}"
                aria-hidden="true" />
            <h3 class="text-sm font-semibold text-surface-100">
                {m.admin_media_file_issues_label()}
            </h3>
            <span class="text-xs text-surface-400"
                >{m.admin_media_file_issues_count({ count: totalIssues })}</span>
        </div>

        <div class="space-y-3">
            {#each files as file (file.fileId)}
                {@const scope = scopeLabel(file)}
                <div class="space-y-1">
                    <div class="flex flex-wrap items-baseline gap-x-2 text-xs">
                        {#if scope}
                            <!-- Series/season view: name the episode, and let the
                                 admin jump straight to the item that owns it. -->
                            <a
                                href={resolve(`/admin/library/media/${file.mediaItemId}`)}
                                class="font-medium text-primary-400 hover:text-primary-300 hover:underline"
                                >{scope}</a>
                        {/if}
                        <span class="font-mono text-surface-500 break-all"
                            >{baseName(file.filePath)}</span>
                    </div>
                    {#each file.issues as issue, issueIdx (issue.type + '__' + issueIdx)}
                        {@const reason = fileHealthIssueReason(issue)}
                        {@const guidance = fileHealthIssueGuidance(issue)}
                        <div class="flex items-start gap-1.5 pl-1 text-xs">
                            <span
                                class="shrink-0 font-medium {fileHealthIssueTextClass(
                                    issue.type,
                                    issue.basis,
                                )}"
                                >{issue.reviewed
                                    ? m.admin_health_review_classification()
                                    : fileHealthIssueLabel(issue.type, issue.basis)}</span>
                            {#if reason}
                                <span class="min-w-0 text-surface-300">{reason}</span>
                            {/if}
                        </div>
                        {#if guidance}
                            <p class="pl-1 text-xs text-surface-400">{guidance}</p>
                        {/if}
                    {/each}
                </div>
            {/each}
        </div>

        <a
            href={resolve(ADMIN_MEDIA_FILE_ISSUES_PATH)}
            class="mt-3 inline-block text-xs text-primary-400 hover:text-primary-300 hover:underline"
            >{m.admin_media_file_issues_see_all()}</a>
    </section>
{/if}
