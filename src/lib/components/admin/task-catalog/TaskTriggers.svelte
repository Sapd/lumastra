<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Task triggers, Jellyfin-style (spec 2026-09-27 Part 2): a list of what
  starts the task — every N, daily at HH:MM, weekly on a day at HH:MM, when
  the server starts — with add / remove and "Reset to default". Replaces the
  old preset buttons (Hourly / Every 6 h / Daily / Weekly / Never).

  Shown rather than hidden, as the old control did:
  - the task's built-in schedule, marked "default", when nothing is set;
  - which time zone daily/weekly times use (the server's, not the browser's);
  - that an env var override is ignored while triggers are set;
  - why there is no editor, when the task has no schedule of its own.
  Pause is a separate switch (PUT …/state): pausing keeps the triggers.
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon, XMark, Plus } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { apiDelete, apiGet, apiPut } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import {
        TaskTriggersResponseSchema,
        type TaskTrigger,
        type TaskTriggerKind,
        type TaskTriggersResponse,
    } from '$lib/schemas/task-definition.schema.js';
    import { V1TaskStateResponseSchema } from '$lib/schemas/api-v1.js';

    interface Props {
        taskId: string;
        /** Re-read the parent's task summary after a change lands. */
        onchanged?: () => void;
    }

    let { taskId, onchanged }: Props = $props();

    let info = $state<TaskTriggersResponse | null>(null);
    let loadFailed = $state(false);
    let saving = $state(false);
    let adding = $state(false);

    // Add-form fields.
    let kind = $state<TaskTriggerKind>('daily');
    let amount = $state(6);
    let unit = $state<'m' | 'h' | 'd'>('h');
    let at = $state('03:00');
    let weekday = $state(0);

    // The INTERNAL surface: `/api/v1` wants a Bearer token and answers the
    // admin UI's session cookie with 401 (see the old ScheduleControl).
    const base = $derived(`/api/tasks/${encodeURIComponent(taskId)}`);

    async function load(): Promise<void> {
        const { data } = await apiGet(`${base}/triggers`, TaskTriggersResponseSchema);
        if (data) {
            info = data;
            loadFailed = false;
        } else {
            loadFailed = true;
        }
    }

    onMount(load);

    function landed(data: TaskTriggersResponse | null, error: string | null | undefined): boolean {
        if (error || !data) {
            toasts.error(error ?? m.admin_task_schedule_save_failed());
            return false;
        }
        info = data;
        toasts.success(m.admin_task_schedule_saved());
        onchanged?.();
        return true;
    }

    async function save(triggers: TaskTrigger[]): Promise<boolean> {
        if (saving) return false;
        saving = true;
        try {
            const { data, error } = await apiPut(`${base}/triggers`, TaskTriggersResponseSchema, {
                triggers,
            });
            return landed(data ?? null, error);
        } finally {
            saving = false;
        }
    }

    async function resetToDefault(): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const { data, error } = await apiDelete(`${base}/triggers`, TaskTriggersResponseSchema);
            landed(data ?? null, error);
        } finally {
            saving = false;
        }
    }

    async function setPaused(paused: boolean): Promise<void> {
        if (saving) return;
        saving = true;
        try {
            const { error } = await apiPut(`${base}/state`, V1TaskStateResponseSchema, {
                schedule: paused ? 'paused' : 'active',
            });
            if (error) {
                toasts.error(error);
                return;
            }
            await load();
            onchanged?.();
        } finally {
            saving = false;
        }
    }

    /** The operator's own triggers (the default one is not theirs to edit). */
    let custom = $derived(info && !info.isDefault ? info.triggers : []);

    function draft(): TaskTrigger {
        switch (kind) {
            case 'interval':
                return { kind, every: `${Math.max(1, Math.round(amount))}${unit}` };
            case 'daily':
                return { kind, at };
            case 'weekly':
                return { kind, weekday, at };
            case 'startup':
                return { kind };
        }
    }

    /** The server takes at most this many triggers per task. */
    const MAX_TRIGGERS = 8;

    function sameTrigger(a: TaskTrigger, b: TaskTrigger): boolean {
        return a.kind === b.kind && a.every === b.every && a.at === b.at && a.weekday === b.weekday;
    }

    async function add(): Promise<void> {
        const next = draft();
        // Already there: nothing to save, just close the form.
        if (custom.some((t) => sameTrigger(t, next))) {
            adding = false;
            return;
        }
        if (await save([...custom, next])) adding = false;
    }

    async function remove(index: number): Promise<void> {
        const rest = custom.filter((_, i) => i !== index);
        // Removing the last trigger means "back to the built-in schedule".
        if (rest.length === 0) await resetToDefault();
        else await save(rest);
    }

    // ── Labels ────────────────────────────────────────────────────────────

    const weekdayNames = $derived.by((): string[] => {
        const fmt = new Intl.DateTimeFormat(getLocale(), { weekday: 'long' });
        // 2026-09-27 is a Sunday: index 0 = Sunday, matching the API.
        return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2026, 8, 27 + i)));
    });

    /** "6h" → "6 hours"; anything unusual stays as written. */
    function intervalWords(every: string | undefined): string {
        const match = /^(\d+)\s*([mhdw])$/.exec(every ?? '');
        if (!match) return every ?? '—';
        const n = Number(match[1]);
        const unitName = { m: 'minute', h: 'hour', d: 'day', w: 'week' }[match[2] as 'm'];
        try {
            return new Intl.NumberFormat(getLocale(), {
                style: 'unit',
                unit: unitName,
                unitDisplay: 'long',
            }).format(n);
        } catch {
            return every ?? '—';
        }
    }

    function describe(t: TaskTrigger): string {
        switch (t.kind) {
            case 'interval':
                return m.admin_task_trigger_interval({ every: intervalWords(t.every) });
            case 'daily':
                return m.admin_task_trigger_daily({ time: t.at ?? '' });
            case 'weekly':
                return m.admin_task_trigger_weekly({
                    day: weekdayNames[t.weekday ?? 0],
                    time: t.at ?? '',
                });
            case 'startup':
                return m.admin_task_trigger_startup();
        }
    }

    function formatWhen(iso: string): string {
        return new Intl.DateTimeFormat(getLocale(), {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: info?.timeZone,
        }).format(new Date(iso));
    }

    let minMinutes = $derived(Number.parseInt(info?.minEvery ?? '15', 10) || 15);
    // A cleared number input binds as null/NaN — not a valid interval either.
    let draftTooShort = $derived(
        kind === 'interval' &&
            (!Number.isFinite(amount) ||
                Math.max(1, Math.round(amount)) * { m: 1, h: 60, d: 1440 }[unit] < minMinutes),
    );
