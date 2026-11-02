<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import {
        Icon,
        ExclamationTriangle,
        InformationCircle,
        ClipboardDocument,
    } from 'svelte-hero-icons';
    import { apiPost, apiPatch } from '$lib/api/client.js';
    import { attentionActionKey } from '$lib/shared/attention-action-key.js';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { relativeTime } from '$lib/utils/relative-time';
    import { useNow } from '$lib/utils/use-now.svelte';
    import {
        RunTriggerResponseSchema,
        OkResponseSchema,
    } from '$lib/schemas/task-definition.schema';
    import { CancelResponseSchema } from '$lib/schemas/run.schema';
    import {
        TaskStopResponseSchema,
        StageActionResponseSchema,
    } from '$lib/schemas/api-attention-responses';
    import { V1TaskStateResponseSchema } from '$lib/schemas/api-v1';
    import TermTooltip from '../glossary/TermTooltip.svelte';
    import type { AttentionItem, AttentionAction } from '$lib/schemas/api-attention-responses';
    import { domainForItem } from '$lib/shared/attention-domain';
    import { isPersistentAttentionId } from '$lib/shared/attention-persistent';

    interface Props {
        item: AttentionItem;
        onAck: (item: AttentionItem) => void;
        /** Snooze (time-box suppress) this item for a duration. Hidden when absent. */
        onSnooze?: (item: AttentionItem, durationMs: number) => void;
        /** Refetch the attention list after a mutating action (accept-expected,
         *  retry, release, …) so a now-resolved item disappears immediately
         *  instead of lingering until the next auto-refresh poll. */
        onChanged?: () => void;
        /** Close the drawer before navigating away (so it doesn't linger during the route change). */
        onclose?: () => void;
    }
    let { item, onAck, onSnooze, onChanged, onclose }: Props = $props();

    // A pending security release stays until the install is updated; the
    // server refuses ack/snooze for it, so the buttons would only mislead.
    const persistent = $derived(isPersistentAttentionId(item.id));

    /** Default snooze window — long enough to mute known noise, short enough to not forget. */
    const SNOOZE_MS = 8 * 60 * 60 * 1000;
    let busy = $state(false);
    /** The mutating action awaiting a second (confirm) click, if any. */
    let pending = $state<AttentionAction | null>(null);
    const now = useNow();

    // ── Severity affordance ───────────────────────────────────────────────────
    // Color alone fails colour-blind operators, so every row also carries a word
    // and an icon — never hue-only.
    const sev = $derived(
        item.severity === 'critical'
            ? {
                  accent: 'border-l-red-500',
                  bg: 'bg-red-950/25',
                  text: 'text-red-300',
                  icon: ExclamationTriangle,
                  word: m.admin_ops_severity_critical(),
              }
            : item.severity === 'warning'
              ? {
                    accent: 'border-l-amber-400',
                    bg: '',
                    text: 'text-amber-300',
                    icon: ExclamationTriangle,
                    word: m.admin_ops_severity_warning(),
                }
              : {
                    accent: 'border-l-blue-400',
                    bg: '',
                    text: 'text-blue-300',
                    icon: InformationCircle,
                    word: m.admin_ops_severity_info(),
                },
    );

    const ageLabel = $derived(relativeTime(item.firstSeen, now.value));
    // Shown only when it differs from firstSeen, so a recurring item (re-detected
    // each derive cycle) reads as still-active rather than looking stale.
    const lastSeenLabel = $derived(relativeTime(item.lastSeen, now.value));

    // ── Per-kind action affordance ────────────────────────────────────────────
    // Mutating verbs get a distinct (amber, outlined) look AND a confirm step;
    // navigation stays a quiet neutral chip. An item must never present a mutating
    // verb that looks identical to "open a page".
    const MUTATING = new Set<AttentionAction['kind']>([
        'reset-circuit',
        'trigger-run',
        'cancel-run',
        'retry-item',
        'stop',
        'pause',
        'bulk-retry',
        'release-stuck',
        'accept-expected',
        'requeue-dead-letter',
    ]);
    function isMutating(a: AttentionAction): boolean {
        return MUTATING.has(a.kind);
    }

    // Spec §3.1: every attention row carries a "Details" deep-link to its
    // diagnosis surface (`sourceRef`). Suppressed when the item already offers an
    // `investigate` action (which navigates to the same place) so we never render
    // two identical "open a page" chips.
    const hasInvestigate = $derived(item.actions.some((a) => a.kind === 'investigate'));
    const showDetailsLink = $derived(Boolean(item.sourceRef) && !hasInvestigate);
    function actionClass(a: AttentionAction): string {
        return isMutating(a)
            ? 'border border-amber-500/50 text-amber-300 hover:bg-amber-500/10'
            : 'bg-surface-700 text-surface-200 hover:bg-surface-600';
    }

    /** Plain-language consequence shown before a mutating action runs. */
    function consequence(a: AttentionAction): string {
        switch (a.kind) {
            case 'reset-circuit':
                return 'Resumes this task after it was paused for repeated failures. If the underlying cause is not fixed yet, it will likely pause again.';
            case 'cancel-run':
                return 'Stops this run. Work already completed is not undone.';
            case 'trigger-run':
                return 'Starts this task now, outside its normal schedule.';
            case 'retry-item':
                return 'Tries this item again from where it stopped.';
            case 'stop':
                return 'Stops every running copy of this task right now. Already-completed work is not undone.';
            case 'pause':
                return 'Keeps this task from starting on its schedule until you resume it. Runs already in progress are not stopped.';
            case 'bulk-retry':
                return 'Tries every repeatedly-failed item at this step again. They are throttled, so this will not overload the server.';
            case 'release-stuck':
                return 'Frees up items at this step whose worker stopped unexpectedly, so they can be retried. Items still being worked on are left alone.';
            case 'accept-expected':
                return 'Marks these items as expected (for example, not found on TMDB) so they stop alerting. If you match one to a title later, it automatically returns to processing.';
            case 'requeue-dead-letter':
                return 'Retries every pipeline event that was given up on. Most are transient database hiccups that succeed on retry; any that fail again will reappear here.';
            default:
                return '';
        }
    }

    function onActionClick(a: AttentionAction): void {
        if (a.kind === 'investigate') {
            void navigate(a.href);
            return;
        }
        // Two-step confirm for mutating verbs: first click arms, second runs.
        if (pending && pending.kind === a.kind) {
            void run(a);
        } else {
            pending = a;
        }
    }

    /** Left-click without modifiers: close the drawer, then client-navigate. */
    function onNavClick(e: MouseEvent, href?: string): void {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void navigate(href);
    }

    async function navigate(href?: string): Promise<void> {
        if (!href) return;
        onclose?.();
        try {
            await goto(resolve(href));
        } catch {
            // A stale source_ref (e.g. a route that has since moved) shouldn't throw an
            // unhandled rejection from the focus-trapped drawer — fall back to a hard nav.
            window.location.href = href;
        }
    }

    async function run(a: AttentionAction): Promise<void> {
        pending = null;
        busy = true;
        try {
            const err = await execute(a);
            if (err) throw new Error(err);
            toasts.success(`${a.label} ✓`);
            // Refresh so a now-resolved item drops out of the list immediately
            // rather than lingering until the next auto-refresh poll.
            onChanged?.();
        } catch (e) {
            // Surface the real reason — a self-hoster has no other diagnostic here.
            const msg = e instanceof Error ? e.message : String(e);
            toasts.error(`${a.label} failed: ${msg}`, {
                ariaLive: 'assertive',
            });
        } finally {
            busy = false;
        }
    }

    /** Dispatch one mutating action. Returns an error string, or null on success.
     *  Each branch validates its required ids so a malformed action can never
     *  fall through to a false "✓". */
    async function execute(a: AttentionAction): Promise<string | null> {
        if (a.kind === 'reset-circuit') {
            if (!a.taskId) return 'missing task id';
            const { error } = await apiPatch(
                `/api/tasks/${encodeURIComponent(a.taskId)}/state`,
                V1TaskStateResponseSchema,
                { breaker: 'enable', force: true },
            );
            return error ?? null;
        }
        if (a.kind === 'trigger-run') {
            if (!a.taskId) return 'missing task id';
            const { error } = await apiPost(
                `/api/tasks/${encodeURIComponent(a.taskId)}/run`,
                RunTriggerResponseSchema,
                {},
            );
            return error ?? null;
        }
        if (a.kind === 'cancel-run') {
            if (!a.runId) return 'missing run id';
            const { error } = await apiPost(
                `/api/runs/${encodeURIComponent(a.runId)}/cancel`,
                CancelResponseSchema,
                { hard: false },
            );
            return error ?? null;
        }
        if (a.kind === 'retry-item') {
            if (!a.taskId || !a.itemId) return 'missing task or item id';
            const { error } = await apiPost(
                `/api/tasks/${encodeURIComponent(a.taskId)}/failures/${encodeURIComponent(a.itemId)}/retry`,
                OkResponseSchema,
                {},
            );
            return error ?? null;
        }
        if (a.kind === 'stop') {
            if (!a.taskId) return 'missing task id';
            const { error } = await apiPost(
                `/api/runs/cancel?byTask=${encodeURIComponent(a.taskId)}`,
                TaskStopResponseSchema,
                {},
            );
            return error ?? null;
        }
        if (a.kind === 'pause') {
            if (!a.taskId) return 'missing task id';
            const { error } = await apiPatch(
                `/api/tasks/${encodeURIComponent(a.taskId)}/state`,
                V1TaskStateResponseSchema,
                { schedule: 'paused' },
            );
            return error ?? null;
        }
        if (a.kind === 'bulk-retry') {
            if (!a.stageId) return 'missing stage id';
            const { error } = await apiPost(
                '/api/admin/task-system/pipeline/retry-stage',
                StageActionResponseSchema,
                { stageId: a.stageId },
            );
            return error ?? null;
        }
        if (a.kind === 'release-stuck') {
            if (!a.stageId) return 'missing stage id';
            const { error } = await apiPost(
                '/api/admin/task-system/pipeline/release-stuck',
                StageActionResponseSchema,
                { stageId: a.stageId },
            );
            return error ?? null;
        }
        if (a.kind === 'accept-expected') {
            if (!a.stageId) return 'missing stage id';
            const { error } = await apiPost(
                '/api/admin/task-system/pipeline/accept-reidentify',
                StageActionResponseSchema,
                { stageId: a.stageId },
            );
            return error ?? null;
        }
        if (a.kind === 'requeue-dead-letter') {
            // Aggregate action — requeues every dead-lettered outbox event; no id scope.
            const { error } = await apiPost(
                '/api/admin/task-system/pipeline/requeue-dead-letter',
                StageActionResponseSchema,
                {},
            );
            return error ?? null;
        }
        return `unsupported action: ${a.kind}`;
    }

    async function copyDiagnostics(): Promise<void> {
        const lines = [
            `**${item.title}**`,
            // `domain` first — it is what a maintainer needs to know which
            // subsystem raised this. `type` is still printed because it is
            // still populated and still what older reports quote, but it is
            // deprecated and goes away once the iOS client stops reading it.
            `- domain: ${domainForItem(item)}`,
            `- type: ${item.type}`,
            `- severity: ${item.severity}`,
            item.detail ? `- detail: ${item.detail}` : '',
            `- id: ${item.id}`,
            `- fingerprint: ${item.fingerprint}`,
            `- first seen: ${item.firstSeen}`,
            `- last seen: ${item.lastSeen}`,
        ].filter(Boolean);
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            toasts.success(m.admin_ops_copied());
        } catch {
            toasts.error('Copy failed');
        }
    }

    /**
     * Present only when the server computed a trend, which it does not do on the
     * first tick of an incident or for a scalar alert. Absent means "no
     * comparison was made" and renders nothing — inventing "unchanged" there
     * would claim a measurement that never happened.
     */
    const trend = $derived.by(() => {
        const t = item.trend;
        if (!t) return null;
        const numbers = m.admin_attention_trend_detail({
            previous: t.previous,
            current: t.current,
            first: t.first,
        });
        // Overall recovery outranks an upward tick, and says so plainly.
        if (t.sinceFirst === 'better' && t.direction === 'rising') {
            return {
                word: m.admin_attention_trend_recovering(),
                tone: 'text-success-300',
                numbers,
                title: numbers,
            };
        }
        if (t.direction === 'falling') {
            return {
                word: m.admin_attention_trend_falling(),
                tone: 'text-success-300',
                numbers,
                title: numbers,
            };
        }
        if (t.direction === 'rising') {
            return {
                word: m.admin_attention_trend_rising(),
                tone: 'text-error-300',
                numbers,
                title: numbers,
            };
        }
        return {
            word: m.admin_attention_trend_flat(),
            tone: 'text-surface-400',
            numbers,
            title: numbers,
        };
    });
