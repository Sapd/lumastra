<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The library-wide ingest funnel, shown at the TOP of /admin/fix.

  ## Why it goes above the symptom list

  Every entry below it answers a question the operator brought. This asks the
  question for them, so it belongs before the point where they have to already
  know what is wrong. A drop-off here is a bug that would otherwise surface one
  title at a time, months apart, each reported as "this one film is missing".

  ## Silence is the good case, and it says so

  When nothing is being lost this collapses to a single line. A clean funnel
  rendering as an empty table would read as "not measured", which is the one
  thing this surface is not allowed to imply.

  ## Findings are the server's, not this component's

  `findingsFor` runs server-side over the same segments rendered here, so the
  summary and the numbers cannot tell different stories — and the rule that
  makes it honest (identification is not evaluated where a provider id is not
  expected) lives in one tested place rather than in this markup.
-->
<script lang="ts">
    import { Icon, CheckCircle, ExclamationTriangle, ArrowPath } from 'svelte-hero-icons';
    import {
        IngestFunnelSchema,
        type IngestFunnel,
        type FunnelFinding,
        type FunnelSampleKind,
        type IngestFunnelSamples,
        type FunnelSample,
        IngestFunnelSamplesSchema,
    } from '$lib/components/admin/fix/ingest-funnel.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { resolve } from '$lib/paths';
    import { fileHealthIssueLabel } from '$lib/utils/file-health-issue.js';
    import * as m from '$lib/paraglide/messages.js';

    /** Findings shown before collapsing to a count. Evidence, not an inventory. */
    const MAX_SHOWN = 5;

    let funnel = $state<IngestFunnel | null>(null);
    let loading = $state(false);
    /** The last load failed. Old counts, if any, stay up but are marked as not current. */
    let failed = $state(false);
    /**
     * Bumped on every load. A drill-down fetched against older counts must not
     * land after the reload cleared it, or the cached list would disagree with
     * the numbers above it.
     */
    let epoch = 0;

    async function load(): Promise<void> {
        loading = true;
        const res = await apiGet('/api/admin/fix/ingest-funnel', IngestFunnelSchema, {
            strict: true,
        });
        loading = false;
        // Quiet on failure — one muted line, never an error panel: this is a
        // proactive extra on an index page, and a broken banner here must not
        // make the symptom list below (the page's actual job) look broken too.
        // But not silent: "not measured" must not look like "nothing to report".
        failed = !res.data;
        if (res.data) {
            funnel = res.data;
            // Counts moved; lists fetched against the old ones would disagree.
            epoch += 1;
            drills = {};
            expanded = {};
        }
    }

    $effect(() => {
        void load();
    });

    function findingText(f: FunnelFinding): string {
        const args = { count: f.dropped, type: f.mediaType, outOf: f.outOf };
        switch (f.step) {
            case 'probed':
                return m.admin_fix_funnel_finding_probed(args);
            case 'identified':
                return m.admin_fix_funnel_finding_identified(args);
            default:
                return m.admin_fix_funnel_finding_visible(args);
        }
    }

    /**
     * The files behind each count, fetched when the operator asks. A count they
     * cannot open leaves them where a user report would have: knowing something
     * is wrong, not which title.
     */
    type Drill =
        { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; data: IngestFunnelSamples };
    let drills = $state<Record<string, Drill>>({});
    let expanded = $state<Record<string, boolean>>({});

    function drillKey(kind: FunnelSampleKind, mediaType: string | null): string {
        return mediaType ? `${mediaType}:${kind}` : kind;
    }

    async function toggle(kind: FunnelSampleKind, mediaType: string | null): Promise<void> {
        const key = drillKey(kind, mediaType);
        expanded[key] = !expanded[key];
        const prev = drills[key]?.state;
        if (!expanded[key] || prev === 'loaded' || prev === 'loading') return;
        const at = epoch;
        drills[key] = { state: 'loading' };
        const params = new URLSearchParams(mediaType ? { kind, mediaType } : { kind });
        const res = await apiGet(
            `/api/admin/fix/ingest-funnel/samples?${params.toString()}`,
            IngestFunnelSamplesSchema,
            { strict: true },
        );
        if (at !== epoch) return;
        drills[key] = res.data ? { state: 'loaded', data: res.data } : { state: 'failed' };
    }

    function sampleLabel(s: FunnelSample): string {
        if (!s.title) return basename(s.filePath);
        if (s.mediaType === 'episode' && s.showTitle) {
            const se =
                s.seasonNumber !== null && s.episodeNumber !== null
                    ? ` S${String(s.seasonNumber).padStart(2, '0')}E${String(s.episodeNumber).padStart(2, '0')}`
                    : '';
            return `${s.showTitle}${se} · ${s.title}`;
        }
        if (s.showTitle) return `${s.showTitle} · ${s.title}`;
        return s.title;
    }

    function basename(path: string): string {
        return path.split(/[\\/]/).pop() ?? path;
    }

    /**
     * where-is-it matches on the path, so the filename is the tightest query.
     * It refuses fewer than two characters, so a shorter name falls back to the
     * whole path.
     */
    function traceHref(s: FunnelSample): string {
        const name = basename(s.filePath);
        const q = (name.length >= 2 ? name : s.filePath).slice(-200);
        return `${resolve('/admin/fix/where-is-it')}?q=${encodeURIComponent(q)}`;
    }

    /** No file has been scanned yet: nothing was lost, but nothing reached the library either. */
    const noFiles = $derived(
        funnel !== null &&
            funnel.segments.length === 0 &&
            funnel.orphanFiles === 0 &&
            funnel.removedEntryFiles === 0 &&
            funnel.missingFiles === 0,
    );

    const clean = $derived(
        funnel !== null &&
            !noFiles &&
            funnel.findings.length === 0 &&
            funnel.orphanFiles === 0 &&
            funnel.removedEntryFiles === 0 &&
            funnel.missingFiles === 0,
    );
