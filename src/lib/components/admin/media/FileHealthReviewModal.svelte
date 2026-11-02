<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import * as adminApi from '$lib/api/admin';
    import type {
        FileHealthReviewHistory,
        FileHealthReviewPreview,
        FileHealthReviewRequest,
    } from '$lib/schemas/file-health-review.js';
    import AudioTailDiagnosis from './AudioTailDiagnosis.svelte';
    import * as m from '$lib/paraglide/messages.js';

    let {
        fileId,
        onclose,
        onchanged,
    }: {
        fileId: string;
        onclose: () => void;
        onchanged?: () => void | Promise<void>;
    } = $props();

    let preview = $state<FileHealthReviewPreview | null>(null);
    let loading = $state(true);
    let saving = $state(false);
    let error = $state<string | null>(null);
    let saved = $state(false);
    let savedAction = $state<'confirm' | 'revoke'>('confirm');
    let refreshFailed = $state(false);
    let selectedKeys = $derived(
        preview?.findings.filter(isReviewable).map((finding) => finding.key) ?? [],
    );
    let reason = $state('');
    let revokePending = $state<string | null>(null);

    const eligibleTypes = ['duration_mismatch', 'video_ends_early', 'truncated_video'];

    function clearDraft(): void {
        reason = '';
    }

    async function loadPreview(): Promise<boolean> {
        loading = true;
        error = null;
        try {
            const request: FileHealthReviewRequest = { action: 'preview', fileId };
            const result = await adminApi.reviewFileHealth(request);
            if (result.error || !result.data || result.data.action !== 'preview') {
                error = result.error ?? m.admin_health_review_unexpected_response();
                preview = null;
                return false;
            }
            preview = result.data.preview;
            clearDraft();
            return true;
        } catch (cause) {
            error = cause instanceof Error ? cause.message : m.admin_health_review_load_error();
            preview = null;
            return false;
        } finally {
            loading = false;
        }
    }

    function blockedReasonText(): string {
        switch (preview?.blockedReason) {
            case 'file-missing':
                return m.admin_health_review_blocked_file_missing();
            case 'needs-recheck':
                return m.admin_health_review_blocked_needs_recheck();
            case 'source-changed':
                return m.admin_health_review_blocked_source_changed();
            case 'technical-failure':
                return m.admin_health_review_blocked_technical_failure();
            case 'unsupported-evidence':
                return m.admin_health_review_blocked_unsupported();
            default:
                return m.admin_health_review_blocked_generic();
        }
    }

    function isReviewable(finding: FileHealthReviewPreview['findings'][number]): boolean {
        return (
            preview?.eligible === true &&
            finding.state === 'needs-review' &&
            eligibleTypes.includes(finding.type)
        );
    }

    function formatBytes(value?: string): string {
        if (!value) return m.admin_health_review_unknown();
        const bytes = Number(value);
        return Number.isFinite(bytes)
            ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(bytes)
            : value;
    }

    function formatTime(value?: string): string {
        if (!value) return m.admin_health_review_unknown();
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    async function toggleHistory(history: FileHealthReviewHistory): Promise<void> {
        if (!preview || !history.issueKey) return;
        revokePending = history.id;
        error = null;
        try {
            const result = await adminApi.reviewFileHealth({
                action: 'revoke',
                fileId,
                reviewId: history.id,
            });
            if (
                result.error ||
                !result.data ||
                result.data.action !== 'revoke' ||
                !result.data.revoked
            ) {
                error = result.error ?? m.admin_health_review_revoke_error();
                return;
            }
            savedAction = 'revoke';
            saved = true;
            refreshFailed = false;
            clearDraft();
            const refreshed = await loadPreview();
            try {
                await onchanged?.();
            } catch {
                refreshFailed = true;
            }
            if (!refreshed) refreshFailed = true;
        } catch (cause) {
            error = cause instanceof Error ? cause.message : m.admin_health_review_revoke_error();
        } finally {
            revokePending = null;
        }
    }

    let canAccept = $derived(
        !!preview?.eligible && selectedKeys.length > 0 && !saving && !revokePending,
    );

    async function confirmReview(): Promise<void> {
        if (!preview || !canAccept) return;
        saving = true;
        error = null;
        try {
            const result = await adminApi.reviewFileHealth({
                action: 'confirm',
                fileId,
                snapshot: preview.snapshot,
                issueKeys: [...selectedKeys],
                ...(reason.trim() ? { reason: reason.trim() } : {}),
            });
            if (result.error || !result.data || result.data.action !== 'confirm') {
                error = result.error ?? m.admin_health_review_save_error();
                if (result.status === 409) {
                    preview = null;
                }
                return;
            }

            // Paint a durable success state before any parent or preview refresh can wait/fail.
            savedAction = 'confirm';
            saved = true;
            refreshFailed = false;
            clearDraft();
            const refreshed = await loadPreview();
            try {
                await onchanged?.();
            } catch {
                refreshFailed = true;
            }
            if (!refreshed) refreshFailed = true;
        } catch (cause) {
            error = cause instanceof Error ? cause.message : m.admin_health_review_save_error();
        } finally {
            saving = false;
        }
    }

    onMount(() => {
        void loadPreview();
    });
</script>

<svelte:window
    onkeydown={(event) => {
        if (event.key === 'Escape' && !saving && !revokePending) onclose();
    }} />
<div
    use:bodyPortal
    style:z-index={Z.MODAL}
    class="fixed inset-0 flex items-center justify-center bg-black/70 p-3"
    role="presentation">
    <div
        class="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-xl border border-surface-600 bg-surface-900 p-5 shadow-2xl"
        use:trapFocus
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-health-review-title">
        <header class="flex items-start justify-between gap-4">
            <div>
                <h2 id="file-health-review-title" class="text-lg font-semibold">
                    {m.admin_health_review_title()}
                </h2>
                <p class="mt-1 text-sm text-surface-400">{m.admin_health_keep_intro()}</p>
            </div>
            <button
                type="button"
                class="btn btn-sm variant-ghost-surface"
                disabled={saving || !!revokePending}
                onclick={onclose}>
                {m.admin_health_review_close()}
            </button>
        </header>

        {#if loading}<p class="mt-4 text-sm text-surface-400">{m.admin_health_review_loading()}</p>
        {:else if preview}
            <div class="mt-4 space-y-3">
                <dl
                    class="grid gap-2 rounded-lg border border-surface-700 p-3 text-sm sm:grid-cols-2">
                    <div class="sm:col-span-2">
                        <dt class="text-surface-400">{m.admin_health_review_file()}</dt>
                        <dd class="break-all font-mono">{preview.fileName}</dd>
                    </div>
                    <div class="sm:col-span-2">
                        <dt class="text-surface-400">{m.admin_health_review_path()}</dt>
                        <dd class="break-all font-mono">{preview.filePath}</dd>
                    </div>
                    <div>
                        <dt class="text-surface-400">{m.admin_health_review_modified()}</dt>
                        <dd>{formatTime(preview.fileModifiedAt)}</dd>
                    </div>
                    <div>
                        <dt class="text-surface-400">{m.admin_health_review_size()}</dt>
                        <dd>{formatBytes(preview.fileSizeBytes)}</dd>
                    </div>
                </dl>
                {#if preview.assessment}<AudioTailDiagnosis assessment={preview.assessment} />{/if}

                {#if preview.blockedReason}
                    <div
                        class="rounded border border-amber-700/50 bg-amber-950/30 p-3 text-sm text-amber-200">
                        <p>{blockedReasonText()}</p>
                        <p class="mt-1">{m.admin_health_auto_recheck()}</p>
                    </div>
                {/if}

                <div class="space-y-2">
                    <h3 class="font-medium">{m.admin_health_review_findings()}</h3>
                    {#if preview.findings.length === 0}<p class="text-sm text-surface-400">
                            {m.admin_health_review_no_findings()}
                        </p>{/if}
                    {#each preview.findings as finding (finding.key)}
                        <div class="flex gap-3 rounded border border-surface-700 p-3 text-sm">
                            <div class="min-w-0 flex-1">
                                <span class="font-medium"
                                    >{m.admin_health_review_finding_label({
                                        type: finding.type,
                                    })}</span>
                                <span class="ml-2 text-xs text-surface-400"
                                    >{m.admin_health_review_finding_state({
                                        state: finding.state,
                                    })}</span>
                                {#if finding.expectedDuration !== undefined || finding.actualDuration !== undefined}
                                    <span class="mt-1 block text-xs text-surface-300">
                                        {m.admin_health_review_durations({
                                            expected:
                                                finding.expectedDuration === undefined
                                                    ? '—'
                                                    : String(finding.expectedDuration),
                                            actual:
                                                finding.actualDuration === undefined
                                                    ? '—'
                                                    : String(finding.actualDuration),
                                        })}
                                    </span>
                                {/if}
                                {#if finding.detail}
                                    <details class="mt-1 text-xs text-surface-400">
                                        <summary class="cursor-pointer"
                                            >{m.admin_tail_raw()}</summary>
                                        <p class="break-words">{finding.detail}</p>
                                    </details>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>

                {#if preview.eligible}
                    <div class="space-y-3 border-t border-surface-700 pt-3">
                        <details>
                            <summary class="cursor-pointer text-sm"
                                >{m.admin_health_keep_notes()}</summary>
                            <textarea
                                aria-label={m.admin_health_keep_notes()}
                                class="mt-2 w-full rounded border border-surface-600 bg-surface-950 p-2"
                                rows="2"
                                maxlength="1000"
                                bind:value={reason}
                                disabled={saving}></textarea>
                        </details>
                        <button
                            type="button"
                            class="btn btn-sm variant-filled-primary"
                            disabled={!canAccept}
                            onclick={() => void confirmReview()}>
                            {saving ? m.admin_health_review_saving() : m.admin_health_keep_file()}
                        </button>
                    </div>
                {/if}

                <section
                    class="border-t border-surface-700 pt-3"
                    aria-labelledby="review-history-title">
                    <h3 id="review-history-title" class="font-medium">
                        {m.admin_health_review_history()}
                    </h3>
                    {#if preview.history.length === 0}<p class="mt-2 text-sm text-surface-400">
                            {m.admin_health_review_history_empty()}
                        </p>{/if}
                    {#each preview.history as item (item.id)}
                        <article class="mt-2 rounded border border-surface-700 p-3 text-sm">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <strong
                                    >{item.state === 'current'
                                        ? m.admin_health_keep_accepted()
                                        : item.state === 'outdated'
                                          ? m.admin_health_keep_changed()
                                          : m.admin_health_review_history_state({
                                                state: item.state,
                                            })}</strong>
                                {#if item.state !== 'revoked'}
                                    <button
                                        type="button"
                                        class="btn btn-sm variant-ghost-surface"
                                        disabled={!!revokePending || saving}
                                        onclick={() => void toggleHistory(item)}>
                                        {revokePending === item.id
                                            ? m.admin_health_review_revoking()
                                            : m.admin_health_keep_show_again()}
                                    </button>
                                {/if}
                            </div>
                            <p>
                                {m.admin_health_review_finding_label({ type: item.issueType })} · {item.decidedBy}
                                · {formatTime(item.decidedAt)}
                            </p>
                            {#if item.revokedAt}<p class="text-xs text-surface-400">
                                    {m.admin_health_review_revoked_at({
                                        time: formatTime(item.revokedAt),
                                    })}
                                </p>{/if}
                            <details class="mt-2">
                                <summary class="cursor-pointer">{m.admin_tail_raw()}</summary>
                                <p class="mt-1 break-words">
                                    <strong>{m.admin_health_review_reason()}:</strong>
                                    {item.reason}
                                </p>
                                <p class="mt-1 break-words">
                                    <strong>{m.admin_health_review_evidence()}:</strong>
                                    {item.evidence}
                                </p>
                            </details>
                        </article>
                    {/each}
                </section>
            </div>
        {/if}

        {#if saved}<p class="mt-3 text-sm text-emerald-300" role="status" aria-live="polite">
                {refreshFailed
                    ? m.admin_health_review_saved_refresh_failed()
                    : savedAction === 'revoke'
                      ? m.admin_health_review_undo_saved()
                      : m.admin_health_keep_saved()}
            </p>{/if}
        {#if error}<p class="mt-3 text-sm text-red-300" role="alert">{error}</p>{/if}
        {#if !loading && !preview}<button
                type="button"
                class="btn btn-sm variant-ghost-primary mt-3"
                onclick={() => void loadPreview()}>{m.admin_health_review_retry_preview()}</button
            >{/if}
    </div>
</div>
