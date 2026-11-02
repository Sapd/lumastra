<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  A row's Issues cell (triage spec §3). Healthy rows render nothing. Each badge
  names its problem; the caller opens a saved view or the affected item's Files tab. The hover (`title`) carries the recorded reason.
  Info notes (Not linked to Jellyfin) are not problems: they render as muted
  text after the pills, never as a coloured badge.

  Clicks stop propagation: a row click opens the inspector, a badge click
  changes the view, and one gesture must not do both.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import {
        ISSUE_VIEW,
        noteIssues,
        problemIssues,
        type MediaBrowserView,
        type MediaIssue,
    } from '$lib/shared/media-issues.js';
    import {
        mediaIssueLabel,
        severityBadgeClass,
        severityDotClass,
    } from './media-issue-presentation.js';

    interface Props {
        issues: readonly MediaIssue[];
        mediaType: string;
        /** Badges shown before collapsing the rest into "+N". */
        max?: number;
        /** Retained for callers; Tooltip now creates and manages its own description ID. */
        tooltipId?: string;
        onselectview: (view: MediaBrowserView) => void;
    }
    let { issues, mediaType, max = 3, onselectview }: Props = $props();

    let problems = $derived(problemIssues(issues));
    let notes = $derived(noteIssues(issues));
    let visible = $derived(problems.slice(0, max));
    let hiddenCount = $derived(Math.max(0, problems.length - max));
    let hidden = $derived(problems.slice(max));
</script>

{#if issues.length > 0}
    <div class="flex flex-wrap items-center gap-1.5">
        {#each visible as issue, i (issue.kind + (issue.subtype ?? '') + i)}
            <button
                type="button"
                class="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium hover:brightness-125 {severityBadgeClass(
                    issue.severity,
                )}"
                title={issue.detail}
                onclick={(e) => {
                    e.stopPropagation();
                    onselectview(ISSUE_VIEW[issue.kind]);
                }}>
                <span class="h-1.5 w-1.5 rounded-full {severityDotClass(issue.severity)}"></span>
                {mediaIssueLabel(issue, mediaType)}
            </button>
        {/each}
        {#if hiddenCount > 0}
            <Tooltip
                lines={hidden.flatMap((issue) =>
                    issue.detail
                        ? [
                              { text: mediaIssueLabel(issue, mediaType), class: 'font-medium' },
                              { text: issue.detail },
                          ]
                        : [{ text: mediaIssueLabel(issue, mediaType), class: 'font-medium' }],
                )}
                position="top"
                fixed
                inline
                wrap
                delay={0}
                toggleOnClick={false}>
                <button
                    type="button"
                    class="inline-flex h-6 items-center rounded-full border border-surface-600 px-2 text-[11px] text-surface-300 hover:border-surface-400 hover:text-surface-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400"
                    aria-label={m.media_issues_more({ count: hiddenCount })}>
                    {m.media_issues_more({ count: hiddenCount })}
                </button>
            </Tooltip>
        {/if}
        {#each notes as note (note.kind)}
            <button
                type="button"
                class="whitespace-nowrap text-[11px] text-surface-500 hover:text-surface-300 hover:underline"
                onclick={(e) => {
                    e.stopPropagation();
                    onselectview(ISSUE_VIEW[note.kind]);
                }}>{mediaIssueLabel(note, mediaType)}</button>
        {/each}
    </div>
{/if}
