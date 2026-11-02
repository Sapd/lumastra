<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, CheckCircle, ExclamationTriangle, XCircle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { formatCheckedAgo } from '$lib/utils/admin/formatters';
    import { useNow } from '$lib/utils/use-now.svelte';
    import type { AttentionVerdict } from '$lib/schemas/api-attention-responses';

    /**
     * Home's verdict banner (spec §3.1). Three plain-word states derived SOLELY
     * from the canonical verdict + open attention items — never a self-computed
     * health check — so it can never disagree with the bell or Health.
     *
     * - healthy → "Everything is healthy" + one live fact.
     * - degraded → "N things need your attention" + worst item title.
     * - critical → "Something is broken" + worst item title.
     *
     * Presentational only (props in, no fetch): Home passes the derived values so
     * the state mapping is unit-testable. Clicking scrolls to the attention list.
     */
    interface Props {
        verdict: AttentionVerdict;
        /** Count of open (unacked, unsnoozed) attention items. */
        attentionCount: number;
        /** Worst open item's title — subtitle for degraded/critical. */
        worstTitle?: string;
        /** One live fact shown in the healthy state (e.g. "42 tasks ran today · 3,123 items in library"). */
        greenFact?: string;
        /** ISO 8601 — when the payload was computed ("checked Xs ago"). */
        generatedAt: string;
        /**
         * The attention check itself failed this cycle (payload
         * `attention.unavailable`). The verdict is forced to degraded in that
         * state (fail-visible), but claiming "0 items need attention" in
         * amber is a contradiction — say the check is incomplete instead.
         */
        unavailable?: boolean;
        /** Scroll to the Needs-Attention list. */
        onScrollToList?: () => void;
    }

    let {
        verdict,
        attentionCount,
        worstTitle,
        greenFact,
        generatedAt,
        unavailable = false,
        onScrollToList,
    }: Props = $props();

    // "Degraded with zero visible items" only happens when the check is
    // unavailable — the count is unknown, not zero.
    const checkIncomplete = $derived(unavailable && verdict === 'degraded' && attentionCount === 0);

    // Re-tick so "checked Xs ago" stays live between payload refreshes.
    const now = useNow(1000);
    const checkedAgo = $derived(formatCheckedAgo(generatedAt, now.value));

    const style = $derived(
        verdict === 'critical'
            ? {
                  wrap: 'border-red-500/40 bg-red-950/25 hover:bg-red-950/35',
                  text: 'text-red-200',
                  accent: 'text-red-400',
                  icon: XCircle,
              }
            : verdict === 'degraded'
              ? {
                    wrap: 'border-amber-500/40 bg-amber-950/20 hover:bg-amber-950/30',
                    text: 'text-amber-200',
                    accent: 'text-amber-400',
                    icon: ExclamationTriangle,
                }
              : {
                    wrap: 'border-emerald-500/40 bg-emerald-950/20 hover:bg-emerald-950/30',
                    text: 'text-emerald-200',
                    accent: 'text-emerald-400',
                    icon: CheckCircle,
                },
    );

    const title = $derived(
        verdict === 'critical'
            ? m.admin_home_verdict_broken()
            : verdict === 'degraded'
              ? checkIncomplete
                  ? m.admin_home_verdict_check_incomplete()
                  : m.admin_home_verdict_attention({ count: attentionCount })
              : m.admin_home_verdict_healthy(),
    );

    // Healthy → the live fact; degraded/critical → the worst item title;
    // incomplete check → why the count can't be trusted.
    const subtitle = $derived(
        verdict === 'healthy'
            ? greenFact
            : checkIncomplete
              ? m.admin_ops_attention_unavailable()
              : worstTitle,
    );
</script>

<button
    type="button"
    class="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors {style.wrap}"
    onclick={() => onScrollToList?.()}
    aria-label={m.admin_home_verdict_jump_aria()}>
    <Icon src={style.icon} class="h-6 w-6 shrink-0 {style.accent}" aria-hidden="true" />
    <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold {style.text}">{title}</div>
        {#if subtitle}
            <div class="truncate text-xs text-surface-400" title={subtitle}>{subtitle}</div>
        {/if}
    </div>
    <span class="shrink-0 text-[11px] text-surface-500">{checkedAgo}</span>
</button>