</script>

{#snippet drill(kind: FunnelSampleKind, mediaType: string | null)}
    {@const key = drillKey(kind, mediaType)}
    <button
        type="button"
        class="ml-6 text-xs text-primary-300 hover:text-primary-200"
        aria-expanded={expanded[key] ?? false}
        onclick={() => void toggle(kind, mediaType)}>
        {expanded[key] ? m.admin_fix_funnel_hide() : m.admin_fix_funnel_show()}
    </button>
    {#if expanded[key]}
        {@const d = drills[key]}
        <div class="mt-1 ml-6 max-h-80 overflow-y-auto rounded border border-surface-800">
            {#if !d || d.state === 'loading'}
                <p class="p-2 text-xs text-surface-400">{m.admin_fix_funnel_samples_loading()}</p>
            {:else if d.state === 'failed'}
                <p class="p-2 text-xs text-error-300">{m.admin_fix_funnel_samples_failed()}</p>
            {:else if d.data.samples.length === 0}
                <p class="p-2 text-xs text-surface-400">{m.admin_fix_funnel_samples_empty()}</p>
            {:else}
                <ul class="divide-y divide-surface-800">
                    {#each d.data.samples as s (s.fileId)}
                        <li class="space-y-0.5 px-2 py-1.5 text-xs">
                            <div class="flex flex-wrap items-baseline justify-between gap-x-3">
                                <span class="min-w-0 text-surface-200">{sampleLabel(s)}</span>
                                <span class="flex shrink-0 gap-3">
                                    {#if s.mediaItemId}
                                        <a
                                            href={resolve(
                                                `/admin/library/media/${encodeURIComponent(s.mediaItemId)}`,
                                            )}
                                            class="text-primary-300 hover:text-primary-200">
                                            {m.admin_fix_funnel_open_entry()}
                                        </a>
                                    {/if}
                                    <a
                                        href={traceHref(s)}
                                        class="text-primary-300 hover:text-primary-200">
                                        {m.admin_fix_funnel_trace()}
                                    </a>
                                </span>
                            </div>
                            <div class="font-mono break-all text-surface-400">{s.filePath}</div>
                            {#if s.issueType}
                                <div class="text-warning-300" title={s.issueDetail ?? undefined}>
                                    {fileHealthIssueLabel(s.issueType)}{#if s.issueDetail}<span
                                            class="line-clamp-2 text-surface-400"
                                            >{s.issueDetail}</span
                                        >{/if}
                                </div>
                            {/if}
                        </li>
                    {/each}
                </ul>
                {#if d.data.truncated}
                    <p class="border-t border-surface-800 p-2 text-xs text-surface-400">
                        {m.admin_fix_funnel_samples_truncated({ count: d.data.samples.length })}
                    </p>
                {/if}
            {/if}
        </div>
    {/if}
{/snippet}

{#if !funnel && failed}
    <p class="text-xs text-surface-500">{m.admin_fix_funnel_failed()}</p>
{/if}

{#if funnel}
    <section class="space-y-2 rounded-lg border border-surface-700 p-4">
        <div class="flex items-start justify-between gap-3">
            <div>
                <h2 class="text-sm font-medium text-surface-100">
                    {m.admin_fix_funnel_heading()}
                </h2>
                <p class="text-xs text-surface-400">{m.admin_fix_funnel_intro()}</p>
            </div>
            <button
                type="button"
                class="shrink-0 rounded border border-surface-700 px-2 py-0.5 text-xs text-surface-400 hover:bg-surface-800 disabled:opacity-50"
                disabled={loading}
                onclick={() => void load()}>
                <Icon src={ArrowPath} class="inline h-3 w-3 {loading ? 'animate-spin' : ''}" />
                {m.admin_fix_funnel_refresh()}
            </button>
        </div>

        {#if failed}
            <p class="text-xs text-warning-300">{m.admin_fix_funnel_stale()}</p>
        {/if}

        {#if noFiles}
            <p class="text-sm text-surface-300">{m.admin_fix_funnel_no_files()}</p>
        {:else if clean}
            <p class="flex items-center gap-2 text-sm text-surface-300">
                <Icon src={CheckCircle} class="h-4 w-4 shrink-0 text-success-300" />
                {m.admin_fix_funnel_clean()}
            </p>
        {:else}
            <ul class="space-y-1">
                {#if funnel.orphanFiles > 0}
                    <li>
                        <div class="flex items-start gap-2 text-sm text-surface-200">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-4 w-4 shrink-0 text-error-300" />
                            {m.admin_fix_funnel_orphans({ count: funnel.orphanFiles })}
                        </div>
                        {@render drill('orphans', null)}
                    </li>
                {/if}
                {#if funnel.removedEntryFiles > 0}
                    <li>
                        <div class="flex items-start gap-2 text-sm text-surface-200">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-4 w-4 shrink-0 text-surface-400" />
                            {m.admin_fix_funnel_removed_entry({ count: funnel.removedEntryFiles })}
                        </div>
                        {@render drill('removed-entry', null)}
                    </li>
                {/if}
                {#if funnel.missingFiles > 0}
                    <li>
                        <div class="flex items-start gap-2 text-sm text-surface-200">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-4 w-4 shrink-0 text-warning-300" />
                            {m.admin_fix_funnel_missing({ count: funnel.missingFiles })}
                        </div>
                        {@render drill('missing', null)}
                    </li>
                {/if}
                {#each funnel.findings.slice(0, MAX_SHOWN) as f (`${f.mediaType}:${f.step}`)}
                    <li>
                        <div class="flex items-start gap-2 text-sm text-surface-200">
                            <Icon
                                src={ExclamationTriangle}
                                class="mt-0.5 h-4 w-4 shrink-0 text-warning-300" />
                            {findingText(f)}
                        </div>
                        {@render drill(f.step, f.mediaType)}
                    </li>
                {/each}
                {#if funnel.findings.length > MAX_SHOWN}
                    <li class="text-xs text-surface-400">
                        {m.admin_fix_funnel_more({ count: funnel.findings.length - MAX_SHOWN })}
                    </li>
                {/if}
            </ul>

            <a
                href={resolve('/admin/fix/where-is-it')}
                class="inline-block text-xs text-primary-300 hover:text-primary-200">
                {m.admin_fix_funnel_investigate()}
            </a>
        {/if}
    </section>
{/if}