</script>

{#if loadFailed}
    <p class="text-sm text-surface-500">{m.admin_task_schedule_unavailable()}</p>
{:else if info}
    {#if !info.schedulable}
        <p class="text-sm text-surface-400">
            {info.reason ?? m.admin_task_schedule_not_schedulable()}
        </p>
    {:else}
        <div class="space-y-3">
            <ul class="divide-y divide-surface-800 rounded border border-surface-700/60">
                {#each info.triggers as trigger, i (i)}
                    <li class="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                        <span class="text-surface-100">
                            {describe(trigger)}
                            {#if info.isDefault}
                                <span
                                    class="ml-1.5 rounded-full border border-surface-600/50 px-1.5 text-[10px] text-surface-400"
                                    >{m.admin_task_trigger_default_tag()}</span>
                            {/if}
                        </span>
                        {#if !info.isDefault}
                            <button
                                type="button"
                                class="rounded p-1 text-surface-400 hover:bg-surface-800 hover:text-red-300 disabled:opacity-40"
                                disabled={saving}
                                aria-label={m.admin_task_trigger_remove({
                                    trigger: describe(trigger),
                                })}
                                title={m.admin_task_trigger_remove({ trigger: describe(trigger) })}
                                onclick={() => void remove(i)}>
                                <Icon src={XMark} class="h-4 w-4" />
                            </button>
                        {/if}
                    </li>
                {/each}
            </ul>

            {#if info.isDefault}
                <p class="text-xs text-surface-500">{m.admin_task_triggers_default_hint()}</p>
            {/if}

            {#if adding}
                <form
                    class="space-y-2 rounded border border-surface-700/60 bg-surface-900/40 p-3 text-sm"
                    onsubmit={(e) => {
                        e.preventDefault();
                        void add();
                    }}>
                    <label class="flex flex-wrap items-center gap-2">
                        <span class="w-16 text-xs text-surface-400"
                            >{m.admin_task_trigger_type()}</span>
                        <select
                            class="rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm"
                            bind:value={kind}>
                            <option value="interval">{m.admin_task_trigger_type_interval()}</option>
                            <option value="daily">{m.admin_task_trigger_type_daily()}</option>
                            <option value="weekly">{m.admin_task_trigger_type_weekly()}</option>
                            <option value="startup">{m.admin_task_trigger_type_startup()}</option>
                        </select>
                    </label>
                    {#if kind === 'interval'}
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="w-16 text-xs text-surface-400"
                                >{m.admin_task_trigger_every_label()}</span>
                            <input
                                type="number"
                                min="1"
                                class="w-20 rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm"
                                aria-label={m.admin_task_trigger_every_label()}
                                bind:value={amount} />
                            <select
                                class="rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm"
                                aria-label={m.admin_task_trigger_every_label()}
                                bind:value={unit}>
                                <option value="m">{m.admin_task_trigger_unit_minutes()}</option>
                                <option value="h">{m.admin_task_trigger_unit_hours()}</option>
                                <option value="d">{m.admin_task_trigger_unit_days()}</option>
                            </select>
                        </div>
                        <p class="text-xs {draftTooShort ? 'text-amber-300' : 'text-surface-500'}">
                            {m.admin_task_triggers_min_interval({ minutes: minMinutes })}
                        </p>
                    {/if}
                    {#if kind === 'weekly'}
                        <label class="flex flex-wrap items-center gap-2">
                            <span class="w-16 text-xs text-surface-400"
                                >{m.admin_task_trigger_day_label()}</span>
                            <select
                                class="rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm"
                                bind:value={weekday}>
                                {#each weekdayNames as name, i (i)}
                                    <option value={i}>{name}</option>
                                {/each}
                            </select>
                        </label>
                    {/if}
                    {#if kind === 'daily' || kind === 'weekly'}
                        <label class="flex flex-wrap items-center gap-2">
                            <span class="w-16 text-xs text-surface-400"
                                >{m.admin_task_trigger_at_label()}</span>
                            <input
                                type="time"
                                required
                                class="rounded border border-surface-700 bg-surface-900 px-2 py-1 text-sm"
                                bind:value={at} />
                        </label>
                    {/if}
                    <div class="flex gap-2 pt-1">
                        <button
                            type="submit"
                            class="rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
                            disabled={saving || draftTooShort}>
                            {m.admin_task_trigger_add_confirm()}
                        </button>
                        <button
                            type="button"
                            class="rounded px-3 py-1 text-xs text-surface-300 hover:text-white"
                            onclick={() => (adding = false)}>
                            {m.common_cancel()}
                        </button>
                    </div>
                </form>
            {:else}
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded border border-surface-600/60 px-2.5 py-1 text-xs text-surface-200 hover:border-surface-500 hover:text-white disabled:opacity-40"
                        disabled={saving || custom.length >= MAX_TRIGGERS}
                        onclick={() => (adding = true)}>
                        <Icon src={Plus} class="h-3.5 w-3.5" />
                        {m.admin_task_trigger_add()}
                    </button>
                    {#if !info.isDefault}
                        <button
                            type="button"
                            class="rounded px-2.5 py-1 text-xs text-surface-400 underline hover:text-surface-200 disabled:opacity-40"
                            disabled={saving}
                            onclick={() => void resetToDefault()}>
                            {m.admin_task_triggers_reset()}
                        </button>
                    {/if}
                </div>
            {/if}

            <div class="space-y-1 text-xs text-surface-500">
                {#if info.nextRunAt}
                    <p class="text-surface-300">
                        {m.admin_task_triggers_next({ when: formatWhen(info.nextRunAt) })}
                    </p>
                {/if}
                <p>{m.admin_task_triggers_timezone({ zone: info.timeZone })}</p>
                {#if !info.isDefault && info.envOverrideActive}
                    <p class="text-amber-300">
                        {m.admin_task_triggers_env_ignored({ envVar: info.envOverrideVar ?? '' })}
                    </p>
                {:else if info.envOverrideActive}
                    <p>{m.admin_task_schedule_env_active({ envVar: info.envOverrideVar ?? '' })}</p>
                {/if}
                {#if !info.isDefault && info.updatedBy}
                    <p>{m.admin_task_schedule_updated_by({ user: info.updatedBy })}</p>
                {/if}
            </div>

            <div class="border-t border-surface-800 pt-3">
                {#if info.paused}
                    <p class="mb-2 text-xs text-amber-300">{m.admin_task_triggers_paused()}</p>
                {/if}
                <button
                    type="button"
                    class="rounded border px-2.5 py-1 text-xs disabled:opacity-40 {info.paused
                        ? 'border-emerald-700/60 text-emerald-300 hover:bg-emerald-950/30'
                        : 'border-surface-600/60 text-surface-300 hover:text-white'}"
                    disabled={saving}
                    aria-pressed={info.paused}
                    onclick={() => void setPaused(!info?.paused)}>
                    {info.paused ? m.admin_task_triggers_resume() : m.admin_task_triggers_pause()}
                </button>
            </div>
        </div>
    {/if}
{/if}
