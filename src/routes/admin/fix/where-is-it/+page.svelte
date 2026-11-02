<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  /admin/fix/where-is-it — "I added a film. Where is it?"

  ## The one page here searched by NAME

  Every other explainer on this surface takes a media UUID, which works when the
  item exists and is useless in the case people actually report: the file was
  copied to disk and never appeared, so there is no UUID to paste. The only
  identifier the operator has is what they called it.

  ## The chain, and where it stopped

  The result is not "found / not found" — it is the ingest sequence with the
  first step that did not happen marked. "The file is on disk and was read, but
  no library entry was ever created from it" ends an investigation; "not found"
  restarts it.

  ## The empty result is an answer too

  When nothing matches, the next question is always "has the scan even run?", so
  that travels with the miss rather than sending the operator to another page to
  find out.
-->
<script lang="ts">
    import { Icon, CheckCircle, XCircle, QuestionMarkCircle } from 'svelte-hero-icons';
    import { untrack } from 'svelte';
    import { page } from '$app/state';
    import FixPageShell from '$lib/components/admin/fix/FixPageShell.svelte';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import { findSymptom } from '$lib/components/admin/fix/symptoms.js';
    import {
        WhereIsItSchema,
        type WhereIsIt,
        type TraceStep,
    } from '$lib/components/admin/fix/where-is-it.schema.js';
    import { apiGet } from '$lib/api/client.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { resolve } from '$lib/paths';
    import { formatFileSize } from '$lib/utils/metric-formatters.js';
    import * as m from '$lib/paraglide/messages.js';

    const symptom = findSymptom('where-is-it');

    let query = $state(page.url.searchParams.get('q') ?? '');
    let result = $state<WhereIsIt | null>(null);
    let loading = $state(false);
    let loadError = $state<ClassifiedError | null>(null);

    /** Only the newest search may write the result; an older one finishing late is dropped. */
    let runSeq = 0;

    async function run(): Promise<void> {
        const q = query.trim();
        if (q.length < 2) return;
        const seq = ++runSeq;
        loading = true;
        loadError = null;
        result = null;
        const params = new URLSearchParams({ q });
        const res = await apiGet(
            `/api/admin/fix/where-is-it?${params.toString()}`,
            WhereIsItSchema,
            { strict: true },
        );
        if (seq !== runSeq) return;
        loading = false;
        if (res.data) {
            result = res.data;
        } else if (res.error) {
            loadError = classifyError(new Error(res.error), { status: res.status });
        }
    }

    // Deep-linkable: ?q=… runs once on arrival, so this page can be linked to
    // from anywhere that already knows what the operator is looking for. Only
    // the URL's query auto-runs; typing searches on submit, not per keystroke.
    $effect(() => {
        if (untrack(() => query.trim().length >= 2)) untrack(() => void run());
    });

    /** Some step neither happened nor failed for sure — not "all the way through". */
    function partial(match: WhereIsIt['matches'][number]): boolean {
        return match.steps.some((s) => s.status === 'unknown');
    }

    function unreadableLabel(u: WhereIsIt['unreadable'][number]): string {
        switch (u) {
            case 'quarantine':
                return m.admin_fix_where_unreadable_quarantine();
            case 'schedule':
                return m.admin_fix_where_unreadable_schedule();
            case 'runs':
                return m.admin_fix_where_unreadable_runs_short();
            case 'stages':
                return m.admin_fix_where_unreadable_stages();
            default:
                return m.admin_fix_where_unreadable_item_files();
        }
    }

    function stepLabel(s: TraceStep['step']): string {
        switch (s) {
            case 'file-on-disk':
                return m.admin_fix_where_step_file_on_disk();
            case 'file-probed':
                return m.admin_fix_where_step_file_probed();
            case 'linked-to-item':
                return m.admin_fix_where_step_linked_to_item();
            case 'item-identified':
                return m.admin_fix_where_step_item_identified();
            case 'item-visible':
                return m.admin_fix_where_step_item_visible();
            default:
                return m.admin_fix_where_step_stages_processed();
        }
    }

    /**
     * A step's explanation in the user's language. The server sends a code and
     * its params (raw values: path, bytes, ISO date); an unknown code (a newer
     * server) falls back to the English `detail`.
     */
    function stepDetail(st: TraceStep): string {
        // Each code's message takes exactly the params the server sends for it,
        // so the record is passed through as-is.
        const p = st.params;
        switch (st.code) {
            case 'file-present':
                return m.admin_fix_where_detail_file_present({
                    path: String(p.path),
                    size:
                        typeof p.bytes === 'number' && p.bytes >= 0
                            ? formatFileSize(p.bytes)
                            : m.admin_fix_where_size_unknown(),
                });
            case 'probed': {
                const date = new Date(String(p.at)).toLocaleDateString();
                return p.container
                    ? m.admin_fix_where_detail_probed_container({
                          date,
                          container: String(p.container),
                      })
                    : m.admin_fix_where_detail_probed({ date });
            }
            case 'file-unreadable':
                return m.admin_fix_where_detail_file_unreadable(p as never);
            case 'file-container':
                return m.admin_fix_where_detail_file_container(p as never);
            case 'file-none-linked':
                return m.admin_fix_where_detail_file_none_linked(p as never);
            case 'file-missing':
                return m.admin_fix_where_detail_file_missing(p as never);
            case 'file-no-match':
                return m.admin_fix_where_detail_file_no_match(p as never);
            case 'not-probed':
                return m.admin_fix_where_detail_not_probed(p as never);
            case 'linked':
                return m.admin_fix_where_detail_linked(p as never);
            case 'file-not-linked':
                return m.admin_fix_where_detail_file_not_linked(p as never);
            case 'no-entry':
                return m.admin_fix_where_detail_no_entry(p as never);
            case 'identified':
                return m.admin_fix_where_detail_identified(p as never);
            case 'not-identified':
                return m.admin_fix_where_detail_not_identified(p as never);
            case 'entry-status':
                return m.admin_fix_where_detail_entry_status(p as never);
            case 'visible':
                return m.admin_fix_where_detail_visible(p as never);
            case 'container-visible':
                return m.admin_fix_where_detail_container_visible(p as never);
            case 'not-visible':
                return m.admin_fix_where_detail_not_visible(p as never);
            case 'stages-unreadable':
                return m.admin_fix_where_detail_stages_unreadable(p as never);
            case 'stages-none':
                return m.admin_fix_where_detail_stages_none(p as never);
            case 'stages-gave-up':
                return m.admin_fix_where_detail_stages_gave_up(p as never);
            case 'stages-pending':
                return m.admin_fix_where_detail_stages_pending(p as never);
            case 'stages-done':
                return m.admin_fix_where_detail_stages_done(p as never);
            default:
                return st.detail;
        }
    }

    function when(iso: string | null): string {
        return iso ? new Date(iso).toLocaleString() : '—';
    }
