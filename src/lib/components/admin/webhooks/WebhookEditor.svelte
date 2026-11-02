<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { untrack } from 'svelte';
    import { Icon, Plus, Trash } from 'svelte-hero-icons';
    import { apiPost, apiPut } from '$lib/api/client.js';
    import { toasts } from '$lib/stores/toast.store.js';
    import { WebhookIdResponseSchema } from '$lib/schemas/api-v1.js';
    import type { WebhookRow } from './WebhookList.svelte';

    import { WEBHOOK_EVENTS } from '$lib/shared/webhook-events.js';

    const DEFAULT_EVENTS = WEBHOOK_EVENTS.filter((event) =>
        event.type.startsWith('org.lumastra.task.'),
    ).map((event) => event.type);

    /**
     * Per-user notifications forwarded to this hook. Never implied by an empty
     * event list: the operator must pick it by name, and only users who switched
     * on forwarding are sent.
     */
    const USER_NOTIFICATION_EVENT = 'org.lumastra.user.notification';

    interface Props {
        /** When set, editor is in "edit" mode (PUT). */
        existing?: WebhookRow | null;
        onSaved: () => void;
        onCancel: () => void;
    }

    let { existing = null, onSaved, onCancel }: Props = $props();

    // Form fields — initialised once from `existing`. Wrapped in untrack()
    // because Svelte 5's analyser would otherwise warn that the prop read
    // captures the initial value (intentional here — these are form inputs,
    // not derived values).
    let url = $state(untrack(() => existing?.url ?? ''));
    let label = $state(untrack(() => existing?.label ?? ''));
    let secret = $state('');
    let active = $state(untrack(() => existing?.active ?? true));
    let includeProgress = $state(untrack(() => existing?.includeProgress ?? false));
    let selectedEvents = $state<string[]>(
        untrack(() =>
            existing
                ? existing.eventFilter.filter((type) =>
                      WEBHOOK_EVENTS.some((event) => event.type === type),
                  )
                : [...DEFAULT_EVENTS],
        ),
    );
    let taskFilterRaw = $state(untrack(() => (existing?.taskFilter ?? []).join('\n')));
    let libraryGroupIdsRaw = $state(untrack(() => (existing?.libraryGroupIds ?? []).join('\n')));
    let headers = $state<Array<{ key: string; value: string }>>(
        untrack(() =>
            Object.entries(existing?.headers ?? {}).map(([k, v]) => ({
                key: k,
                value: v as string,
            })),
        ),
    );

    const MEDIA_TYPES = ['movie', 'series', 'episode', 'album'];
    let mediaTypes = $state<string[]>(untrack(() => [...(existing?.mediaTypeFilter ?? [])]));
    let batchWindowSeconds = $state(untrack(() => existing?.batchWindowSeconds ?? 60));
    let maxBatchSize = $state(untrack(() => existing?.maxBatchSize ?? 25));

    const mediaEventSelected = $derived(selectedEvents.includes('org.lumastra.media.item.added'));
    const userNotificationSelected = $derived(selectedEvents.includes(USER_NOTIFICATION_EVENT));

    function toggleMediaType(t: string): void {
        mediaTypes = mediaTypes.includes(t)
            ? mediaTypes.filter((x) => x !== t)
            : [...mediaTypes, t];
    }

    let saving = $state(false);
    let urlError = $state('');
    let secretError = $state('');
    let headerError = $state('');

    function generateSecret(): void {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        secret = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        secretError = '';
    }

    function toggleEvent(ev: string): void {
        if (selectedEvents.includes(ev)) {
            selectedEvents = selectedEvents.filter((e) => e !== ev);
        } else {
            selectedEvents = [...selectedEvents, ev];
        }
    }

    function addHeader(): void {
        headers = [...headers, { key: '', value: '' }];
    }

    function removeHeader(i: number): void {
        headers = headers.filter((_, idx) => idx !== i);
    }

    function parseLines(raw: string): string[] {
        return raw
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
    }

    function validate(): boolean {
        urlError = '';
        secretError = '';
        headerError = '';
        let ok = true;
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                urlError = 'URL must use http or https';
                ok = false;
            }
        } catch {
            urlError = 'Enter a valid URL';
            ok = false;
        }
        if (!existing && secret.length < 16) {
            secretError = 'Secret must be at least 16 characters';
            ok = false;
        }
        const seen: string[] = [];
        for (const h of headers) {
            const key = h.key.trim().toLowerCase();
            if (!key) continue;
            if (seen.includes(key)) {
                headerError = `Duplicate header key: "${h.key.trim()}"`;
                ok = false;
                break;
            }
            seen.push(key);
        }
        return ok;
    }

    async function save(): Promise<void> {
        if (!validate() || saving) return;
        saving = true;

        const headersObj: Record<string, string> = {};
        for (const h of headers) {
            if (h.key.trim()) headersObj[h.key.trim()] = h.value;
        }

        const payload: Record<string, unknown> = {
            url,
            label: label.trim() || null,
            eventFilter: selectedEvents,
            active,
            includeProgress,
        };
        // Only include secret when the operator typed one (create: required; edit: optional).
        if (secret) payload.secret = secret;
        const taskFilter = parseLines(taskFilterRaw);
        if (taskFilter.length) payload.taskFilter = taskFilter;
        const libFilter = parseLines(libraryGroupIdsRaw);
        if (libFilter.length) payload.libraryGroupIds = libFilter;
        if (Object.keys(headersObj).length) payload.headers = headersObj;
        if (mediaEventSelected) {
            if (mediaTypes.length) payload.mediaTypeFilter = mediaTypes;
            payload.batchWindowSeconds = batchWindowSeconds;
            payload.maxBatchSize = maxBatchSize;
        }

        try {
            let apiError: string | null = null;

            if (existing) {
                // PUT preserves the existing secret when none is supplied.
                const { error } = await apiPut(
                    `/api/webhooks/${existing.id}`,
                    WebhookIdResponseSchema,
                    payload,
                );
                apiError = error;
            } else {
                const { error } = await apiPost('/api/webhooks', WebhookIdResponseSchema, payload);
                apiError = error;
            }

            if (apiError) {
                toasts.error(`Save failed: ${apiError}`);
                return;
            }
            toasts.success(existing ? 'Webhook updated' : 'Webhook created');
            onSaved();
        } catch (err) {
            toasts.error(err instanceof Error ? err.message : 'Save failed');
        } finally {
            saving = false;
        }
    }