</script>

<div
    class="rounded border border-surface-700/50 border-l-4 {sev.accent} {sev.bg} px-3 py-2 {item.acked ||
    item.snoozed
        ? 'opacity-50'
        : ''}">
    <!-- Title row: full width so long task names are not eaten by buttons -->
    <div class="flex items-start gap-2">
        <Icon src={sev.icon} class="mt-0.5 h-4 w-4 shrink-0 {sev.text}" aria-hidden="true" />
        <div class="min-w-0 flex-1">
            <div class="truncate text-sm" title={item.title}>
                <span class="sr-only">{sev.word}: </span>
                {#if item.term}
                    <TermTooltip term={item.term}>{item.title}</TermTooltip>
                {:else}
                    {item.title}
                {/if}
            </div>
            {#if item.detail}
                <div class="truncate text-xs text-surface-400" title={item.detail}>
                    {item.detail}
                </div>
            {/if}
            <!--
              Direction, next to the count it describes.

              The incident: a coverage-gap alert sat CRITICAL for 23 hours while
              its own remediation was visibly succeeding, because the threshold
              was static and nothing anywhere could say the number was falling.
              Storing the trend without rendering it would have left that intact.

              `sinceFirst` wins the wording when the two disagree: a draining
              backlog ticks upward sometimes, and reporting only the instant
              direction reads as a regression during a recovery — which is the
              misreading that let the 23 hours happen.
            -->
            {#if trend}
                <div class="mt-0.5 text-[11px] {trend.tone}" title={trend.title}>
                    {trend.word}
                    <span class="text-surface-500">· {trend.numbers}</span>
                </div>
            {/if}
            <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-surface-500">
                <span class={sev.text}>{sev.word}</span>
                {#if ageLabel}
                    <span aria-hidden="true">·</span>
                    <span title={item.firstSeen}>{m.admin_ops_first_seen()} {ageLabel}</span>
                {/if}
                {#if item.lastSeen !== item.firstSeen}
                    <span aria-hidden="true">·</span>
                    <span title={item.lastSeen}>{m.admin_ops_last_seen()} {lastSeenLabel}</span>
                {/if}
                {#if item.snoozed}
                    <span aria-hidden="true">·</span>
                    <span class="text-surface-400" title={item.snoozedUntil}
                        >{m.admin_ops_snoozed()}</span>
                {/if}
            </div>
        </div>
        <button
            class="shrink-0 rounded p-1 text-surface-500 hover:text-surface-200"
            onclick={copyDiagnostics}
            title={m.admin_ops_copy_details()}
            aria-label={m.admin_ops_copy_details()}>
            <Icon src={ClipboardDocument} class="h-3.5 w-3.5" />
        </button>
    </div>

    <!-- Confirm bar for an armed mutating action -->
    {#if pending}
        <div class="mt-2 rounded bg-amber-950/30 px-2 py-1.5 text-xs text-amber-200">
            <div>{consequence(pending)}</div>
            <div class="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                    class="rounded px-2 py-1 text-surface-400 hover:text-surface-200"
                    disabled={busy}
                    onclick={() => (pending = null)}>
                    {m.admin_ops_cancel()}
                </button>
                <button
                    class="rounded border border-amber-500/60 px-2 py-1 text-amber-200 hover:bg-amber-500/15 disabled:opacity-40"
                    disabled={busy}
                    onclick={() => pending && run(pending)}>
                    {m.admin_ops_confirm()}: {pending.label}
                </button>
            </div>
        </div>
    {/if}

    <!-- Action row -->
    <div class="mt-2 flex flex-wrap items-center justify-end gap-1.5">
        <!-- Key built in attention-action-key.ts, which explains why href/label are
             part of it and is unit-tested there (an inline key expression is invisible
             to typecheck and to every test). -->
        <!-- Navigation is a real <a href>, so it can be middle-clicked or opened
             in a new tab; a plain left-click still closes the drawer first
             (onNavClick). Only mutating verbs are buttons. -->
        {#each item.actions as a (attentionActionKey(a))}
            {#if a.kind === 'investigate' && a.href}
                <a
                    href={resolve(a.href)}
                    class="rounded px-2 py-1 text-xs {actionClass(a)}"
                    onclick={(e) => onNavClick(e, a.href)}>
                    {a.label}
                </a>
            {:else}
                <button
                    class="rounded px-2 py-1 text-xs disabled:opacity-40 {actionClass(a)}"
                    disabled={busy}
                    onclick={() => onActionClick(a)}>
                    {a.label}
                </button>
            {/if}
        {/each}
        {#if showDetailsLink && item.sourceRef}
            <a
                href={resolve(item.sourceRef)}
                class="rounded bg-surface-700 px-2 py-1 text-xs text-surface-200 hover:bg-surface-600"
                onclick={(e) => onNavClick(e, item.sourceRef)}>
                {m.admin_attention_details()}
            </a>
        {/if}
        {#if onSnooze && !persistent && !item.acked && !item.snoozed}
            <button
                class="rounded px-2 py-1 text-xs text-surface-500 hover:text-surface-300"
                onclick={() => onSnooze?.(item, SNOOZE_MS)}
                title={m.admin_ops_snooze_hint()}>
                {m.admin_ops_snooze()}
            </button>
        {/if}
        {#if !persistent && !item.acked}
            <button
                class="rounded px-2 py-1 text-xs text-surface-500 hover:text-surface-300"
                onclick={() => onAck(item)}
                title={m.admin_ops_ack_hint()}>
                {m.admin_ops_ack()}
            </button>
        {/if}
    </div>
</div>