</script>

{#if symptom}
    <FixPageShell title={symptom.title()} icon={symptom.icon}>
        <p class="max-w-3xl text-sm leading-relaxed text-surface-300">
            {m.admin_fix_where_intro()}
        </p>

        <form
            class="flex flex-wrap items-end gap-3"
            onsubmit={(e) => {
                e.preventDefault();
                void run();
            }}>
            <label class="flex flex-col gap-1">
                <span class="text-xs text-surface-400">{m.admin_fix_where_label()}</span>
                <input
                    bind:value={query}
                    placeholder={m.admin_fix_where_placeholder()}
                    class="w-96 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm text-surface-100" />
            </label>
            <button
                type="submit"
                disabled={loading || query.trim().length < 2}
                class="rounded bg-primary-700 px-3 py-1.5 text-sm text-white hover:bg-primary-600 disabled:opacity-50">
                {m.admin_fix_where_run()}
            </button>
        </form>

        <AsyncSection {loading} error={loadError} onretry={() => void run()}>
            {#if result}
                <div class="space-y-6">
                    {#if result.unreadable.length > 0}
                        <p role="alert" class="text-sm text-warning-300">
                            {m.admin_fix_where_unreadable({
                                what: result.unreadable.map(unreadableLabel).join(', '),
                            })}
                        </p>
                    {/if}
                    {#if result.matches.length === 0 && result.quarantined.length === 0}
                        <!--
                          The miss carries its own context: "has the scan run?" is
                          always the next question, and answering it here saves a
                          hop to another page.
                        -->
                        <div class="space-y-2 rounded-lg border border-surface-700 p-4">
                            <p class="text-sm font-medium text-surface-100">
                                {m.admin_fix_where_none_title({ query: result.query })}
                            </p>
                            <p class="text-sm text-surface-300">
                                {m.admin_fix_where_none_body()}
                            </p>
                            {#if result.scanEnabled === false}
                                <p class="text-sm text-warning-300">
                                    {m.admin_fix_where_none_scan_off()}
                                </p>
                            {/if}
                            <p class="text-xs text-surface-400">
                                {result.lastScanCompletedAt
                                    ? m.admin_fix_where_none_lastscan({
                                          when: when(result.lastScanCompletedAt),
                                      })
                                    : result.unreadable.includes('runs')
                                      ? m.admin_fix_where_unreadable_runs()
                                      : m.admin_fix_where_none_neverscanned()}
                            </p>
                            <a
                                href={resolve('/admin/fix/new-files')}
                                class="inline-block text-sm text-primary-300 hover:text-primary-200">
                                {m.admin_symptom_new_files()}
                            </a>
                        </div>
                    {/if}

                    {#each result.matches as match, i (match.mediaItemId ?? match.filePath ?? i)}
                        <section class="space-y-2 rounded-lg border border-surface-700 p-4">
                            <div class="flex flex-wrap items-baseline gap-x-3">
                                <h2 class="text-sm font-medium text-surface-100">{match.title}</h2>
                                {#if match.mediaType}
                                    <span class="text-xs text-surface-400">{match.mediaType}</span>
                                {/if}
                                {#if match.fileMissing}
                                    <span class="text-xs text-error-300">
                                        {m.admin_fix_where_file_missing()}
                                    </span>
                                {/if}
                            </div>

                            {#if match.stoppedAt}
                                <p class="text-sm text-error-300">
                                    {m.admin_fix_where_stopped({
                                        step: stepLabel(match.stoppedAt as TraceStep['step']),
                                    })}
                                </p>
                            {:else if partial(match)}
                                <p class="text-sm text-surface-300">
                                    {m.admin_fix_where_partial()}
                                </p>
                            {:else}
                                <p class="text-sm text-success-300">
                                    {m.admin_fix_where_complete()}
                                </p>
                            {/if}

                            <ul class="space-y-1.5">
                                {#each match.steps as s (s.step)}
                                    <li class="flex items-start gap-2">
                                        <Icon
                                            src={s.status === 'ok'
                                                ? CheckCircle
                                                : s.status === 'blocked'
                                                  ? XCircle
                                                  : QuestionMarkCircle}
                                            class="mt-0.5 h-4 w-4 shrink-0 {s.status === 'ok'
                                                ? 'text-success-300'
                                                : s.status === 'blocked'
                                                  ? 'text-error-300'
                                                  : 'text-surface-500'}" />
                                        <div>
                                            <p class="text-sm text-surface-200">
                                                {stepLabel(s.step)}
                                            </p>
                                            <p
                                                class="break-all text-xs leading-relaxed text-surface-400">
                                                {stepDetail(s)}
                                            </p>
                                        </div>
                                    </li>
                                {/each}
                            </ul>

                            {#if match.stages.length > 0}
                                <details class="text-xs">
                                    <summary class="cursor-pointer text-surface-400">
                                        {m.admin_fix_where_stages_heading()}
                                    </summary>
                                    <ul class="mt-1 space-y-0.5">
                                        {#each match.stages as st (st.stageId)}
                                            <li class="flex flex-wrap gap-x-2 text-surface-400">
                                                <span class="font-mono">{st.stageId}</span>
                                                <span>{st.status}</span>
                                                {#if st.attempt > 0}
                                                    <span>
                                                        {m.admin_fix_where_attempt({
                                                            count: st.attempt,
                                                        })}
                                                    </span>
                                                {/if}
                                                {#if st.lastError}
                                                    <span class="text-error-300">
                                                        {st.lastError}
                                                    </span>
                                                {/if}
                                            </li>
                                        {/each}
                                    </ul>
                                </details>
                            {/if}

                            {#if match.mediaItemId}
                                <div class="flex flex-wrap gap-3 pt-1 text-xs">
                                    <a
                                        href={resolve(
                                            `/admin/library/media/${encodeURIComponent(match.mediaItemId)}`,
                                        )}
                                        class="text-primary-300 hover:text-primary-200">
                                        {m.admin_fix_where_open_item()}
                                    </a>
                                    <a
                                        href={`${resolve('/admin/fix/user-cannot-see')}?mediaId=${encodeURIComponent(match.mediaItemId)}`}
                                        class="text-primary-300 hover:text-primary-200">
                                        {m.admin_fix_where_why_hidden()}
                                    </a>
                                </div>
                            {/if}
                        </section>
                    {/each}

                    {#if result.truncated}
                        <p class="text-xs text-surface-400">
                            {m.admin_fix_where_truncated({ count: result.matches.length })}
                        </p>
                    {/if}

                    {#if result.quarantined.length > 0}
                        <section class="space-y-2">
                            <h2 class="text-sm font-medium text-surface-200">
                                {m.admin_fix_where_quarantined_heading()}
                            </h2>
                            <p class="max-w-3xl text-xs leading-relaxed text-surface-400">
                                {m.admin_fix_where_quarantined_body()}
                            </p>
                            <ul class="divide-y divide-surface-800 text-xs">
                                {#each result.quarantined as qr, i (`${qr.provider}:${qr.externalId}:${i}`)}
                                    <li class="flex flex-wrap gap-x-3 py-1.5">
                                        <span class="font-mono text-surface-300">
                                            {qr.provider}:{qr.externalId}
                                        </span>
                                        <span class="text-surface-400">{qr.mediaType}</span>
                                        <span class="text-error-300">{qr.reason}</span>
                                        <span class="ml-auto text-surface-500">
                                            {when(qr.createdAt)}
                                        </span>
                                    </li>
                                {/each}
                            </ul>
                        </section>
                    {/if}
                </div>
            {/if}
        </AsyncSection>
    </FixPageShell>
{/if}
