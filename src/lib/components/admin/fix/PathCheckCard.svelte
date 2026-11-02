<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  One library folder, as measured on this server a moment ago.

  ## Ordering is the design

  For a MISSING path the reassurance block is rendered before anything else, and
  before the operator can scroll. "My library emptied itself" is the most
  frightening thing that happens to a self-hoster, and by the time they have read
  a paragraph of diagnosis they have already decided their data is gone. The
  claim it makes is a MEASURED one — the live item count for that library, taken
  as the page loaded — not a promise about future behaviour, because the
  scanner's protection against pruning an unreadable path is threshold-based
  rather than absolute and a blanket guarantee would be a lie in the partial
  case. What is stated is what was observed.

  For a PERMISSION problem the numbers come first and the prose second, because
  the numbers ARE the fix: this uid, that owner, this mode.
-->
<script lang="ts">
    import {
        Icon,
        CheckCircle,
        XCircle,
        ExclamationTriangle,
        MinusCircle,
    } from 'svelte-hero-icons';
    import CopyBlock from './CopyBlock.svelte';
    import {
        buildChownCommand,
        buildChmodCommand,
        buildComposeUserFragment,
        buildInspectCommand,
    } from './fix-commands.js';
    import type { ScanPathReport } from './library-scan-check.schema.js';
    import { apiPost } from '$lib/api/client.js';
    import { z } from 'zod';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        report: ScanPathReport;
        processUid: number | null;
        processGid: number | null;
        /** Called after the admin confirmed a held cleanup, so the page reloads. */
        onchanged?: () => void;
    }

    let { report, processUid, processGid, onchanged }: Props = $props();

    let hold = $derived(report.cleanupHold);
    let confirming = $state(false);
    let confirmBusy = $state(false);
    let confirmError = $state<string | null>(null);

    async function confirmCleanup(): Promise<void> {
        if (!hold) return;
        confirmBusy = true;
        confirmError = null;
        const { error } = await apiPost(
            '/api/admin/fix/library-cleanup-confirm',
            z.object({ confirmed: z.boolean() }),
            { libraryPathId: report.id, walked: hold.walked },
        );
        confirmBusy = false;
        if (error) {
            confirmError = error;
            return;
        }
        confirming = false;
        onchanged?.();
    }

    let probeState = $derived(report.probe.state);

    let stateLabel = $derived.by((): string => {
        switch (probeState) {
            case 'ok':
                return m.admin_fix_files_state_ok();
            case 'missing':
                return m.admin_fix_files_state_missing();
            case 'permission-denied':
                return m.admin_fix_files_state_denied();
            case 'not-a-directory':
                return m.admin_fix_files_state_notdir();
            case 'timeout':
                return m.admin_fix_files_state_timeout();
            case 'remote':
                return m.admin_fix_files_state_remote();
            case 'disabled':
                return m.admin_fix_files_state_disabled();
            default:
                return m.admin_fix_files_state_error();
        }
    });

    let tone = $derived.by((): 'ok' | 'bad' | 'warn' | 'muted' => {
        if (probeState === 'ok') return 'ok';
        if (probeState === 'remote' || probeState === 'disabled') return 'muted';
        if (probeState === 'missing' || probeState === 'permission-denied') return 'bad';
        return 'warn';
    });

    let stateIcon = $derived(
        tone === 'ok'
            ? CheckCircle
            : tone === 'bad'
              ? XCircle
              : tone === 'muted'
                ? MinusCircle
                : ExclamationTriangle,
    );

    let facts = $derived({
        processUid,
        processGid,
        ownerUid: report.probe.ownerUid,
        ownerGid: report.probe.ownerGid,
        path: report.path,
    });

    let chown = $derived(buildChownCommand(facts));
    let compose = $derived(buildComposeUserFragment(facts));

    let scan = $derived(report.lastScan);
</script>