</script>

<div class="space-y-5">
    <h3 class="text-base font-semibold text-surface-100">
        {existing ? 'Edit Webhook' : 'New Webhook'}
    </h3>

    <!-- URL -->
    <div class="space-y-1">
        <label class="block text-sm text-surface-300" for="wh-url">Endpoint URL</label>
        <input
            id="wh-url"
            type="url"
            class="input w-full font-mono text-sm {urlError ? 'border-red-500' : ''}"
            placeholder="https://example.com/webhook"
            bind:value={url} />
        {#if urlError}
            <p class="text-xs text-red-400">{urlError}</p>
        {/if}
    </div>

    <!-- Name -->
    <div class="space-y-1">
        <label class="block text-sm text-surface-300" for="wh-label">
            Name <span class="text-surface-500">(optional, shown to users, e.g. "Telegram")</span>
        </label>
        <input
            id="wh-label"
            type="text"
            maxlength="80"
            class="input w-full text-sm"
            placeholder="Telegram"
            bind:value={label} />
    </div>

    <!-- Secret -->
    <div class="space-y-1">
        <label class="block text-sm text-surface-300" for="wh-secret">
            Signing Secret
            {#if existing}
                <span class="text-surface-500">(leave blank to keep existing)</span>
            {/if}
        </label>
        <input
            id="wh-secret"
            aria-describedby="wh-secret-help"
            type="password"
            class="input w-full {secretError ? 'border-red-500' : ''}"
            placeholder={existing ? '••••••••' : 'Min 16 characters'}
            bind:value={secret} />
        <button type="button" class="btn btn-sm variant-soft" onclick={generateSecret}>
            {m.webhook_secret_generate()}
        </button>
        <p class="text-xs text-surface-400" id="wh-secret-help">{m.webhook_secret_help()}</p>
        {#if secretError}
            <p class="text-xs text-red-400">{secretError}</p>
        {/if}
    </div>

    <!-- Event filter -->
    <div class="space-y-2">
        <p class="text-sm text-surface-300">Events</p>
        <div class="flex flex-wrap gap-2">
            {#each WEBHOOK_EVENTS as event (event.type)}
                {@const ev = event.type}
                <button
                    type="button"
                    class="rounded px-2 py-1 text-xs transition-colors {selectedEvents.includes(ev)
                        ? 'bg-cyan-700 text-white'
                        : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                    title={event.description}
                    data-event-type={ev}
                    onclick={() => toggleEvent(ev)}>
                    {event.label}
                </button>
            {/each}
        </div>
    </div>

    {#if userNotificationSelected}
        <p class="rounded border border-surface-700 bg-surface-800/40 p-3 text-xs text-amber-300">
            Sends each user's new-episode and request notifications, one event per notification,
            with <code>data.user.username</code> naming the recipient. Only users who turned on
            <em>Forward my notifications</em> in their settings are sent, and they see this
            webhook's name there. Private hosts (an in-cluster bot) need
            <code>WEBHOOK_PRIVATE_HOST_ALLOWLIST</code>.
        </p>
    {/if}

    {#if mediaEventSelected}
        <div class="space-y-3 rounded border border-surface-700 bg-surface-800/40 p-3">
            <p class="text-xs text-amber-300">
                Delivered as batches (<code>data.items[]</code>). Not sent during initial library
                setup (first 48&nbsp;h after install) to avoid your entire back-catalog arriving as
                "new". Only genuinely new additions are sent.
            </p>

            <div class="space-y-2">
                <p class="text-sm text-surface-300">
                    Media types <span class="text-surface-500">(empty = all)</span>
                </p>
                <div class="flex flex-wrap gap-2">
                    {#each MEDIA_TYPES as t (t)}
                        <button
                            type="button"
                            class="rounded px-2 py-1 text-xs capitalize transition-colors {mediaTypes.includes(
                                t,
                            )
                                ? 'bg-cyan-700 text-white'
                                : 'bg-surface-700 text-surface-400 hover:bg-surface-600'}"
                            onclick={() => toggleMediaType(t)}>
                            {t}
                        </button>
                    {/each}
                </div>
            </div>

            <div class="flex gap-4">
                <label class="flex-1 space-y-1 text-sm text-surface-300">
                    Batch window (seconds)
                    <input
                        type="number"
                        min="0"
                        max="3600"
                        class="input w-full"
                        bind:value={batchWindowSeconds} />
                </label>
                <label class="flex-1 space-y-1 text-sm text-surface-300">
                    Max batch size
                    <input
                        type="number"
                        min="1"
                        max="100"
                        class="input w-full"
                        bind:value={maxBatchSize} />
                </label>
            </div>
        </div>
    {/if}

    <!-- Task filter -->
    <div class="space-y-1">
        <label class="block text-sm text-surface-300" for="wh-task-filter">
            Task Filter <span class="text-surface-500">(optional, one task ID per line)</span>
        </label>
        <textarea
            id="wh-task-filter"
            class="input w-full font-mono text-xs"
            rows="3"
            placeholder="e.g. media.scan&#10;ai.embed"
            bind:value={taskFilterRaw}>
        </textarea>
    </div>

    <!-- Library group filter -->
    <div class="space-y-1">
        <label class="block text-sm text-surface-300" for="wh-lib-filter">
            Library Group Filter <span class="text-surface-500"
                >(optional, one group ID per line)</span>
        </label>
        <textarea
            id="wh-lib-filter"
            class="input w-full font-mono text-xs"
            rows="2"
            bind:value={libraryGroupIdsRaw}>
        </textarea>
    </div>

    <!-- Custom headers -->
    <div class="space-y-2">
        <div class="flex items-center justify-between">
            <p class="text-sm text-surface-300">Custom Headers</p>
            <button
                type="button"
                class="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                onclick={addHeader}>
                <Icon src={Plus} class="w-3.5 h-3.5" />
                Add
            </button>
        </div>
        {#each headers as h, i (i)}
            <div class="flex items-center gap-2">
                <input
                    type="text"
                    class="input flex-1 text-xs font-mono"
                    placeholder="Header-Name"
                    bind:value={h.key} />
                <span class="text-surface-500">:</span>
                <input
                    type="text"
                    class="input flex-1 text-xs"
                    placeholder="value"
                    bind:value={h.value} />
                <button
                    type="button"
                    class="text-surface-500 hover:text-red-400 transition-colors"
                    onclick={() => removeHeader(i)}>
                    <Icon src={Trash} class="w-4 h-4" />
                </button>
            </div>
        {/each}
        {#if headerError}
            <p class="text-xs text-red-400">{headerError}</p>
        {/if}
    </div>

    <!-- Flags -->
    <div class="flex flex-wrap gap-6">
        <label class="flex cursor-pointer items-center gap-2 text-sm text-surface-300">
            <input type="checkbox" class="checkbox" bind:checked={active} />
            Active
        </label>
        <label class="flex cursor-pointer items-center gap-2 text-sm text-surface-300">
            <input type="checkbox" class="checkbox" bind:checked={includeProgress} />
            Include progress events
        </label>
    </div>

    <!-- Actions -->
    <div class="flex justify-end gap-3 pt-2">
        <button type="button" class="btn btn-gray" onclick={onCancel}>Cancel</button>
        <button type="button" class="btn btn-blue" disabled={saving} onclick={() => void save()}>
            {saving ? 'Saving…' : existing ? 'Update' : 'Create'}
        </button>
    </div>
</div>
