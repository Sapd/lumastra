<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Two levels in one route: an incident table (failed/recovered tabs) grouped
  by (category, encoder), and a session detail drawer. `listFailureIncidents`
  is aggregate-only (occurrence counts, no session/file identifiers survive
  its GROUP BY), so expanding a row fetches the incident's own per-session
  breakdown (`listIncidentSessions` / the `incident-sessions` endpoint) —
  clicking a session there opens the existing detail drawer. Never renders a
  filesystem path: the session list shows a media title or a short file id,
  never `file_path`.
-->
<script lang="ts">
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import {
        Icon,
        ChevronDown,
        ChevronRight,
        XMark,
        Trash,
        ClipboardDocument,
    } from 'svelte-hero-icons';
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import AsyncSection from '$lib/components/admin/AsyncSection.svelte';
    import DetailPanel from '$lib/components/admin/detail/DetailPanel.svelte';
    import Tabs from '$lib/components/ui/Tabs.svelte';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import TranscodeFailureDetail from '$lib/components/admin/playback/TranscodeFailureDetail.svelte';
    import { apiGet, apiDelete } from '$lib/api/client.js';
    import {
        TranscodeIncidentsResponseSchema,
        TranscodeClearedResponseSchema,
        TranscodeIncidentSessionsResponseSchema,
        TranscodeFailureSessionResponseSchema,
        type TranscodeIncident,
        type TranscodeIncidentSession,
        type TranscodeFailureAttempt,
    } from '$lib/schemas/api-transcode-failures.js';
    import { classifyError, type ClassifiedError } from '$lib/utils/admin/error-contract.js';
    import { formatTranscodeIncidentsReport } from '$lib/shared/transcode-failure-report.js';
    import { isRedactionAvailable } from '$lib/shared/diagnostics-report.js';
    import { formatRelativeTime } from '$lib/utils/time-formatting.js';
    import { formatAttempts } from '$lib/utils/admin/formatters.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import * as m from '$lib/paraglide/messages.js';
    import {
        formatFailureCategory,
        formatEncoderName,
    } from '$lib/components/admin/transcode-failures/format.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    type Outcome = 'failed' | 'recovered';

    let outcome = $state<Outcome>('failed');
    let incidents = $state<TranscodeIncident[]>([]);
    // The server lists the newest groups only; when more exist, say so, and
    // never bulk-delete groups the operator was not shown.
    let incidentsTruncated = $state(false);
    let totalGroups = $state(0);
    let incidentsLoading = $state(false);
    let incidentsError = $state<ClassifiedError | null>(null);

    // Health-invariant "Open Transcode Failures" findings deep-link here as
    // `?encoder=<name>` (see health-invariants/invariants.ts) — the whole point
    // of a per-encoder detail row is landing on THAT encoder's incidents, not
    // the unfiltered list. `page.url.searchParams` is reactive under `$app/state`.
    let encoderFilter = $derived(page.url.searchParams.get('encoder'));

    let visibleIncidents = $derived(
        encoderFilter === null
            ? incidents
            : incidents.filter((i) => (i.encoder ?? 'software') === encoderFilter),
    );

    function clearEncoderFilter(): void {
        const url = new URL(page.url);
        url.searchParams.delete('encoder');
        void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
    }

    // The incident currently expanded (holds category+encoder — both are
    // needed to re-fetch its sessions), and that fetch's own state.
    let expandedIncident = $state<TranscodeIncident | null>(null);
    let sessions = $state<TranscodeIncidentSession[]>([]);
    let sessionsLoading = $state(false);
    let sessionsError = $state<ClassifiedError | null>(null);

    let selectedSessionId = $state<string | null>(null);
    let attempts = $state<TranscodeFailureAttempt[]>([]);
    let detailLoading = $state(false);
    let detailError = $state<ClassifiedError | null>(null);

    const detailTabs = $derived([
        { id: 'attempts', label: m.admin_transcode_failures_detail_tab_attempts() },
    ] as const);

    function rowKey(incident: TranscodeIncident): string {
        return `${incident.category}::${incident.encoder ?? ''}`;
    }

    /** Localized absolute time for a `title` tooltip — never the US-formatted default locale. */
    function absoluteTimestamp(iso: string): string {
        const parsed = new Date(iso);
        return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString(getLocale());
    }

    /** Short, non-identifying label — never the file path. */
    function sessionLabel(session: TranscodeIncidentSession): string {
        if (session.mediaTitle) return session.mediaTitle;
        if (session.fileId) return `file ${session.fileId.slice(0, 8)}…`;
        return m.admin_transcode_failures_session_no_linked_file();
    }

    /** `{category} / {encoder label}` for confirmation copy and aria-labels. */
    function incidentLabel(incident: TranscodeIncident): string {
        return `${formatFailureCategory(incident.category).label} / ${formatEncoderName(incident.encoder).label}`;
    }

    // Request sequence numbers: a tab switch, row expand or session click can
    // overlap an earlier request, and only the newest one may land.
    let incidentsSeq = 0;
    let sessionsSeq = 0;
    let detailSeq = 0;

    async function loadIncidents(): Promise<void> {
        const seq = ++incidentsSeq;
        sessionsSeq++;
        incidentsLoading = true;
        incidentsError = null;
        expandedIncident = null;
        sessions = [];
        const {
            data: result,
            error,
            status,
        } = await apiGet(
            // The encoder deep link filters server-side, so every group of that
            // encoder is listed — not only those inside the newest-100 cut.
            `/api/admin/transcode-failures?${new SvelteURLSearchParams({
                outcome,
                ...(encoderFilter !== null ? { encoder: encoderFilter } : {}),
            }).toString()}`,
            TranscodeIncidentsResponseSchema,
        );
        if (seq !== incidentsSeq) return;
        incidentsLoading = false;
        if (error || !result) {
            incidentsError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        incidents = result.incidents;
        incidentsTruncated = result.truncated === true;
        totalGroups = result.totalGroups ?? result.incidents.length;
    }

    async function loadIncidentSessions(incident: TranscodeIncident): Promise<void> {
        const seq = ++sessionsSeq;
        sessions = [];
        sessionsError = null;
        sessionsLoading = true;
        const params = new SvelteURLSearchParams({ category: incident.category, outcome });
        if (incident.encoder) params.set('encoder', incident.encoder);
        const {
            data: result,
            error,
            status,
        } = await apiGet(
            `/api/admin/transcode-failures/incident-sessions?${params.toString()}`,
            TranscodeIncidentSessionsResponseSchema,
        );
        if (seq !== sessionsSeq) return;
        sessionsLoading = false;
        if (error || !result) {
            sessionsError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        sessions = result.sessions;
    }

    function toggleRow(incident: TranscodeIncident): void {
        const key = rowKey(incident);
        if (expandedIncident && rowKey(expandedIncident) === key) {
            expandedIncident = null;
            sessionsSeq++;
            sessionsLoading = false;
            return;
        }
        expandedIncident = incident;
        void loadIncidentSessions(incident);
    }

    async function openSession(rawId: string): Promise<void> {
        const id = rawId.trim();
        if (!id) return;
        const seq = ++detailSeq;
        selectedSessionId = id;
        detailLoading = true;
        detailError = null;
        attempts = [];
        const {
            data: result,
            error,
            status,
        } = await apiGet(
            `/api/admin/transcode-failures/session/${encodeURIComponent(id)}`,
            TranscodeFailureSessionResponseSchema,
        );
        if (seq !== detailSeq) return;
        detailLoading = false;
        if (error || !result) {
            detailError = classifyError(new Error(error ?? undefined), { status });
            return;
        }
        attempts = result.attempts;
    }

    // Page-level "Copy for GitHub": the visible table, or — once a row is
    // expanded — that incident with its session breakdown and, if a session
    // drawer is open, that session's attempt chain. Same fail-loud rule as the
    // diagnostics page and the drawer's own button: with no library root known,
    // `redactPaths` is a no-op, so the button is disabled rather than handing
    // out a "redacted" report that is not.
    let redactionUnavailable = $derived(!isRedactionAvailable(data.roots));
    let copyDisabled = $derived(
        visibleIncidents.length === 0 || incidentsLoading || redactionUnavailable,
    );
    let copyScope = $derived(
        expandedIncident === null
            ? m.admin_transcode_failures_scope_visible_list()
            : selectedSessionId !== null && attempts.length > 0
              ? m.admin_transcode_failures_scope_incident_and_session()
              : m.admin_transcode_failures_scope_incident(),
    );

    async function copyForGitHub(): Promise<void> {
        if (copyDisabled) return;
        const report = formatTranscodeIncidentsReport({
            outcome,
            encoderFilter,
            incidents: visibleIncidents,
            selected:
                expandedIncident === null
                    ? null
                    : {
                          incident: expandedIncident,
                          sessions,
                          attempts: selectedSessionId !== null ? attempts : [],
                      },
            roots: data.roots,
        });
        try {
            await navigator.clipboard.writeText(report);
        } catch {
            toasts.error(m.admin_transcode_failures_toast_copy_failed());
            return;
        }
        toasts.success(m.admin_transcode_failures_toast_copied({ scope: copyScope }));
    }

    let clearing = $state(false);

    /**
     * Query string for a DELETE. `category` omitted = the clear-all scope; the
     * server keys off its presence, and `encoder` carries the same 'software'
     * label the table renders for a NULL encoder.
     */
    function clearParams(incident?: TranscodeIncident): string {
        const params = new SvelteURLSearchParams({ outcome });
        if (incident) {
            params.set('category', incident.category);
            params.set('encoder', incident.encoder ?? 'software');
        }
        // Keep failures timestamped after the newest displayed event; they
        // show up on the reload after the clear.
        const shown = incident ? [incident] : visibleIncidents;
        const newest = shown.reduce<string | null>(
            (max, i) => (max === null || i.lastSeen > max ? i.lastSeen : max),
            null,
        );
        if (newest) params.set('before', newest);
        return params.toString();
    }

    async function clearOne(params: string): Promise<number | null> {
        const { data: result, error } = await apiDelete(
            `/api/admin/transcode-failures?${params}`,
            TranscodeClearedResponseSchema,
        );
        if (error || !result) {
            toasts.error(
                m.admin_transcode_failures_toast_clear_incident_failed({
                    error: error ?? m.toast_unknown_error(),
                }),
            );
            return null;
        }
        return result.cleared;
    }

    function confirmClearIncident(incident: TranscodeIncident): void {
        const label = incidentLabel(incident);
        const params = clearParams(incident);
        modals.open(ConfirmModal, {
            title: m.admin_transcode_failures_confirm_clear_title(),
            body: m.admin_transcode_failures_confirm_clear_body({
                countLabel: m.admin_fmt_unit_events({ count: incident.occurrences }),
                label,
            }),
            confirmText: m.admin_transcode_failures_confirm_clear_confirm(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                const cleared = await clearOne(params);
                clearing = false;
                if (cleared === null) return;
                toasts.success(
                    m.admin_transcode_failures_toast_cleared({
                        countLabel: m.admin_fmt_unit_events({ count: cleared }),
                    }),
                );
                await loadIncidents();
            },
        });
    }

    function confirmClearAll(): void {
        // With an encoder filter, or when the list is truncated, a single bulk
        // DELETE would remove groups the operator cannot see. Clear exactly what
        // is on screen instead — one bounded request per visible group.
        const filtered = encoderFilter !== null;
        const perGroup = filtered || incidentsTruncated;
        // Bind the action to the scope described by this confirmation even
        // if navigation or an in-flight response changes the page meanwhile.
        const groupParams = visibleIncidents.map((incident) => clearParams(incident));
        const bulkParams = clearParams();
        const total = visibleIncidents.reduce((sum, i) => sum + i.occurrences, 0);
        const tabLabel =
            outcome === 'failed'
                ? m.admin_transcode_failures_tab_failed()
                : m.admin_transcode_failures_tab_recovered();
        const otherTabLabel =
            outcome === 'failed'
                ? m.admin_transcode_failures_tab_recovered()
                : m.admin_transcode_failures_tab_failed();
        modals.open(ConfirmModal, {
            title: filtered
                ? m.admin_transcode_failures_confirm_clear_all_title_filtered({
                      encoder: encoderFilter,
                  })
                : m.admin_transcode_failures_confirm_clear_all_title(),
            body: filtered
                ? m.admin_transcode_failures_confirm_clear_all_body_filtered({
                      countLabel: m.admin_fmt_unit_events({ count: total }),
                      encoder: encoderFilter ?? '',
                      tab: tabLabel,
                  })
                : m.admin_transcode_failures_confirm_clear_all_body({
                      countLabel: m.admin_fmt_unit_events({ count: total }),
                      tab: tabLabel,
                      otherTab: otherTabLabel,
                  }),
            confirmText: m.admin_transcode_failures_confirm_clear_all_confirm(),
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                let cleared = 0;
                if (perGroup) {
                    for (const params of groupParams) {
                        const n = await clearOne(params);
                        if (n === null) {
                            clearing = false;
                            await loadIncidents();
                            return;
                        }
                        cleared += n;
                    }
                } else {
                    const { data: result, error } = await apiDelete(
                        `/api/admin/transcode-failures?${bulkParams}`,
                        TranscodeClearedResponseSchema,
                    );
                    if (error || !result) {
                        clearing = false;
                        toasts.error(
                            m.admin_transcode_failures_toast_clear_all_failed({
                                error: error ?? m.toast_unknown_error(),
                            }),
                        );
                        return;
                    }
                    cleared = result.cleared;
                }
                clearing = false;
                toasts.success(
                    m.admin_transcode_failures_toast_cleared({
                        countLabel: m.admin_fmt_unit_events({ count: cleared }),
                    }),
                );
                await loadIncidents();
            },
        });
    }

    $effect(() => {
        void outcome;
        void loadIncidents();
    });
</script>

<svelte:head>
    <title>{m.admin_transcode_failures_page_title()}</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        title={m.admin_nav_page_system_transcode_failures()}
        description={m.admin_nav_desc_system_transcode_failures()}
        icon={adminPageIcons['/admin/system/transcode-failures']} />

    <div class="flex flex-wrap items-center gap-3">
        <Tabs
            items={[
                { id: 'failed', label: m.admin_transcode_failures_tab_failed() },
                { id: 'recovered', label: m.admin_transcode_failures_tab_recovered() },
            ]}
            active={outcome}
            onchange={(d) => (outcome = d.id as Outcome)}
            variant="pills"
            size="sm" />
        {#if encoderFilter !== null}
            <button
                type="button"
                class="flex max-w-full items-center gap-1.5 rounded-full bg-surface-800/60 px-3 py-1 text-xs text-surface-300 hover:bg-surface-800"
                onclick={clearEncoderFilter}>
                <span class="truncate"
                    >{m.admin_transcode_failures_encoder_filter_prefix()}
                    <span class="font-mono text-surface-100">{encoderFilter}</span></span>
                <Icon src={XMark} class="h-3.5 w-3.5 shrink-0" />
            </button>
        {/if}
        {#if visibleIncidents.length > 0}
            <button
                type="button"
                class="btn btn-sm variant-filled-primary ml-auto inline-flex items-center gap-1"
                disabled={copyDisabled}
                title={redactionUnavailable
                    ? m.admin_transcode_failures_copy_title_disabled()
                    : m.admin_transcode_failures_copy_title_enabled({ scope: copyScope })}
                onclick={() => void copyForGitHub()}>
                <Icon src={ClipboardDocument} class="h-4 w-4" />
                <span>{m.admin_transcode_failures_copy_button()}</span>
            </button>
        {/if}
    </div>

    {#if redactionUnavailable && visibleIncidents.length > 0}
        <p
            class="rounded border border-warning-500/40 bg-warning-500/10 p-3 text-xs text-warning-200">
            {m.admin_transcode_failures_redaction_unavailable_banner()}
        </p>
    {:else if visibleIncidents.length > 0}
        <p class="text-xs text-surface-400">
            {m.admin_transcode_failures_copy_explanation({ scope: copyScope })}
        </p>
    {/if}

    <AsyncSection
        loading={incidentsLoading}
        error={incidentsError}
        empty={visibleIncidents.length === 0}
        emptyMessage={encoderFilter !== null
            ? outcome === 'failed'
                ? m.admin_transcode_failures_empty_failed_filtered({ encoder: encoderFilter })
                : m.admin_transcode_failures_empty_recovered_filtered({ encoder: encoderFilter })
            : outcome === 'failed'
              ? m.admin_transcode_failures_empty_failed()
              : m.admin_transcode_failures_empty_recovered()}
        onretry={() => void loadIncidents()}>
        {#if incidentsTruncated}
            <p class="mb-2 text-xs text-amber-300" role="status">
                {m.admin_transcode_failures_truncated({
                    shown: incidents.length,
                    total: totalGroups,
                })}
            </p>
        {/if}
        <div class="overflow-x-auto rounded border border-surface-700/50">
            <table class="w-full min-w-[640px] text-sm">
                <thead class="bg-surface-800/60 text-left text-xs uppercase text-surface-400">
                    <tr>
                        <th class="px-3 py-2"></th>
                        <th class="px-3 py-2">{m.admin_transcode_failures_th_category()}</th>
                        <th class="px-3 py-2">{m.admin_transcode_failures_th_encoder()}</th>
                        <th class="px-3 py-2 text-right"
                            >{m.admin_transcode_failures_th_occurrences()}</th>
                        <th
                            class="px-3 py-2 text-right"
                            title={m.admin_transcode_failures_th_files_title()}
                            >{m.admin_transcode_failures_th_files()}</th>
                        <th
                            class="px-3 py-2 text-right"
                            title={m.admin_transcode_failures_th_sessions_title()}
                            >{m.admin_transcode_failures_th_sessions()}</th>
                        <th class="px-3 py-2">{m.admin_transcode_failures_th_first_seen()}</th>
                        <th class="px-3 py-2">{m.admin_transcode_failures_th_last_seen()}</th>
                        <th class="px-3 py-2"
                            ><span class="sr-only">{m.admin_transcode_failures_th_clear_sr()}</span
                            ></th>
                    </tr>
                </thead>
                <tbody>
                    {#each visibleIncidents as incident (rowKey(incident))}
                        {@const key = rowKey(incident)}
                        {@const isExpanded =
                            expandedIncident !== null && rowKey(expandedIncident) === key}
                        {@const categoryDisplay = formatFailureCategory(incident.category)}
                        {@const encoderDisplay = formatEncoderName(incident.encoder)}
                        <tr
                            class="cursor-pointer border-t border-surface-800 hover:bg-surface-800/40"
                            onclick={() => toggleRow(incident)}>
                            <td class="px-3 py-2 text-surface-500">
                                <Icon
                                    src={isExpanded ? ChevronDown : ChevronRight}
                                    class="h-4 w-4" />
                            </td>
                            <td
                                class="px-3 py-2 text-xs text-surface-200"
                                title={incident.category}>
                                <div>{categoryDisplay.label}</div>
                                {#if categoryDisplay.hint}
                                    <div class="mt-0.5 max-w-xs text-[11px] text-surface-500">
                                        {categoryDisplay.hint}
                                    </div>
                                {/if}
                            </td>
                            <td
                                class="px-3 py-2 text-surface-300"
                                title={incident.encoder ?? 'software'}>{encoderDisplay.label}</td>
                            <td class="px-3 py-2 text-right tabular-nums"
                                >{incident.occurrences}</td>
                            <td class="px-3 py-2 text-right tabular-nums"
                                >{incident.distinctFiles}</td>
                            <td class="px-3 py-2 text-right tabular-nums"
                                >{incident.distinctSessions}</td>
                            <td
                                class="px-3 py-2 text-xs text-surface-400"
                                title={absoluteTimestamp(incident.firstSeen)}
                                >{formatRelativeTime(incident.firstSeen)}</td>
                            <td
                                class="px-3 py-2 text-xs text-surface-400"
                                title={absoluteTimestamp(incident.lastSeen)}
                                >{formatRelativeTime(incident.lastSeen)}</td>
                            <td class="px-3 py-2 text-right">
                                <button
                                    type="button"
                                    class="rounded p-1 text-surface-500 hover:bg-surface-700/60 hover:text-error-400"
                                    title={m.admin_transcode_failures_clear_incident_title()}
                                    aria-label={m.admin_transcode_failures_clear_incident_aria({
                                        label: incidentLabel(incident),
                                    })}
                                    disabled={clearing}
                                    onclick={(event) => {
                                        // The row itself toggles the session
                                        // drill-down — without this the confirm
                                        // opens behind a newly expanded row.
                                        event.stopPropagation();
                                        confirmClearIncident(incident);
                                    }}>
                                    <Icon src={Trash} class="h-4 w-4" />
                                </button>
                            </td>
                        </tr>
                        {#if isExpanded}
                            <tr class="border-t border-surface-800 bg-surface-900/40">
                                <td colspan="9" class="px-3 py-3">
                                    <AsyncSection
                                        loading={sessionsLoading}
                                        error={sessionsError}
                                        empty={sessions.length === 0}
                                        emptyMessage={m.admin_transcode_failures_sessions_empty()}
                                        onretry={() => void loadIncidentSessions(incident)}>
                                        <ul class="space-y-1">
                                            {#each sessions as session (session.playSessionId)}
                                                <li>
                                                    <button
                                                        type="button"
                                                        class="flex w-full flex-wrap items-center gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-surface-800/60"
                                                        onclick={() =>
                                                            void openSession(
                                                                session.playSessionId,
                                                            )}>
                                                        <span
                                                            class="min-w-0 flex-1 truncate text-surface-200"
                                                            >{sessionLabel(session)}</span>
                                                        <span class="text-surface-400"
                                                            >{formatAttempts(
                                                                session.attemptCount,
                                                            )}</span>
                                                        {#if session.terminalOutcome}
                                                            <span class="badge-soft-cyan"
                                                                >{session.terminalOutcome}</span>
                                                        {:else}
                                                            <span class="italic text-surface-500"
                                                                >{m.admin_transcode_failures_session_no_terminal_outcome()}</span>
                                                        {/if}
                                                        <span
                                                            class="whitespace-nowrap text-surface-500"
                                                            title={absoluteTimestamp(
                                                                session.lastSeen,
                                                            )}
                                                            >{formatRelativeTime(
                                                                session.lastSeen,
                                                            )}</span>
                                                    </button>
                                                </li>
                                            {/each}
                                        </ul>
                                    </AsyncSection>
                                </td>
                            </tr>
                        {/if}
                    {/each}
                </tbody>
            </table>
        </div>
    </AsyncSection>

    {#if visibleIncidents.length > 0}
        <!-- Deliberately below the table and styled as a quiet, secondary
             action — not next to "Copy for GitHub" up top — so a destructive
             bulk delete is never the most prominent thing on the page.
             Confirmation still goes through ConfirmModal (same as clearing a
             single incident) before anything is deleted. -->
        <div class="flex justify-end">
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-surface-500 hover:text-error-400"
                disabled={clearing || incidentsLoading}
                onclick={confirmClearAll}>
                <Icon src={Trash} class="h-3.5 w-3.5" />
                <span
                    >{encoderFilter !== null
                        ? m.admin_transcode_failures_clear_filtered()
                        : m.admin_transcode_failures_clear_all()}</span>
            </button>
        </div>
    {/if}
</div>

{#if selectedSessionId}
    {@const sessionId = selectedSessionId}
    <DetailPanel
        titleText={m.admin_transcode_failures_detail_session_title({ id: sessionId })}
        tabs={detailTabs}
        activeTab="attempts"
        onTabChange={() => {}}
        mode="panel"
        onclose={() => (selectedSessionId = null)}>
        <AsyncSection
            loading={detailLoading}
            error={detailError}
            onretry={() => void openSession(sessionId)}>
            <TranscodeFailureDetail {attempts} roots={data.roots} />
        </AsyncSection>
    </DetailPanel>
{/if}
