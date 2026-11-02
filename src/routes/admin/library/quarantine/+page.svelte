<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Sync quarantine bulk triage. Groups unresolved sync_quarantine rows by
  series (reconciliation-backfill is the sole writer today) so an operator
  reviews bounded batches and can reach every warning. Compact operator table — not a
  showcase. Not yet linked from any nav; reached directly by URL.
-->
<script lang="ts">
    import { quarantineReason } from './reason-label.js';
    import { Icon, ArrowPath, CheckCircle, ExclamationTriangle } from 'svelte-hero-icons';
    import { AdminPageHeader, HelpPopover } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { toasts } from '$lib/stores/toast.store';
    import { modals } from '$lib/stores/modal.store';
    import { SvelteSet, SvelteMap } from 'svelte/reactivity';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        listQuarantineSeriesGroups,
        resolveQuarantineSeriesGroup,
        listReconciliationMoves,
        undoReconciliationMove,
        listReconciliationProposals,
        applyReconciliationProposal,
        dismissReconciliationProposal,
    } from '$lib/api/admin';
    import type {
        QuarantineSeriesGroup,
        QuarantineDispositionHistory,
        ReconciliationMove,
        ReconciliationProposal,
    } from '$lib/schemas/api-admin-library-responses.js';
    import * as m from '$lib/paraglide/messages.js';
    import { url } from '$lib/paths';
    import InspectionPanel from './InspectionPanel.svelte';
    import CurrentMatchPanel from './CurrentMatchPanel.svelte';
    import { page } from '$app/state';
    import {
        adminWorkspaceUrl,
        writeAdminWorkspaceUrl,
    } from '$lib/components/admin/admin-workspace-url';

    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let inspectionGroup = $derived(workspaceUrl.searchParams.get('inspect'));
    let inspectionRevision = $state(0);
    let currentMatchGroup = $state<QuarantineSeriesGroup | null>(null);
    let emptyPreview = $state<{
        group: QuarantineSeriesGroup;
        body: string;
        links: { href: string; label: string }[];
        continuation?: string;
    } | null>(null);
    function inspectGroup(g: QuarantineSeriesGroup): void {
        const destination = new URL(workspaceUrl);
        destination.searchParams.set('inspect', groupKey(g));
        destination.searchParams.delete('after');
        writeAdminWorkspaceUrl(destination, page.state, true);
    }

    let groups = $state<QuarantineSeriesGroup[]>([]);
    let history = $state<QuarantineDispositionHistory[]>([]);
    let historyNext = $state<string | undefined>();
    let restoringBatch = $state<string | null>(null);
    let restoreResult = $state<{ restored: number; changed: number } | null>(null);
    let loading = $state(false);
    let loaded = $state(false);
    let loadError = $state(false);
    /** Groups with a request in flight — one per group, so finishing one never re-enables another. */
    const actingKeys = new SvelteSet<string>();
    /** Only the newest list request may write the list. */
    let loadSeq = 0;
    const recheckCursors = new SvelteMap<string, string>();
    const acceptCursors = new SvelteMap<string, string>();
    const acceptResults = new SvelteMap<
        string,
        {
            label: string;
            examined: number;
            resolved: number;
            blocked: number;
            skipped: number;
            pageChanged: boolean;
        }
    >();
    const recheckResults = new SvelteMap<
        string,
        {
            label: string;
            examined: number;
            resolved: number;
            retained: number;
            retainedReview: { warningId: string; episodeId: string; reason: string }[];
        }
    >();

    let moves = $state<ReconciliationMove[]>([]);
    let movesLoaded = $state(false);
    let movesError = $state(false);
    /** Moves with an undo in flight. */
    const undoingIds = new SvelteSet<string>();
    let movesSeq = 0;

    let proposals = $state<ReconciliationProposal[]>([]);
    let proposalsLoaded = $state(false);
    let proposalsError = $state(false);
    /** Proposals with an apply or dismiss in flight. */
    const actingProposalIds = new SvelteSet<string>();
    let proposalsSeq = 0;

    /** Reasons the backfill writes carry a prefix the operator does not need to read. */
    function reasonLabel(reason: string): string {
        if (reason === 'absolute-numbering:proposed') {
            return m.admin_quarantine_reason_absolute_proposed();
        }
        return quarantineReason(reason);
    }

    function groupKey(g: QuarantineSeriesGroup): string {
        return g.seriesId ?? (g.parentTmdbId ? `tmdb:${g.parentTmdbId}` : 'unknown');
    }

    function canAccept(g: QuarantineSeriesGroup): boolean {
        return !!g.seriesId && Object.keys(g.reasonCounts).some((r) => r.endsWith(':matched'));
    }

    function formatDate(d: string): string {
        return new Date(d).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }

    async function loadGroups(historyAfter?: string): Promise<void> {
        const seq = ++loadSeq;
        loading = true;
        try {
            const { data, error } = await (historyAfter
                ? listQuarantineSeriesGroups(historyAfter)
                : listQuarantineSeriesGroups());
            if (seq !== loadSeq) return;
            if (error || !data) {
                loadError = true;
                toasts.error(getErrorMessage(error, m.admin_quarantine_load_error()));
                return;
            }
            groups = data.groups;
            history = data.history?.items ?? [];
            historyNext = data.history?.continuation;
            loadError = false;
        } catch (e) {
            if (seq !== loadSeq) return;
            loadError = true;
            toasts.error(getErrorMessage(e, m.admin_quarantine_load_error()));
        } finally {
            if (seq === loadSeq) {
                loading = false;
                loaded = true;
            }
        }
    }

    async function loadMoves(): Promise<void> {
        const seq = ++movesSeq;
        try {
            const { data, error } = await listReconciliationMoves({ limit: 50 });
            if (seq !== movesSeq) return;
            if (error || !data) {
                movesError = true;
                toasts.error(getErrorMessage(error, m.admin_quarantine_moves_load_error()));
                return;
            }
            moves = data.moves;
            movesError = false;
        } catch (e) {
            if (seq !== movesSeq) return;
            movesError = true;
            toasts.error(getErrorMessage(e, m.admin_quarantine_moves_load_error()));
        } finally {
            if (seq === movesSeq) movesLoaded = true;
        }
    }

    async function loadProposals(): Promise<void> {
        const seq = ++proposalsSeq;
        try {
            const { data, error } = await listReconciliationProposals({ limit: 200 });
            if (seq !== proposalsSeq) return;
            if (error || !data) {
                proposalsError = true;
                toasts.error(getErrorMessage(error, m.admin_quarantine_proposals_load_error()));
                return;
            }
            proposals = data.proposals;
            proposalsError = false;
        } catch (e) {
            if (seq !== proposalsSeq) return;
            proposalsError = true;
            toasts.error(getErrorMessage(e, m.admin_quarantine_proposals_load_error()));
        } finally {
            if (seq === proposalsSeq) proposalsLoaded = true;
        }
    }

    function requestApplyProposal(p: ReconciliationProposal): void {
        modals.open(ConfirmModal, {
            title: m.admin_quarantine_proposals_apply_confirm_title(),
            body: m.admin_quarantine_proposals_apply_confirm_body({
                fromSeason: p.fromSeason,
                fromEpisode: p.fromEpisode,
                toSeason: p.toSeason,
                toEpisode: p.toEpisode,
                title: p.proposedTitle ?? '',
            }),
            confirmText: m.admin_quarantine_proposals_apply(),
            onConfirm: () => executeApplyProposal(p),
        });
    }

    async function executeApplyProposal(p: ReconciliationProposal): Promise<void> {
        if (actingProposalIds.has(p.id)) return;
        actingProposalIds.add(p.id);
        try {
            const { data, error } = await applyReconciliationProposal(p.id);
            if (error || !data) {
                // A stale proposal stays open; reload so the list shows what is true now.
                toasts.error(getErrorMessage(error, m.admin_quarantine_proposals_apply_failed()));
                await loadProposals();
                return;
            }
            toasts.success(m.admin_quarantine_proposals_apply_success());
            await Promise.all([loadProposals(), loadMoves(), loadGroups()]);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_proposals_apply_failed()));
        } finally {
            actingProposalIds.delete(p.id);
        }
    }

    function requestDismissProposal(p: ReconciliationProposal): void {
        modals.open(ConfirmModal, {
            title: m.admin_quarantine_proposals_dismiss_confirm_title(),
            body: m.admin_quarantine_proposals_dismiss_confirm_body(),
            confirmText: m.admin_quarantine_proposals_dismiss(),
            confirmVariant: 'danger' as const,
            onConfirm: () => executeDismissProposal(p),
        });
    }

    async function executeDismissProposal(p: ReconciliationProposal): Promise<void> {
        if (actingProposalIds.has(p.id)) return;
        actingProposalIds.add(p.id);
        try {
            const { data, error } = await dismissReconciliationProposal(p.id);
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_proposals_dismiss_failed()));
                await loadProposals();
                return;
            }
            toasts.success(m.admin_quarantine_proposals_dismiss_success());
            await Promise.all([loadProposals(), loadGroups()]);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_proposals_dismiss_failed()));
        } finally {
            actingProposalIds.delete(p.id);
        }
    }

    async function executeUndo(move: ReconciliationMove): Promise<void> {
        if (undoingIds.has(move.id)) return;
        undoingIds.add(move.id);
        try {
            const { data, error } = await undoReconciliationMove(move.id);
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_moves_undo_failed()));
                // A 409 means the row changed under us (already undone); show its state.
                await loadMoves();
                return;
            }
            toasts.success(m.admin_quarantine_moves_undo_success());
            // An undo puts episodes back in quarantine or back up as a proposal.
            await Promise.all([loadMoves(), loadProposals(), loadGroups()]);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_moves_undo_failed()));
        } finally {
            undoingIds.delete(move.id);
        }
    }

    async function executeDismiss(g: QuarantineSeriesGroup): Promise<void> {
        const key = groupKey(g);
        if (actingKeys.has(key)) return;
        actingKeys.add(key);
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                groupKey: groupKey(g),
                groupFingerprint: g.fingerprint,
                action: 'dismiss',
            });
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_dismiss_failed()));
                await loadGroups();
                return;
            }
            acceptCursors.delete(key);
            recheckCursors.delete(key);
            recheckResults.delete(key);
            acceptResults.delete(key);
            toasts.success(m.admin_quarantine_dismiss_success({ count: data.resolved }));
            // A group can hold proposed moves too; keep the proposals table in step.
            await Promise.all([loadGroups(), loadProposals()]);
            inspectionRevision++;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_dismiss_failed()));
        } finally {
            actingKeys.delete(key);
        }
    }

    async function showAgain(batchId: string): Promise<void> {
        if (restoringBatch) return;
        restoringBatch = batchId;
        restoreResult = { restored: 0, changed: 0 };
        let after: string | undefined;
        try {
            do {
                const { data, error } = await resolveQuarantineSeriesGroup({
                    action: 'restore',
                    batchId,
                    after,
                });
                if (error || !data) {
                    toasts.error(getErrorMessage(error, m.admin_quarantine_history_failed()));
                    break;
                }
                restoreResult = {
                    restored: restoreResult.restored + (data.restored ?? 0),
                    changed: restoreResult.changed + (data.changed ?? 0),
                };
                after = data.continuation;
            } while (after);
        } catch (error) {
            toasts.error(getErrorMessage(error, m.admin_quarantine_history_failed()));
        } finally {
            await loadGroups();
            inspectionRevision++;
            restoringBatch = null;
        }
    }

    function historyKind(kind: QuarantineDispositionHistory['kind']): string {
        switch (kind) {
            case 'hidden':
                return m.admin_quarantine_history_hidden();
            case 'no-proposal':
                return m.admin_quarantine_history_no_proposal();
            case 'completed':
                return m.admin_quarantine_history_completed();
            case 'superseded':
                return m.admin_quarantine_history_superseded();
            case 'gone':
                return m.admin_quarantine_history_gone();
        }
    }

    function retainedReason(reason: string): string {
        switch (reason) {
            case 'oversized-component':
                return m.admin_quarantine_retained_oversized_component();
            case 'batch-capacity':
                return m.admin_quarantine_retained_batch_capacity();
            case 'unreviewable-dependency':
                return m.admin_quarantine_retained_unreviewable_dependency();
            case 'protected-or-inactive':
                return m.admin_quarantine_retained_protected_or_inactive();
            case 'manually-locked':
                return m.admin_quarantine_block_manually_locked();
            case 'identity-bound':
                return m.admin_quarantine_block_identity_bound();
            case 'inactive-episode':
                return m.admin_quarantine_block_inactive_episode();
            case 'inactive-season':
                return m.admin_quarantine_block_inactive_season();
            case 'inactive-series':
                return m.admin_quarantine_block_inactive_series();
            case 'locked-season':
                return m.admin_quarantine_block_locked_season();
            case 'locked-series':
                return m.admin_quarantine_block_locked_series();
            case 'inconsistent-season':
                return m.admin_quarantine_block_inconsistent_season();
            case 'changed-proposal':
                return m.admin_quarantine_retained_changed_proposal();
            default:
                return m.admin_quarantine_retained_ineligible();
        }
    }

    function recheckRetainedReason(reason: string): string {
        if (reason === 'historical-target-unconfirmed')
            return m.admin_quarantine_current_reason_no_target();
        if (reason === 'position-bound-current-match')
            return m.admin_quarantine_recheck_position_bound();
        if (reason === 'changed-during-recheck' || reason === 'changed-warning-or-evidence')
            return m.admin_quarantine_current_stale();
        return m.admin_quarantine_recheck_other_retained();
    }

    /** Accept replaces typed provider identities and titles with no undo — confirm like Dismiss does. */
    async function requestAccept(g: QuarantineSeriesGroup): Promise<void> {
        if (!g.seriesId) return;
        const key = groupKey(g);
        if (actingKeys.has(key)) return;
        actingKeys.add(key);
        const previewAfter = acceptCursors.get(key);
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                seriesId: g.seriesId,
                action: 'preview-accept',
                after: previewAfter,
            });
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_accept_failed()));
                return;
            }
            const review = data.review ?? [];
            const retained = (data.blockedReview ?? [])
                .map((row) => `${row.title} · TMDB ${row.target} · ${retainedReason(row.reason)}`)
                .join('\n');
            const details = review
                .map(
                    (row) =>
                        m.admin_quarantine_accept_decision({
                            season: row.seasonNumber,
                            episode: row.episodeNumber,
                            currentTitle: row.currentTitle ?? '—',
                            currentId: row.currentTmdbEpisodeId ?? '—',
                            title: row.title,
                            targetId: row.tmdbEpisodeId,
                            overview: row.overview ?? '—',
                            still: row.stillPath ?? '—',
                        }) + `\n${m.media_plain_technical_details()}: ${row.episodeId}`,
                )
                .join('\n');
            const reviewLinks = [...new Set(data.inspectableEpisodeIds ?? [])].map((id) => ({
                href: url(`/admin/library/media/${id}`),
                label: m.media_plain_open_episode({
                    title:
                        review.find((row) => row.episodeId === id)?.currentTitle ??
                        data.blockedReview?.find((row) => row.episodeId === id)?.title ??
                        m.media_plain_episode(),
                }),
            }));
            if (review.length === 0) {
                emptyPreview = {
                    group: g,
                    body: `${m.admin_quarantine_preview_readonly_body()}\n${m.admin_quarantine_accept_blocked({ count: data.blocked ?? 0 })}\n${retained}`,
                    links: reviewLinks,
                    continuation: data.continuation,
                };
                return;
            }
            emptyPreview = null;
            modals.open(ConfirmModal, {
                title: m.admin_quarantine_accept_confirm_title(),
                reviewLinks,
                scrollBody: true,
                body: `${m.admin_quarantine_accept_confirm_body()}\n\n${details}\n\n${m.admin_quarantine_accept_blocked({ count: data.blocked ?? 0 })}\n${retained}`,
                confirmText: m.admin_quarantine_accept_all(),
                onConfirm: () =>
                    executeAccept(
                        g,
                        review.map(({ id, fingerprint }) => ({ id, fingerprint })),
                        data.reviewedPage,
                        previewAfter,
                    ),
            });
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_accept_failed()));
        } finally {
            actingKeys.delete(key);
        }
    }

    async function executeAccept(
        g: QuarantineSeriesGroup,
        reviewed: { id: string; fingerprint: string }[],
        reviewedPage: { ids: string[]; fingerprint: string; continuation?: string } | undefined,
        previewAfter: string | undefined,
    ): Promise<void> {
        if (!g.seriesId) return;
        const key = groupKey(g);
        if (actingKeys.has(key)) return;
        actingKeys.add(key);
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                seriesId: g.seriesId,
                action: 'accept',
                reviewed,
                reviewedPage,
                after: previewAfter,
            });
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_accept_failed()));
                return;
            }
            acceptResults.set(key, {
                label: g.seriesTitle ?? m.admin_quarantine_unknown_series(),
                examined: data.examined ?? 0,
                resolved: data.resolved,
                blocked: data.blocked ?? 0,
                skipped: data.skipped ?? 0,
                pageChanged: data.pageChanged ?? false,
            });
            if (!data.pageChanged) {
                if (data.continuation) acceptCursors.set(key, data.continuation);
                else acceptCursors.delete(key);
            }
            if (data.resolved === 0) {
                toasts.warning(m.admin_quarantine_accept_none());
            } else {
                toasts.success(
                    m.admin_quarantine_accept_success({
                        count: data.resolved,
                        skipped: data.skipped ?? 0,
                    }),
                );
            }
            await Promise.all([loadGroups(), loadProposals(), loadMoves()]);
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_accept_failed()));
        } finally {
            actingKeys.delete(key);
        }
    }

    async function executeRecheck(g: QuarantineSeriesGroup): Promise<void> {
        if (!g.seriesId) return;
        const key = groupKey(g);
        if (actingKeys.has(key)) return;
        actingKeys.add(key);
        try {
            const { data, error } = await resolveQuarantineSeriesGroup({
                seriesId: g.seriesId,
                action: 'recheck',
                after: recheckCursors.get(key),
            });
            if (error || !data) {
                toasts.error(getErrorMessage(error, m.admin_quarantine_recheck_failed()));
                return;
            }
            recheckResults.set(key, {
                label: g.seriesTitle ?? m.admin_quarantine_unknown_series(),
                examined: data.examined ?? 0,
                resolved: data.resolved,
                retained: data.retained ?? 0,
                retainedReview: data.retainedReview ?? [],
            });
            if (data.continuation) recheckCursors.set(key, data.continuation);
            else recheckCursors.delete(key);
            await loadGroups();
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_quarantine_recheck_failed()));
        } finally {
            actingKeys.delete(key);
        }
    }

    let totalRows = $derived(groups.reduce((sum, g) => sum + g.totalUnresolved, 0));

    $effect(() => {
        if (!loaded) void loadGroups();
    });

    $effect(() => {
        if (!movesLoaded) void loadMoves();
    });

    $effect(() => {
        if (!proposalsLoaded) void loadProposals();
    });
