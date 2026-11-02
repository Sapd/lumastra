<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { page } from '$app/stores';
    import { enhance } from '$app/forms';
    import * as m from '$lib/paraglide/messages.js';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import { resolve } from '$lib/paths';
    import type { CostPageData } from './+page.server.js';
    import type { ActionData } from './$types';

    let { data, form }: { data: CostPageData; form: ActionData } = $props();

    const DAY_OPTIONS = [7, 30, 90];

    async function changeDays(days: number): Promise<void> {
        const url = new URL($page.url);
        url.searchParams.set('days', String(days));
        await goto(url.toString(), { replaceState: true });
    }

    function usd(n: number): string {
        if (!Number.isFinite(n) || n <= 0) return '$0.00';
        if (n < 0.01) return `$${n.toFixed(4)}`;
        return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    function num(n: number): string {
        return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0';
    }
    function perDay(n: number): string {
        if (!Number.isFinite(n)) return '0';
        return n >= 10 ? Math.round(n).toLocaleString() : n.toFixed(1);
    }

    // ── Schedule-adherence severity styling ────────────────────────────────
    type RunRateSeverity = CostPageData['runRates'][number]['severity'];
    function rateRowClass(sev: RunRateSeverity): string {
        if (sev === 'alert') return 'bg-error-500/10';
        if (sev === 'warn') return 'bg-warning-500/10';
        return '';
    }
    function ratioTextClass(sev: RunRateSeverity): string {
        if (sev === 'alert') return 'text-error-400';
        if (sev === 'warn') return 'text-warning-400';
        return 'text-surface-400';
    }
    function ratioLabel(ratio: number): string {
        if (ratio >= 10) return `${Math.round(ratio)}×`;
        if (ratio >= 1) return `${ratio.toFixed(1)}×`;
        return `${ratio.toFixed(2)}×`;
    }

    // ── Assign price (embeddings row) ──────────────────────────────────────
    let priceFormOpen = $state(false);
    let priceInput: number | string = $state('');
    let savingPrice = $state(false);

    function openPriceForm(): void {
        priceInput =
            data.ai.embeddingPricePerMillion !== null
                ? String(data.ai.embeddingPricePerMillion)
                : '';
        priceFormOpen = true;
    }
    function closePriceForm(): void {
        priceFormOpen = false;
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_system_cost()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/system/cost']}
        title={m.route_admin_cost_title()}
        description={m.route_admin_cost_description()} />

    <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
        <h2 class="mb-1 text-sm font-semibold text-surface-200">
            {m.admin_provider_calls_title()}
        </h2>
        <p class="mb-3 text-xs text-surface-500">{m.admin_provider_calls_note()}</p>
        {#if data.providerCalls === null}
            <p class="text-sm text-warning-400">{m.admin_provider_calls_unavailable()}</p>
        {:else}
            <div class="overflow-x-auto">
                <table class="w-full text-sm">
                    <thead class="text-xs uppercase tracking-wide text-surface-500">
                        <tr>
                            <th scope="col" class="py-1 text-left font-medium"
                                >{m.admin_cost_col_provider()}</th>
                            <th scope="col" class="py-1 text-right font-medium"
                                >{m.admin_provider_calls_calls()}</th>
                            <th scope="col" class="py-1 text-right font-medium"
                                >{m.admin_cost_col_rate_limited()}</th>
                            <th scope="col" class="py-1 text-right font-medium"
                                >{m.admin_cost_col_errors()}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each data.providerCalls.providers as row (row.provider)}
                            <tr class="border-t border-surface-700/40">
                                <th
                                    scope="row"
                                    class="py-1.5 text-left font-normal text-surface-300"
                                    >{row.provider}</th>
                                <td class="py-1.5 text-right text-surface-200"
                                    >{num(row.totals.requests)}</td>
                                <td class="py-1.5 text-right text-surface-200"
                                    >{num(row.totals.rateLimited429)}</td>
                                <td class="py-1.5 text-right text-surface-200"
                                    >{num(
                                        row.totals.client4xx +
                                            row.totals.server5xx +
                                            row.totals.networkErrors,
                                    )}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
    </section>

    <!-- Timeframe selector -->
    <div class="flex items-center gap-1">
        {#each DAY_OPTIONS as d (d)}
            <button
                type="button"
                class="rounded-md px-3 py-1 text-sm transition-colors {data.sinceDays === d
                    ? 'bg-surface-700 text-white'
                    : 'text-surface-400 hover:text-surface-100'}"
                onclick={() => changeDays(d)}>
                {d}d
            </button>
        {/each}
        <span class="ml-2 text-xs text-surface-500"
            >{m.admin_cost_last_n_days({ days: data.sinceDays })}</span>
    </div>

    <p class="text-xs text-surface-500">
        {m.admin_cost_completed_floor_note()}
    </p>

    {#if data.dbError}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {data.dbError}
        </div>
    {:else}
        <!-- ── AI usage & cost (the only real dollar figure) ─────────────── -->
        <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
            <div class="mb-3 flex items-baseline justify-between">
                <h2 class="text-sm font-semibold text-surface-200">
                    {m.admin_cost_ai_usage_cost()}
                </h2>
                <span class="text-lg font-semibold text-emerald-400"
                    >{usd(data.ai.totalCostUsd)}</span>
            </div>

            {#if data.ai.embeddingTokens === 0 && data.ai.assistantMessages === 0}
                <p class="text-sm text-surface-500">
                    {m.admin_cost_no_ai_usage()}
                </p>
            {:else}
                <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <!-- Embeddings -->
                    <div class="rounded-lg border border-surface-700/60 bg-surface-900/40 p-4">
                        <div class="flex items-baseline justify-between">
                            <span class="text-sm font-medium text-surface-200"
                                >{m.admin_cost_embeddings()}</span>
                            <span class="text-sm text-emerald-400"
                                >{usd(data.ai.embeddingCostUsd)}</span>
                        </div>
                        <p class="mt-1 text-xs text-surface-400">
                            {m.admin_cost_tokens({ count: num(data.ai.embeddingTokens) })}
                            {#if data.ai.embeddingModel}
                                · {data.ai.embeddingModel}
                            {/if}
                        </p>

                        {#if data.ai.embeddingTokens > 0 && data.ai.embeddingPricePerMillion === null}
                            <p class="mt-1 text-xs text-surface-500">
                                {m.admin_cost_local_model_no_price()}
                            </p>
                            {#if data.ai.embeddingModel && !priceFormOpen}
                                <button
                                    type="button"
                                    class="btn btn-sm variant-soft-primary mt-2"
                                    onclick={openPriceForm}>
                                    {m.admin_cost_assign_price()}
                                </button>
                            {/if}
                        {:else if data.ai.embeddingPriceSource !== null}
                            <p class="mt-1 flex items-center gap-2 text-xs text-surface-500">
                                <span
                                    >{m.admin_cost_price_source_hint({
                                        source:
                                            data.ai.embeddingPriceSource === 'custom'
                                                ? m.admin_cost_price_source_custom()
                                                : m.admin_cost_price_source_builtin(),
                                    })}</span>
                                {#if !priceFormOpen}
                                    <button
                                        type="button"
                                        class="text-surface-400 underline hover:text-surface-200"
                                        onclick={openPriceForm}>
                                        {m.admin_cost_price_edit()}
                                    </button>
                                {/if}
                            </p>
                        {/if}

                        {#if priceFormOpen && data.ai.embeddingModel}
                            <form
                                method="POST"
                                action="?/assignPrice"
                                class="mt-2 space-y-2 rounded-md border border-surface-700/60 bg-surface-950/40 p-3"
                                use:enhance={() => {
                                    savingPrice = true;
                                    return async ({ result, update }) => {
                                        await update();
                                        savingPrice = false;
                                        if (result.type === 'success') {
                                            priceFormOpen = false;
                                        }
                                    };
                                }}>
                                <input type="hidden" name="model" value={data.ai.embeddingModel} />
                                <label
                                    class="block text-xs text-surface-400"
                                    for="assign-price-input">
                                    {m.admin_cost_assign_price_title({
                                        model: data.ai.embeddingModel,
                                    })}
                                </label>
                                <div class="flex items-center gap-2">
                                    <span class="text-xs text-surface-500">$</span>
                                    <input
                                        id="assign-price-input"
                                        type="number"
                                        name="pricePerMillion"
                                        min="0"
                                        step="0.0001"
                                        required
                                        placeholder={m.admin_cost_price_placeholder()}
                                        bind:value={priceInput}
                                        class="input input-sm w-28 text-sm" />
                                    <span class="text-xs text-surface-500"
                                        >{m.admin_cost_price_label()}</span>
                                </div>
                                {#if form && 'error' in form && form.error}
                                    <p class="text-xs text-error-400">
                                        {form.error}
                                    </p>
                                {/if}
                                <div class="flex gap-2">
                                    <button
                                        type="submit"
                                        class="btn btn-sm variant-filled-primary"
                                        disabled={savingPrice}>
                                        {savingPrice
                                            ? m.admin_cost_price_saving()
                                            : m.admin_cost_price_save()}
                                    </button>
                                    <button
                                        type="button"
                                        class="btn btn-sm variant-soft-surface"
                                        disabled={savingPrice}
                                        onclick={closePriceForm}>
                                        {m.admin_cost_price_cancel()}
                                    </button>
                                </div>
                            </form>
                        {/if}
                    </div>

                    <!-- Assistant -->
                    <div class="rounded-lg border border-surface-700/60 bg-surface-900/40 p-4">
                        <div class="flex items-baseline justify-between">
                            <span class="text-sm font-medium text-surface-200"
                                >{m.admin_cost_ai_assistant()}</span>
                            <span class="text-sm text-emerald-400"
                                >{usd(data.ai.assistantCostUsd)}</span>
                        </div>
                        <p class="mt-1 text-xs text-surface-400">
                            {m.admin_cost_tokens({ count: num(data.ai.assistantTokens) })} · {num(
                                data.ai.assistantMessages,
                            )}
                            {data.ai.assistantMessages === 1
                                ? m.admin_cost_message()
                                : m.admin_cost_messages()}
                        </p>
                    </div>
                </div>
            {/if}
        </section>

        <!-- ── API requests (volume only — not billed) ───────────────────── -->
        <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
            <div class="mb-1 flex items-baseline justify-between">
                <h2 class="text-sm font-semibold text-surface-200">
                    {m.admin_cost_external_api_requests()}
                </h2>
                <span class="text-sm text-surface-300">
                    {m.admin_cost_total_per_day({
                        total: num(data.apiRequests.total),
                        perDay: perDay(data.apiRequests.avgPerDay),
                    })}
                </span>
            </div>
            <p class="mb-3 text-xs text-surface-500">
                {m.admin_cost_api_volume_note()}
            </p>
            {#if data.apiRequests.byTask.length === 0}
                <p class="text-sm text-surface-500">
                    {m.admin_cost_no_api_requests()}
                </p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="text-xs uppercase tracking-wide text-surface-500">
                            <tr>
                                <th class="py-1 text-left font-medium"
                                    >{m.admin_cost_col_task()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_requests()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_avg_per_day()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each data.apiRequests.byTask as row (row.taskId)}
                                <tr class="border-t border-surface-700/40">
                                    <td class="py-1.5 text-surface-300">
                                        <span title={row.taskId}>{row.taskName}</span>
                                        {#if row.byDomain.length > 0}
                                            <div
                                                class="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-surface-500">
                                                {#each row.byDomain as d (d.domain)}
                                                    <span
                                                        >{d.domain}&nbsp;<span
                                                            class="text-surface-400"
                                                            >{num(d.count)}</span
                                                        ></span>
                                                {/each}
                                            </div>
                                        {/if}
                                    </td>
                                    <td class="py-1.5 align-top text-right text-surface-200"
                                        >{num(row.count)}</td>
                                    <td class="py-1.5 align-top text-right text-surface-400"
                                        >{perDay(row.avgPerDay)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- ── Calls per provider (tasks + page/search requests; errors, 429s) ── -->
        <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
            <div class="mb-1 flex items-baseline justify-between">
                <h2 class="text-sm font-semibold text-surface-200">
                    {m.admin_cost_providers_title()}
                </h2>
                <span class="text-sm text-surface-300">
                    {m.admin_cost_providers_totals({
                        calls: num(data.providers.taskCalls + data.providers.liveCalls),
                        errors: num(data.providers.errors),
                        rateLimited: num(data.providers.rateLimited),
                    })}
                </span>
            </div>
            <p class="mb-3 text-xs text-surface-500">
                {m.admin_cost_providers_note({
                    days: num(data.providers.sinceDays),
                    liveDays: num(data.providers.liveWindowDays),
                })}
            </p>
            {#if data.providers.rows.length === 0}
                <p class="text-sm text-surface-500">
                    {m.admin_cost_providers_none()}
                </p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="text-xs uppercase tracking-wide text-surface-500">
                            <tr>
                                <th class="py-1 text-left font-medium"
                                    >{m.admin_cost_col_provider()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_background()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_live()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_errors()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_rate_limited()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each data.providers.rows as row (row.host)}
                                <tr class="border-t border-surface-700/40">
                                    <td class="py-1.5 text-surface-300">{row.host}</td>
                                    <td class="py-1.5 text-right text-surface-200"
                                        >{num(row.taskCalls)}</td>
                                    <td class="py-1.5 text-right text-surface-200"
                                        >{num(row.liveCalls)}</td>
                                    <td
                                        class="py-1.5 text-right {row.errors > 0
                                            ? 'text-warning-400'
                                            : 'text-surface-400'}">{num(row.errors)}</td>
                                    <td
                                        class="py-1.5 text-right {row.rateLimited > 0
                                            ? 'text-warning-400'
                                            : 'text-surface-400'}">{num(row.rateLimited)}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- ── Schedule adherence / over-firing ───────────────────────────── -->
        <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
            <h2 class="mb-1 text-sm font-semibold text-surface-200">
                {m.admin_cost_schedule_adherence()}
            </h2>
            <p class="mb-3 text-xs text-surface-500">
                {m.admin_cost_schedule_adherence_note()}
            </p>
            {#if data.runRatesError}
                <p class="text-sm text-warning-400">{m.admin_cost_run_rate_unavailable()}</p>
            {:else if data.runRates.length === 0}
                <p class="text-sm text-surface-500">{m.admin_cost_no_run_rate()}</p>
            {:else}
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead class="text-xs uppercase tracking-wide text-surface-500">
                            <tr>
                                <th class="py-1 text-left font-medium"
                                    >{m.admin_cost_col_task()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_schedule()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_runs_24h()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_expected_day()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_ratio()}</th>
                                <th class="py-1 text-right font-medium"
                                    >{m.admin_cost_col_backlog()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each data.runRates as row (row.taskId)}
                                <tr
                                    class="border-t border-surface-700/40 {rateRowClass(
                                        row.severity,
                                    )}">
                                    <td class="py-1.5">
                                        <span title={row.taskId}>{row.taskName}</span>
                                    </td>
                                    <td class="py-1.5 text-right text-surface-400">
                                        {row.scheduleEvery ?? m.admin_cost_sweep_only()}
                                    </td>
                                    <td class="py-1.5 text-right text-surface-200"
                                        >{num(row.runs24h)}</td>
                                    <td class="py-1.5 text-right text-surface-400">
                                        {row.expectedPerDay === null
                                            ? '—'
                                            : num(row.expectedPerDay)}
                                    </td>
                                    <td
                                        class="py-1.5 text-right font-medium {ratioTextClass(
                                            row.severity,
                                        )}">
                                        {row.ratio === null ? '—' : ratioLabel(row.ratio)}
                                    </td>
                                    <td class="py-1.5 text-right text-surface-400">
                                        {#if row.backlog === null}
                                            —
                                        {:else}
                                            {num(row.backlog)}{row.backlogAtCeiling ? '+' : ''}
                                        {/if}
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>
            {/if}
        </section>

        <!-- ── Other recorded usage (e.g. cpu_seconds), if any ───────────── -->
        {#if data.otherUnits.length > 0}
            <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
                <h2 class="mb-3 text-sm font-semibold text-surface-200">
                    {m.admin_cost_other_usage()}
                </h2>
                <div class="space-y-1 text-sm">
                    {#each data.otherUnits as u (u.taskId + u.costUnit)}
                        <div
                            class="flex justify-between border-t border-surface-700/40 py-1 first:border-0">
                            <span class="text-surface-300" title={u.taskId}
                                >{u.taskName} · {u.costUnit}</span>
                            <span class="text-surface-200">{num(u.totalUnits)}</span>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}

        <!-- ── Recent runs that recorded usage ───────────────────────────── -->
        {#if data.recentRuns.length > 0}
            <section class="rounded-xl border border-surface-700 bg-surface-800/40 p-5">
                <h2 class="mb-3 text-sm font-semibold text-surface-200">
                    {m.admin_cost_recent_runs_with_usage()}
                </h2>
                <div class="space-y-1 text-sm">
                    {#each data.recentRuns as run (run.runId)}
                        <div
                            class="flex items-center justify-between gap-3 border-t border-surface-700/40 py-1.5 first:border-0">
                            <a
                                href="{resolve('/admin/tasks/runs')}?run={run.runId}"
                                title={run.taskId}
                                class="min-w-0 truncate py-2 text-surface-300 hover:text-surface-100 sm:py-0"
                                >{run.taskName}</a>
                            <span class="shrink-0 text-xs text-surface-400">
                                {#each run.breakdown as b (b.costUnit)}
                                    <span class="ml-2">{num(b.value)} {b.costUnit}</span>
                                {/each}
                            </span>
                        </div>
                    {/each}
                </div>
            </section>
        {/if}
    {/if}
</div>