<div
    class="space-y-4 rounded border p-4 {tone === 'bad'
        ? 'border-error-500/40 bg-error-500/5'
        : tone === 'warn'
          ? 'border-warning-500/40 bg-warning-500/5'
          : 'border-surface-700/50 bg-surface-800/40'}">
    <div class="flex flex-wrap items-start justify-between gap-2">
        <div class="min-w-0 space-y-0.5">
            <p class="break-all font-mono text-sm text-surface-100">{report.path}</p>
            <p class="text-xs text-surface-400">
                {report.libraryName ?? report.mediaType} · {report.mediaType}
            </p>
        </div>
        <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] {tone ===
            'ok'
                ? 'bg-success-500/15 text-success-300'
                : tone === 'bad'
                  ? 'bg-error-500/15 text-error-300'
                  : tone === 'warn'
                    ? 'bg-warning-500/15 text-warning-200'
                    : 'bg-surface-600/40 text-surface-300'}">
            <Icon src={stateIcon} class="h-3.5 w-3.5" />
            {stateLabel}
        </span>
    </div>

    {#if probeState === 'missing'}
        <!-- Reassurance first. See the component header. It is a MEASURED claim,
             so it is only made when the item count was actually read. -->
        {#if report.libraryItemCount === null}
            <p
                class="rounded border border-surface-600/60 p-3 text-xs leading-relaxed text-surface-300">
                {m.admin_fix_files_missing_count_unknown()}
            </p>
        {:else}
            <div class="space-y-2 rounded border border-success-500/40 bg-success-500/10 p-3">
                <p class="text-sm font-semibold text-success-200">
                    {m.admin_fix_files_missing_safe_heading()}
                </p>
                {#if report.libraryItemCount > 0}
                    <p class="text-xs leading-relaxed text-success-100/90">
                        {m.admin_fix_files_missing_safe_count({ count: report.libraryItemCount })}
                    </p>
                {:else}
                    <p class="text-xs leading-relaxed text-success-100/90">
                        {m.admin_fix_files_missing_empty()}
                    </p>
                {/if}
                <p class="text-xs leading-relaxed text-surface-300">
                    {m.admin_fix_files_missing_safe_why()}
                </p>
            </div>
        {/if}
        <p class="text-xs leading-relaxed text-surface-300">{m.admin_fix_files_missing_next()}</p>
    {/if}

    {#if hold}
        <div class="space-y-2 rounded border border-warning-500/40 bg-warning-500/10 p-3">
            <p class="text-sm font-semibold text-warning-200">{m.admin_fix_files_hold_heading()}</p>
            <p class="text-xs leading-relaxed text-surface-200">
                {hold.reason === 'no_files'
                    ? m.admin_fix_files_hold_none({
                          known: hold.known,
                          since: new Date(hold.firstHeldAt).toLocaleString(),
                      })
                    : m.admin_fix_files_hold_few({
                          walked: hold.walked,
                          known: hold.known,
                          since: new Date(hold.firstHeldAt).toLocaleString(),
                      })}
            </p>
            {#if hold.confirmedAt}
                <p class="text-xs text-success-200">{m.admin_fix_files_hold_confirmed()}</p>
            {:else}
                <p class="text-xs leading-relaxed text-surface-300">
                    {m.admin_fix_files_hold_check()}
                </p>
                {#if confirming}
                    <p class="text-xs text-surface-100">
                        {m.admin_fix_files_hold_confirm({ missing: hold.known - hold.walked })}
                    </p>
                    <div class="flex flex-wrap gap-2">
                        <button
                            type="button"
                            class="btn btn-sm variant-filled-error"
                            disabled={confirmBusy}
                            onclick={() => void confirmCleanup()}>
                            {m.admin_fix_files_hold_confirm_yes()}
                        </button>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-surface"
                            disabled={confirmBusy}
                            onclick={() => (confirming = false)}>
                            {m.admin_fix_files_hold_cancel()}
                        </button>
                    </div>
                {:else}
                    <button
                        type="button"
                        class="btn btn-sm variant-ghost-warning"
                        onclick={() => (confirming = true)}>
                        {m.admin_fix_files_hold_button()}
                    </button>
                {/if}
                {#if confirmError}
                    <p class="text-xs text-error-300">
                        {m.admin_fix_files_hold_failed({ error: confirmError })}
                    </p>
                {/if}
            {/if}
        </div>
    {/if}

    {#if probeState === 'timeout'}
        <p class="text-xs leading-relaxed text-surface-300">{m.admin_fix_files_timeout_body()}</p>
    {/if}

    {#if probeState === 'permission-denied'}
        <div class="space-y-3">
            <p class="text-sm leading-relaxed text-surface-100">
                {#if processUid === null}
                    {m.admin_fix_files_process_unknown()}
                {:else if report.probe.ownerUid !== null && report.probe.mode !== null}
                    {m.admin_fix_files_denied_lede({
                        uid: processUid,
                        owner: report.probe.ownerUid,
                        mode: report.probe.mode,
                    })}
                {:else}
                    {m.admin_fix_files_denied_lede_noowner({ uid: processUid })}
                {/if}
            </p>
            <p class="text-xs text-surface-400">{m.admin_fix_files_denied_pick_one()}</p>

            {#if chown !== null}
                <CopyBlock
                    text={chown}
                    label={m.admin_fix_files_fix_chown_label()}
                    hint={m.admin_fix_files_fix_chown_hint()} />
            {/if}
            <CopyBlock
                text={buildChmodCommand(facts)}
                label={m.admin_fix_files_fix_chmod_label()}
                hint={m.admin_fix_files_fix_chmod_hint()} />
            {#if compose !== null}
                <CopyBlock
                    text={compose}
                    label={m.admin_fix_files_fix_compose_label()}
                    hint={m.admin_fix_files_fix_compose_hint()} />
            {/if}
            <CopyBlock
                text={buildInspectCommand(report.path)}
                label={m.admin_fix_files_fix_inspect_label()} />
        </div>
    {/if}

    {#if report.probe.detail !== null && probeState !== 'ok'}
        <p class="font-mono text-[11px] text-surface-500">{report.probe.detail}</p>
    {/if}

    {#if probeState !== 'remote' && probeState !== 'disabled'}
        <div class="space-y-1 border-t border-surface-700/40 pt-3">
            <p class="text-xs font-semibold uppercase tracking-wide text-surface-400">
                {m.admin_fix_files_last_scan_heading()}
            </p>
            {#if scan === null && report.lastScanUnreadable}
                <p class="text-xs text-warning-200">{m.admin_fix_files_last_scan_unreadable()}</p>
            {:else if scan === null}
                <p class="text-xs text-surface-300">{m.admin_fix_files_last_scan_none()}</p>
            {:else}
                {#if scan.running}
                    <p class="text-xs text-surface-200">
                        {m.admin_fix_files_last_scan_running()}
                    </p>
                {:else if scan.abandoned}
                    <p class="text-xs text-warning-200">
                        {m.admin_fix_files_last_scan_abandoned()}
                    </p>
                {/if}
                <p class="text-xs text-surface-200">
                    {m.admin_fix_files_last_scan_summary({
                        total: scan.totalFiles,
                        added: scan.added,
                        updated: scan.updated,
                    })}
                </p>
                {#if scan.unmatched > 0}
                    <p class="text-xs text-surface-300">
                        {m.admin_fix_files_last_scan_unmatched({ count: scan.unmatched })}
                    </p>
                {/if}
                {#if scan.errors > 0}
                    <p class="text-xs text-warning-200">
                        {m.admin_fix_files_last_scan_errors({ count: scan.errors })}
                    </p>
                {/if}
                <!-- "you added it after the scan" only explains a scan that
                     finished cleanly; a crashed or erroring one is the cause. -->
                {#if scan.added === 0 && !scan.running && !scan.abandoned && scan.errors === 0}
                    <p class="text-xs leading-relaxed text-surface-400">
                        {m.admin_fix_files_last_scan_zero_added()}
                    </p>
                {/if}
                <p class="text-[11px] text-surface-500">
                    {new Date(scan.startedAt).toLocaleString()}
                </p>
            {/if}
        </div>
    {/if}
</div>
