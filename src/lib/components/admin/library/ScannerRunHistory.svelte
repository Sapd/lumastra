<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  What the file scanner did to each library, last time it ran.

  The previous shape of this table was one row per (library path, run). Six
  paths means every scan cycle emitted six near-identical rows — and the table
  rendered no library identity at all, so "why are there so many scans" had no
  answer visible on the page. The default is now ONE row per library, newest
  run, with that library's earlier runs behind a chevron.

  Three columns were removed rather than relabelled:

  MATCH RATE was the number this table was built around and it was measuring
  the wrong thing. The generated column is `matched / total_files * 100`, and
  the writer sets `matched = added + updated` — so it reports CHURN. A
  fully-matched library that changed nothing overnight scores 0%. Across
  10,229 completed production runs the ">= 90% green" band fired twice while
  67% of runs rendered red; the real steady-state figures (music 8%, kids 11%,
  anime 23%, series 24%, movies 82%) are all healthy libraries. A number that
  is red on a healthy system trains the operator to ignore the table.

  MATCHED went with it: named for provider matching, actually a count of files
  changed. FILES CHANGED states that directly, as absolute counts and never a
  percentage — "no changes" is the reassurance an operator is looking for, so
  it is spelled out rather than shown as a bare zero.

  The column is named for FILES, not items, and that word is load-bearing. The
  writer increments once per file the scan walked — a video/audio file, but also
  every extras clip, poster sidecar and .srt — over exactly the population the
  FILES column counts. It is never a count of movies or episodes: /data/anime
  reported 6,599 against a library holding 823 media items. The number was ALSO
  a lie in a second way until 2026-08-27, and that is why "no changes" was
  unreachable: the artwork and subtitle passes returned 'added' for every file
  they touched, including the ~23,000 per cycle whose rows were already exactly
  right, so a library that had not gained a file since 2026-08-04 still reported
  five figures of additions every hour. Those two passes now report the steady
  state as 'skipped'. If this column ever shows a large `new` count on a library
  that gained nothing, suspect a third pass that cannot tell the two apart —
  do not relabel the column around it.

  UNMATCHED has never been non-zero in any recorded run. A column that is
  always 0 is not information.

  Colour is spent only where an action exists: red for errors and for
  abandoned, a sky pulse for running, nothing anywhere else. No green — a
  healthy table is monochrome and boring, which is what makes the one red cell
  on a bad morning visible. `status` and `durationMs` arrive already derived
  from the server so the 2h abandonment rule has exactly one implementation
  (tsgo does not typecheck `.svelte`, so a copy of it here would drift unseen).
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { getScannerRuns, getLatestScannerRunPerLibrary } from '$lib/api/admin.js';
    import { formatRelativeTime } from '$lib/utils/time-formatting';
    import { SCANNER_RUN_GLOBAL_SCOPE, type ScannerRun } from '$lib/schemas/api-admin-responses.js';

    interface Props {
        /** How many earlier runs to pull when a library row is expanded. */
        historyLimit?: number;
        /**
         * Scope to one library's folders — the per-library page's Scan
         * history section. Omitted on the overview page, which shows every
         * library merged together.
         */
        libraryGroupId?: string;
    }

    let { historyLimit = 10, libraryGroupId }: Props = $props();

    let runs = $state<ScannerRun[] | null>(null);
    let loading = $state(true);
    let loadFailed = $state(false);

    type HistoryState =
        { state: 'loading' } | { state: 'failed' } | { state: 'ready'; runs: ScannerRun[] };

    let history = $state<Record<string, HistoryState>>({});
    let openLibrary = $state<string | null>(null);
    let openErrors = $state<Record<string, boolean>>({});

    async function load(): Promise<void> {
        loading = true;
        const { data, error } = await getLatestScannerRunPerLibrary(libraryGroupId);
        // Rendering nothing is CORRECT for a fresh install that has never
        // scanned, which is why the empty case is silent — but it must not also
        // be what a broken endpoint looks like.
        loadFailed = Boolean(error) || !data;
        runs = data?.items ?? [];
        loading = false;
    }

    onMount(load);

    /**
     * The expansion key, and the scope the history request is made with.
     *
     * A global (scope='all') run has a null `libraryPathId`, and sending no
     * filter at all would return EVERY library's runs under a heading that
     * claims to be one library's history. The sentinel makes "runs with no
     * library path" a request the endpoint can actually express.
     */
    function libraryKey(r: ScannerRun): string {
        return r.libraryPathId ?? SCANNER_RUN_GLOBAL_SCOPE;
    }

    /**
     * Two different nulls. No `libraryPathId` means the run really was global.
     * A `libraryPathId` with no joined path means the path row was deleted
     * after the run — run history outlives the path it scanned, and silently
     * printing nothing there would read as a rendering bug.
     */
    function libraryLabel(r: ScannerRun): string {
        if (r.libraryPathId === null) return m.admin_scanner_runs_all_libraries();
        return r.libraryPath ?? m.admin_scanner_runs_removed_path();
    }

    function formatScanDuration(ms: number): string {
        const total = Math.max(0, Math.round(ms / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        if (hours > 0) {
            return `${m.time_hours_abbr({ hours })} ${m.time_minutes_abbr({ minutes })}`;
        }
        if (minutes > 0) {
            return `${m.time_minutes_abbr({ minutes })} ${m.time_seconds_abbr({ seconds })}`;
        }
        return m.time_seconds_abbr({ seconds });
    }

    /**
     * "35m ago · 2m 10s". A duration is shown only for a run that actually
     * finished: an abandoned row's `completedAt` is the moment the sweep gave
     * up on it, not the moment the work ended, so rendering that subtraction
     * as a duration would state a runtime that never happened.
     */
    function lastScanLabel(r: ScannerRun): string {
        const when = r.startedAt ? formatRelativeTime(r.startedAt) : '—';
        if (r.status !== 'completed' || r.durationMs === null) return when;
        return `${when} · ${formatScanDuration(r.durationMs)}`;
    }

    /** Null means "nothing changed" — rendered as reassuring copy, not a zero. */
    function changesLabel(r: ScannerRun): string | null {
        if (r.added <= 0 && r.updated <= 0) return null;
        return m.admin_scanner_runs_changes_summary({ added: r.added, updated: r.updated });
    }

    async function toggleHistory(r: ScannerRun): Promise<void> {
        const key = libraryKey(r);
        if (openLibrary === key) {
            openLibrary = null;
            return;
        }
        openLibrary = key;
        if (history[key]?.state === 'ready') return;
        history[key] = { state: 'loading' };
        const { data, error } = await getScannerRuns(historyLimit, key);
        history[key] = error || !data ? { state: 'failed' } : { state: 'ready', runs: data.items };
    }

    function toggleErrors(runId: string): void {
        openErrors[runId] = !openErrors[runId];
    }
</script>

{#snippet resultCell(r: ScannerRun)}
    <!--
      Status is checked BEFORE the error count, which is what keeps the
      `errors = -1` abandonment sentinel from ever reaching a number
      formatter: "-1 errors" is the exact wrong sentence for a run that
      never finished.
    -->
    {#if r.status === 'abandoned'}
        <span class="text-red-300">{m.admin_scanner_runs_abandoned()}</span>
    {:else if r.status === 'running'}
        <span class="inline-flex items-center gap-1.5 text-sky-300">
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300"></span>
            {m.admin_scanner_runs_running()}
        </span>
    {:else if r.errors > 0}
        <button
            type="button"
            class="text-red-300 underline decoration-dotted underline-offset-2"
            aria-expanded={Boolean(openErrors[r.id])}
            title={m.admin_scanner_runs_toggle_errors()}
            onclick={() => toggleErrors(r.id)}>
            {m.admin_scanner_runs_errors_count({ count: r.errors })}
        </button>
    {:else}
        <span class="text-surface-500">{m.admin_scanner_runs_ok()}</span>
    {/if}
{/snippet}

{#snippet errorSamples(r: ScannerRun)}
    <div class="space-y-1 text-xs">
        <p class="font-medium text-surface-300">
            {m.admin_scanner_runs_errors_heading({
                library: libraryLabel(r),
                when: r.startedAt ? formatRelativeTime(r.startedAt) : '—',
            })}
        </p>
        {#if r.errorSamples.length === 0}
            <p class="text-surface-500">{m.admin_scanner_runs_error_samples_none()}</p>
        {:else}
            <ul class="space-y-0.5 font-mono text-surface-400">
                {#each r.errorSamples as sample, i (i)}
                    <li class="break-all">
                        {sample}
                        <!--
                          U+FFFD in a path means the name on disk was not valid
                          UTF-8 and was decoded lossily, so the scanner can no
                          longer open the file under the name it listed. Older
                          runs only recorded "file processing failed" for it;
                          the operator's fix is always the same, so say it.
                        -->
                        {#if sample.includes('\uFFFD')}
                            <span class="block font-sans text-amber-300/90">
                                {m.admin_scanner_runs_error_bad_filename()}
                            </span>
                        {/if}
                    </li>
                {/each}
            </ul>
            <!--
              The samples are capped by the writer, so the array length is not
              the error count. Saying which of the two this list is prevents
              "8 errors" over a list of 20 reading as a contradiction.
            -->
            {#if r.errorSamples.length < r.errors}
                <p class="text-surface-500">
                    {m.admin_scanner_runs_error_samples_truncated({
                        shown: r.errorSamples.length,
                        total: r.errors,
                    })}
                </p>
            {/if}
        {/if}
    </div>
{/snippet}

{#if loading}
    <p class="text-hint py-2">{m.admin_scanner_runs_loading()}</p>
{:else if loadFailed}
    <p class="text-hint py-2">{m.admin_scanner_runs_unavailable()}</p>
{:else if runs && runs.length > 0}
    <div>
        <h4 class="mb-2 text-sm font-medium text-surface-300">{m.admin_scanner_runs_title()}</h4>
        <div class="overflow-x-auto rounded-lg border border-surface-700/50">
            <table class="w-full text-sm">
                <thead class="bg-surface-800/60 text-xs uppercase tracking-wide text-surface-400">
                    <tr>
                        <th class="px-3 py-2 text-left">{m.admin_scanner_runs_library()}</th>
                        <th class="px-3 py-2 text-left">{m.admin_scanner_runs_last_scan()}</th>
                        <th class="hidden px-3 py-2 text-right sm:table-cell"
                            >{m.admin_scanner_runs_files()}</th>
                        <th class="hidden px-3 py-2 text-left sm:table-cell"
                            >{m.admin_scanner_runs_changes()}</th>
                        <th class="px-3 py-2 text-left">{m.admin_scanner_runs_result()}</th>
                    </tr>
                </thead>
                <tbody class="divide-y divide-surface-700/50">
                    {#each runs as r (r.id)}
                        {@const key = libraryKey(r)}
                        {@const changes = changesLabel(r)}
                        <tr>
                            <td class="px-3 py-2 text-surface-200">
                                <button
                                    type="button"
                                    class="inline-flex items-center gap-1.5 text-left break-all"
                                    aria-expanded={openLibrary === key}
                                    title={m.admin_scanner_runs_toggle_history()}
                                    onclick={() => toggleHistory(r)}>
                                    <span
                                        class="text-surface-500 transition-transform"
                                        class:rotate-90={openLibrary === key}>›</span>
                                    {libraryLabel(r)}
                                </button>
                            </td>
                            <td class="px-3 py-2 text-surface-300">{lastScanLabel(r)}</td>
                            <td class="hidden px-3 py-2 text-right text-surface-300 sm:table-cell"
                                >{r.totalFiles.toLocaleString()}</td>
                            <td class="hidden px-3 py-2 sm:table-cell">
                                {#if changes}
                                    <span class="text-surface-300">{changes}</span>
                                {:else}
                                    <span class="text-surface-500"
                                        >{m.admin_scanner_runs_no_changes()}</span>
                                {/if}
                            </td>
                            <td class="px-3 py-2 whitespace-nowrap">
                                {@render resultCell(r)}
                            </td>
                        </tr>
                        <!--
                          The error list gets a row of its own. Rendered inside
                          the Result cell, 400 characters of path squeezed every
                          other column to a sliver and made one row screens tall.
                        -->
                        {#if openErrors[r.id]}
                            <tr class="bg-red-950/10">
                                <td class="px-3 py-2" colspan="5">
                                    {@render errorSamples(r)}
                                </td>
                            </tr>
                        {/if}
                        {#if openLibrary === key}
                            <tr class="bg-surface-900/40">
                                <td class="px-3 py-2" colspan="5">
                                    {#if history[key]?.state === 'loading'}
                                        <p class="text-hint">
                                            {m.admin_scanner_runs_history_loading()}
                                        </p>
                                    {:else if history[key]?.state === 'failed'}
                                        <p class="text-hint">
                                            {m.admin_scanner_runs_history_failed()}
                                        </p>
                                    {:else if history[key]?.state === 'ready'}
                                        {@const past = history[key].runs}
                                        {#if past.length === 0}
                                            <p class="text-hint">
                                                {m.admin_scanner_runs_history_empty()}
                                            </p>
                                        {:else}
                                            <table class="w-full text-xs">
                                                <thead class="text-surface-500">
                                                    <tr>
                                                        <th class="px-2 py-1 text-left"
                                                            >{m.admin_scanner_runs_when()}</th>
                                                        <th class="px-2 py-1 text-left"
                                                            >{m.admin_scanner_runs_duration()}</th>
                                                        <th
                                                            class="hidden px-2 py-1 text-right sm:table-cell"
                                                            >{m.admin_scanner_runs_files()}</th>
                                                        <th
                                                            class="hidden px-2 py-1 text-left sm:table-cell"
                                                            >{m.admin_scanner_runs_changes()}</th>
                                                        <th class="px-2 py-1 text-left"
                                                            >{m.admin_scanner_runs_result()}</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {#each past as p (p.id)}
                                                        {@const pChanges = changesLabel(p)}
                                                        <tr>
                                                            <td class="px-2 py-1 text-surface-300">
                                                                {p.startedAt
                                                                    ? formatRelativeTime(
                                                                          p.startedAt,
                                                                      )
                                                                    : '—'}
                                                            </td>
                                                            <td class="px-2 py-1 text-surface-400">
                                                                {p.status === 'completed' &&
                                                                p.durationMs !== null
                                                                    ? formatScanDuration(
                                                                          p.durationMs,
                                                                      )
                                                                    : '—'}
                                                            </td>
                                                            <td
                                                                class="hidden px-2 py-1 text-right text-surface-400 sm:table-cell"
                                                                >{p.totalFiles.toLocaleString()}</td>
                                                            <td
                                                                class="hidden px-2 py-1 text-surface-400 sm:table-cell">
                                                                {pChanges ??
                                                                    m.admin_scanner_runs_no_changes()}
                                                            </td>
                                                            <td class="px-2 py-1 whitespace-nowrap">
                                                                {@render resultCell(p)}
                                                            </td>
                                                        </tr>
                                                        {#if openErrors[p.id]}
                                                            <tr>
                                                                <td class="px-2 py-1" colspan="5">
                                                                    {@render errorSamples(p)}
                                                                </td>
                                                            </tr>
                                                        {/if}
                                                    {/each}
                                                </tbody>
                                            </table>
                                        {/if}
                                    {/if}
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        </div>
    </div>
{/if}