</script>

<svelte:head>
    <title>{m.route_admin_quarantine_title()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/quarantine']}
        title={m.route_admin_quarantine_title()}
        description={m.route_admin_quarantine_description()} />

    <p class="text-sm text-surface-400">{m.admin_quarantine_automatic_cleanup()}</p>
    <HelpPopover variant="inline">
        <p>{m.admin_quarantine_help_what()}</p>
        <p>{m.media_plain_quarantine_actions_help()}</p>
        <p>{m.admin_quarantine_help_why()}</p>
        <ul class="list-none space-y-1.5 pl-0">
            <li>
                <code class="rounded bg-surface-700 px-1 py-0.5 font-mono text-xs text-surface-300"
                    >matched</code>
                — {m.admin_quarantine_help_reason_matched()}
            </li>
            <li>
                <code class="rounded bg-surface-700 px-1 py-0.5 font-mono text-xs text-surface-300"
                    >below-threshold</code>
                — {m.admin_quarantine_help_reason_below()}
            </li>
            <li>
                <code class="rounded bg-surface-700 px-1 py-0.5 font-mono text-xs text-surface-300"
                    >duplicate-match</code>
                — {m.admin_quarantine_help_reason_duplicate()}
            </li>
            <li>
                <code class="rounded bg-surface-700 px-1 py-0.5 font-mono text-xs text-surface-300"
                    >absolute-numbering:proposed</code>
                — {m.admin_quarantine_help_reason_proposed()}
            </li>
        </ul>
        <p>{m.admin_quarantine_help_rows()}</p>
        <p>{m.admin_quarantine_recheck_help()}</p>
        <p>
            <strong class="text-surface-300">{m.admin_quarantine_accept_all()}</strong> — {m.admin_quarantine_help_accept()}
        </p>
        <p>
            <strong class="text-surface-300">{m.admin_quarantine_dismiss_all()}</strong> — {m.admin_quarantine_help_dismiss()}
        </p>
    </HelpPopover>

    <details
        class="rounded-xl border border-surface-700 p-4 space-y-3"
        aria-label={m.admin_quarantine_history_title()}>
        <summary class="cursor-pointer font-semibold">{m.admin_quarantine_history_title()}</summary>
        <p class="text-sm text-surface-400">{m.admin_quarantine_history_help()}</p>
        {#if restoreResult}<p role="status">
                {m.admin_quarantine_history_result(restoreResult)}
            </p>{/if}
        {#each history as item (item.batchId)}
            <article
                class="flex flex-wrap items-center justify-between gap-3 border-t border-surface-700 pt-3">
                <div>
                    <p>{item.seriesTitle ?? m.media_plain_series()} · {historyKind(item.kind)}</p>
                    <p class="text-sm text-surface-400">
                        {m.admin_quarantine_history_count({
                            count: item.count,
                            available: item.restorable,
                        })} · {formatDate(item.createdAt)} · {item.actor}
                    </p>
                </div>
                {#if item.restorable > 0}<button
                        type="button"
                        class="btn btn-ghost"
                        disabled={!!restoringBatch}
                        onclick={() => showAgain(item.batchId)}
                        >{m.admin_quarantine_show_again()}</button
                    >{/if}
            </article>
        {:else}<p class="text-sm">{m.admin_quarantine_history_empty()}</p>{/each}
        {#if historyNext}<button
                type="button"
                class="btn btn-ghost"
                disabled={loading || !!restoringBatch}
                onclick={() => loadGroups(historyNext)}>{m.admin_quarantine_history_next()}</button
            >{/if}
    </details>

    {#if inspectionGroup}
        {#key `${inspectionGroup}:${inspectionRevision}`}
            <InspectionPanel
                group={inspectionGroup}
                onchanged={() => {
                    void loadGroups();
                }}
                onclose={() => {
                    const destination = new URL(workspaceUrl);
                    destination.searchParams.delete('inspect');
                    destination.searchParams.delete('after');
                    writeAdminWorkspaceUrl(destination, page.state, true);
                }} />
        {/key}
    {/if}
    {#if currentMatchGroup}
        {#key currentMatchGroup.seriesId}
            <CurrentMatchPanel
                group={currentMatchGroup}
                onchanged={() => {
                    void loadGroups();
                }}
                onclose={() => {
                    currentMatchGroup = null;
                }} />
        {/key}
    {/if}
    {#if emptyPreview}
        {@const preview = emptyPreview}
        <section
            class="rounded-xl border border-surface-700 p-4 space-y-3"
            aria-label={m.admin_quarantine_accept_confirm_title()}>
            <h2 class="font-semibold">{m.admin_quarantine_preview_readonly()}</h2>
            {#key preview}
                <!-- The bounded review region needs keyboard focus for native scrolling. -->
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                    role="region"
                    aria-label={m.admin_quarantine_preview_readonly()}
                    tabindex="0"
                    class="max-h-80 overflow-y-auto overscroll-contain space-y-2">
                    <p class="whitespace-pre-line text-sm">{preview.body}</p>
                    {#each preview.links as link (link.href)}
                        <a
                            class="anchor block"
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer">{link.label}</a>
                    {/each}
                </div>
            {/key}
            <button class="btn btn-ghost" onclick={() => inspectGroup(preview.group)}
                >{m.admin_quarantine_inspect()}</button>
            {#if preview.continuation}
                <button
                    class="btn btn-ghost"
                    disabled={actingKeys.has(groupKey(preview.group))}
                    onclick={() => {
                        acceptCursors.set(groupKey(preview.group), preview.continuation!);
                        void requestAccept(preview.group);
                    }}>{m.admin_quarantine_preview_next()}</button>
            {/if}
            <button
                class="btn btn-ghost"
                onclick={() => {
                    emptyPreview = null;
                }}>{m.close()}</button>
        </section>
    {/if}

    <div class="flex items-center justify-between">
        {#if groups.length > 0}
            <span class="text-sm text-surface-400">
                {m.admin_quarantine_summary({ seriesCount: groups.length, rowCount: totalRows })}
            </span>
        {:else}
            <span></span>
        {/if}
        <button
            class="btn btn-ghost"
            onclick={() => {
                emptyPreview = null;
                recheckCursors.clear();
                acceptCursors.clear();
                recheckResults.clear();
                acceptResults.clear();
                void loadGroups();
                void loadMoves();
                void loadProposals();
            }}
            disabled={loading || actingKeys.size > 0}>
            <Icon src={ArrowPath} class="w-4 h-4 {loading ? 'animate-spin' : ''}" />
            {m.admin_quarantine_restart()}
        </button>
    </div>

    {#each [...acceptResults] as [key, result] (key)}
        <p role="status" class="text-sm text-surface-400">
            {result.label}: {result.pageChanged
                ? m.admin_quarantine_accept_page_changed()
                : m.admin_quarantine_accept_result(result)}
        </p>
    {/each}
    {#each [...recheckResults] as [key, result] (key)}
        <div role="status" class="text-sm text-surface-400">
            <p>{result.label}: {m.admin_quarantine_recheck_result(result)}</p>
            {#if result.retainedReview.length > 0}
                <details>
                    <summary class="cursor-pointer">{m.admin_quarantine_recheck_reasons()}</summary>
                    <div class="max-h-48 overflow-y-auto">
                        {#each result.retainedReview as row (row.warningId)}
                            <p>{row.episodeId}: {recheckRetainedReason(row.reason)}</p>
                        {/each}
                    </div>
                </details>
            {/if}
        </div>
    {/each}
    {#if loadError && groups.length > 0}
        <p role="alert" class="text-sm text-orange-400">
            {m.admin_quarantine_recheck_refresh_failed()}
        </p>
    {/if}
    {#if loading && !loaded}
        <p class="text-sm text-surface-500 py-8 text-center">{m.admin_quarantine_loading()}</p>
    {:else if loadError && groups.length === 0}
        <div class="flex flex-col items-center gap-3 py-16 text-center">
            <Icon src={ExclamationTriangle} class="w-10 h-10 text-orange-400" />
            <p class="text-surface-300 font-medium">{m.admin_quarantine_load_error()}</p>
            <button type="button" class="btn btn-ghost btn-sm" onclick={() => void loadGroups()}>
                {m.common_retry()}
            </button>
        </div>
    {:else if groups.length === 0}
        <div class="flex flex-col items-center gap-3 py-16 text-center">
            <Icon src={CheckCircle} class="w-12 h-12 text-green-400" />
            <p class="text-surface-300 font-medium">{m.admin_quarantine_empty_title()}</p>
            <p class="text-surface-500 text-sm">{m.admin_quarantine_empty_body()}</p>
        </div>
    {:else}
        <div class="overflow-x-auto rounded-xl border border-surface-700">
            <table class="w-full text-sm">
                <thead class="bg-surface-800/60">
                    <tr>
                        <th class="px-4 py-3 text-left text-surface-400 font-medium"
                            >{m.admin_quarantine_col_series()}</th>
                        <th class="px-4 py-3 text-left text-surface-400 font-medium"
                            >{m.admin_quarantine_col_reasons()}</th>
                        <th class="px-4 py-3 text-right text-surface-400 font-medium"
                            >{m.admin_quarantine_col_count()}</th>
                        <th class="px-4 py-3 text-left text-surface-400 font-medium"
                            >{m.admin_quarantine_col_oldest()}</th>
                        <th class="px-4 py-3 text-left text-surface-400 font-medium"
                            >{m.admin_quarantine_col_newest()}</th>
                        <th class="px-4 py-3 text-right text-surface-400 font-medium"
                            >{m.admin_quarantine_col_actions()}</th>
                    </tr>
                </thead>
                <tbody>
                    {#each groups as g (groupKey(g))}
                        {@const busy = actingKeys.has(groupKey(g))}
                        <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                            <td class="px-4 py-2.5 max-w-[260px]">
                                {#if g.seriesTitle}
                                    <span
                                        class="text-surface-200 truncate block"
                                        title={g.seriesTitle}>{g.seriesTitle}</span>
                                {:else if g.parentTmdbId}
                                    <span class="font-mono text-xs text-surface-400"
                                        >{m.admin_quarantine_tmdb_series({
                                            id: g.parentTmdbId,
                                        })}</span>
                                {:else}
                                    <span class="text-surface-500"
                                        >{m.admin_quarantine_unknown_series()}</span>
                                {/if}
                            </td>
                            <td class="px-4 py-2.5">
                                <div class="flex flex-wrap gap-1">
                                    {#each Object.entries(g.reasonCounts) as [reason, count] (reason)}
                                        <span
                                            class="px-1.5 py-0.5 rounded bg-surface-700 text-surface-300 text-xs font-mono"
                                            title={reasonLabel(reason)}
                                            >{reasonLabel(reason)}: {count}</span>
                                    {/each}
                                </div>
                            </td>
                            <td class="px-4 py-2.5 text-right text-surface-200 font-medium"
                                >{g.totalUnresolved}</td>
                            <td class="px-4 py-2.5 text-surface-500 text-xs whitespace-nowrap"
                                >{formatDate(g.oldestCreatedAt)}</td>
                            <td class="px-4 py-2.5 text-surface-500 text-xs whitespace-nowrap"
                                >{formatDate(g.newestCreatedAt)}</td>
                            <td class="px-4 py-2.5 text-right">
                                <div class="flex justify-end gap-2">
                                    <button
                                        type="button"
                                        class="btn btn-ghost text-xs"
                                        onclick={() => inspectGroup(g)}
                                        >{m.admin_quarantine_inspect()}</button>
                                    {#if g.seriesId}
                                        <button
                                            type="button"
                                            class="btn btn-ghost text-xs"
                                            disabled={busy}
                                            onclick={() => {
                                                currentMatchGroup = g;
                                            }}>
                                            {m.admin_quarantine_current_action()}
                                        </button>
                                        <button
                                            type="button"
                                            class="btn btn-ghost text-xs"
                                            disabled={busy}
                                            onclick={() => executeRecheck(g)}>
                                            {recheckCursors.has(groupKey(g))
                                                ? m.admin_quarantine_recheck_continue()
                                                : m.admin_quarantine_recheck()}
                                        </button>
                                    {/if}
                                    {#if canAccept(g) || acceptCursors.has(groupKey(g))}
                                        <button
                                            type="button"
                                            class="px-2.5 py-1 text-xs rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 transition-colors disabled:opacity-50"
                                            disabled={busy}
                                            onclick={() => requestAccept(g)}>
                                            {acceptCursors.has(groupKey(g))
                                                ? m.admin_quarantine_accept_continue()
                                                : m.admin_quarantine_accept_all()}
                                        </button>
                                    {/if}
                                    <button
                                        type="button"
                                        class="px-2.5 py-1 text-xs rounded-lg bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 transition-colors disabled:opacity-50"
                                        disabled={busy || (!g.seriesId && !g.parentTmdbId)}
                                        onclick={() => executeDismiss(g)}>
                                        {m.admin_quarantine_dismiss_all()}
                                    </button>
                                </div>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
    <section class="space-y-3">
        <h2 class="text-lg font-semibold text-surface-200">
            {m.admin_quarantine_proposals_title()}
        </h2>
        <p class="text-sm text-surface-400">{m.admin_quarantine_proposals_help()}</p>
        {#if proposalsError && proposals.length === 0}
            <p class="text-sm text-orange-400">{m.admin_quarantine_proposals_load_error()}</p>
        {:else if proposalsLoaded && proposals.length === 0}
            <p class="text-sm text-surface-500">{m.admin_quarantine_proposals_empty()}</p>
        {:else if proposals.length > 0}
            <div class="overflow-x-auto rounded-xl border border-surface-700">
                <table class="w-full text-sm">
                    <thead class="bg-surface-800/60">
                        <tr>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_col_series()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_moves_col_move()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_proposals_col_tmdb_title()}</th>
                            <th class="px-4 py-3 text-right text-surface-400 font-medium"
                                >{m.admin_quarantine_col_actions()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each proposals as p (p.id)}
                            {@const busy = actingProposalIds.has(p.id)}
                            <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                <td class="px-4 py-2.5 max-w-[220px]">
                                    <span
                                        class="text-surface-200 truncate block"
                                        title={p.seriesTitle ?? m.admin_quarantine_unknown_series()}
                                        >{p.seriesTitle ??
                                            m.admin_quarantine_unknown_series()}</span>
                                </td>
                                <td class="px-4 py-2.5 whitespace-nowrap">
                                    <span class="font-mono text-xs text-surface-300"
                                        >{m.admin_quarantine_moves_move({
                                            fromSeason: p.fromSeason,
                                            fromEpisode: p.fromEpisode,
                                            toSeason: p.toSeason,
                                            toEpisode: p.toEpisode,
                                        })}</span>
                                    <span class="ml-2 text-xs text-surface-500"
                                        >{p.evidence === 'filename-absolute-untitled'
                                            ? m.admin_quarantine_proposals_evidence_untitled()
                                            : p.evidence === 'filename-absolute' ||
                                                p.evidence === 'filename-absolute-corroborated'
                                              ? m.admin_quarantine_proposals_evidence_filename()
                                              : m.admin_quarantine_proposals_evidence_number()}</span>
                                </td>
                                <td class="px-4 py-2.5 max-w-[320px]">
                                    <span
                                        class="text-surface-300 truncate block"
                                        title={p.proposedTitle ?? ''}>{p.proposedTitle ?? ''}</span>
                                    {#if p.currentTitle}
                                        <span
                                            class="text-xs text-surface-500 truncate block"
                                            title={p.currentTitle}>{p.currentTitle}</span>
                                    {/if}
                                </td>
                                <td class="px-4 py-2.5 text-right">
                                    <div class="flex justify-end gap-2">
                                        <button
                                            type="button"
                                            class="px-2.5 py-1 text-xs rounded-lg bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 transition-colors disabled:opacity-50"
                                            disabled={busy}
                                            onclick={() => requestApplyProposal(p)}>
                                            {m.admin_quarantine_proposals_apply()}
                                        </button>
                                        <button
                                            type="button"
                                            class="px-2.5 py-1 text-xs rounded-lg bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 transition-colors disabled:opacity-50"
                                            disabled={busy}
                                            onclick={() => requestDismissProposal(p)}>
                                            {m.admin_quarantine_proposals_dismiss()}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>
    <section class="space-y-3">
        <h2 class="text-lg font-semibold text-surface-200">{m.admin_quarantine_moves_title()}</h2>
        <p class="text-sm text-surface-400">{m.admin_quarantine_moves_recovery_limits()}</p>
        <p class="text-sm text-surface-400">{m.admin_quarantine_moves_help()}</p>
        {#if movesError && moves.length === 0}
            <p class="text-sm text-orange-400">{m.admin_quarantine_moves_load_error()}</p>
        {:else if movesLoaded && moves.length === 0}
            <p class="text-sm text-surface-500">{m.admin_quarantine_moves_empty()}</p>
        {:else if moves.length > 0}
            <div class="overflow-x-auto rounded-xl border border-surface-700">
                <table class="w-full text-sm">
                    <thead class="bg-surface-800/60">
                        <tr>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_col_series()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_moves_col_episode()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_moves_col_move()}</th>
                            <th class="px-4 py-3 text-left text-surface-400 font-medium"
                                >{m.admin_quarantine_moves_col_applied()}</th>
                            <th class="px-4 py-3 text-right text-surface-400 font-medium"
                                >{m.admin_quarantine_col_actions()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each moves as move (move.id)}
                            <tr class="border-t border-surface-700/50 hover:bg-surface-800/30">
                                <td class="px-4 py-2.5 max-w-[220px]">
                                    <span
                                        class="text-surface-200 truncate block"
                                        title={move.seriesTitle ??
                                            m.admin_quarantine_unknown_series()}
                                        >{move.seriesTitle ??
                                            m.admin_quarantine_unknown_series()}</span>
                                </td>
                                <td class="px-4 py-2.5 max-w-[260px]">
                                    <span
                                        class="text-surface-300 truncate block"
                                        title={move.episodeTitle ?? move.episodeId ?? ''}
                                        >{move.episodeTitle ?? move.episodeId ?? ''}</span>
                                </td>
                                <td class="px-4 py-2.5 whitespace-nowrap">
                                    <span class="font-mono text-xs text-surface-300">
                                        {#if move.fromSeason === move.toSeason && move.fromEpisode === move.toEpisode}
                                            {m.admin_quarantine_moves_in_place({
                                                season: move.toSeason,
                                                episode: move.toEpisode,
                                            })}
                                        {:else}
                                            {m.admin_quarantine_moves_move({
                                                fromSeason: move.fromSeason,
                                                fromEpisode: move.fromEpisode,
                                                toSeason: move.toSeason,
                                                toEpisode: move.toEpisode,
                                            })}
                                        {/if}
                                    </span>
                                    <span class="ml-2 text-xs text-surface-500"
                                        >{move.service === 'absolute-numbering'
                                            ? m.admin_quarantine_moves_service_absolute()
                                            : m.admin_quarantine_moves_service_season()}</span>
                                </td>
                                <td class="px-4 py-2.5 text-surface-500 text-xs whitespace-nowrap"
                                    >{formatDate(move.appliedAt)}</td>
                                <td class="px-4 py-2.5 text-right">
                                    {#if move.undoneAt}
                                        <span class="text-xs text-surface-500"
                                            >{m.admin_quarantine_moves_undone({
                                                user: move.undoneBy ?? '',
                                            })}</span>
                                    {:else}
                                        <button
                                            type="button"
                                            class="px-2.5 py-1 text-xs rounded-lg bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/20 transition-colors disabled:opacity-50"
                                            disabled={undoingIds.has(move.id) || !move.episodeId}
                                            onclick={() => executeUndo(move)}>
                                            {m.admin_quarantine_moves_undo()}
                                        </button>
                                    {/if}
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>
</div>
