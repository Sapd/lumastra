<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // Setup of Live TV simple mode, for the helper: on/off, the channels and
    // their order (= the user's favorites), start channel, layout, text size,
    // open-on-start and the PIN lock. Used on /livetv/simple-setup (own
    // account) and in Admin > Users > Live TV (another user).
    import * as m from '$lib/paraglide/messages.js';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import type { ApiResult } from '$lib/api/types.js';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import {
        SIMPLE_MODE_MAX_CHANNELS,
        type LiveTvSimpleMode,
        type LiveTvSimpleModeUpdate,
        type SimpleModeLayout,
        type SimpleModeTextSize,
    } from '$lib/schemas/livetv-simple-mode.js';
    import SimpleChannelDisc from './SimpleChannelDisc.svelte';

    interface Props {
        mode: LiveTvSimpleMode;
        /** The visible lineup to pick from. */
        channels: LiveTvStation[];
        /** Admin editing another user: the lock can be removed without the PIN. */
        asAdmin?: boolean;
        /** Name shown in the copy ("for Anna"); absent = own account. */
        forUser?: string;
        save: (update: LiveTvSimpleModeUpdate) => Promise<ApiResult<LiveTvSimpleMode>>;
        onsaved?: (mode: LiveTvSimpleMode) => void;
    }

    let { mode, channels, asAdmin = false, forUser, save, onsaved }: Props = $props();

    // Local draft; written on Save.
    // svelte-ignore state_referenced_locally
    let enabled = $state(mode.enabled);
    // svelte-ignore state_referenced_locally
    let layout = $state<SimpleModeLayout>(mode.layout);
    // svelte-ignore state_referenced_locally
    let textSize = $state<SimpleModeTextSize>(mode.textSize);
    // svelte-ignore state_referenced_locally
    let autostart = $state(mode.autostart);
    // svelte-ignore state_referenced_locally
    let picked = $state<string[]>([...mode.stationIds]);
    // svelte-ignore state_referenced_locally
    let startStationId = $state<string>(mode.startStationId ?? '');
    // svelte-ignore state_referenced_locally
    let lock = $state(mode.locked);
    let newPin = $state('');
    // svelte-ignore state_referenced_locally
    let wasLocked = $state(mode.locked);

    let query = $state('');
    let saving = $state(false);
    let message = $state<{ ok: boolean; text: string } | null>(null);

    let byId = $derived(new Map(channels.map((c) => [c.id, c])));
    let pickedChannels = $derived(
        picked.map((id) => byId.get(id)).filter((c): c is LiveTvStation => c !== undefined),
    );
    let pickedSet = $derived(new Set(picked));
    // Chosen before, but no longer in the lineup (hidden or removed by the admin).
    let unavailableCount = $derived(picked.length - pickedChannels.length);
    let matches = $derived.by(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        return channels
            .filter((c) => !pickedSet.has(c.id) && c.name.toLowerCase().includes(q))
            .slice(0, 30);
    });
    let pinValid = $derived(/^\d{4,8}$/.test(newPin));
    let needsNewPin = $derived(lock && !wasLocked);

    function add(channel: LiveTvStation): void {
        if (picked.length >= SIMPLE_MODE_MAX_CHANNELS) return;
        picked = [...picked, channel.id];
        message = null;
    }

    function remove(id: string): void {
        picked = picked.filter((p) => p !== id);
        if (startStationId === id) startStationId = '';
        message = null;
    }

    function move(index: number, delta: number): void {
        const to = index + delta;
        if (to < 0 || to >= picked.length) return;
        const next = [...picked];
        [next[index], next[to]] = [next[to], next[index]];
        picked = next;
        message = null;
    }

    async function submit(): Promise<void> {
        if (needsNewPin && !pinValid) {
            message = { ok: false, text: m.livetv_simple_setup_pin_needed() };
            return;
        }
        saving = true;
        message = null;
        const update: LiveTvSimpleModeUpdate = {
            enabled,
            layout,
            textSize,
            autostart,
            stationIds: pickedChannels.map((c) => c.id),
        };
        if (startStationId && pickedSet.has(startStationId)) update.startStationId = startStationId;
        else update.clearStartStation = true;
        if (newPin && pinValid) update.newPin = newPin;
        if (lock !== wasLocked || (lock && update.newPin)) update.locked = lock;
        const result = await save(update);
        saving = false;
        if (result.data) {
            wasLocked = result.data.locked;
            lock = result.data.locked;
            newPin = '';
            message = { ok: true, text: m.livetv_simple_setup_saved() };
            onsaved?.(result.data);
        } else {
            message = { ok: false, text: result.error ?? m.livetv_simple_setup_failed() };
        }
    }

    const LAYOUTS: { key: SimpleModeLayout; title: () => string; body: () => string }[] = [
        {
            key: 'tv',
            title: () => m.livetv_simple_layout_tv(),
            body: () => m.livetv_simple_layout_tv_body(),
        },
        {
            key: 'list',
            title: () => m.livetv_simple_layout_list(),
            body: () => m.livetv_simple_layout_list_body(),
        },
        {
            key: 'tiles',
            title: () => m.livetv_simple_layout_tiles(),
            body: () => m.livetv_simple_layout_tiles_body(),
        },
    ];
</script>

<div class="space-y-8 text-surface-200">
    <section class="flex items-start justify-between gap-4 rounded-xl bg-surface-800/60 p-4">
        <div>
            <h3 class="text-lg font-semibold text-white">{m.livetv_simple_setup_enable()}</h3>
            <p class="mt-1 text-sm text-surface-400">
                {forUser
                    ? m.livetv_simple_setup_enable_body_for({ name: forUser })
                    : m.livetv_simple_setup_enable_body()}
            </p>
        </div>
        <Toggle
            checked={enabled}
            label={m.livetv_simple_setup_enable()}
            onchange={({ checked }) => {
                enabled = checked;
                message = null;
            }} />
    </section>

    <section>
        <h3 class="text-lg font-semibold text-white">
            {m.livetv_simple_setup_channels({ count: pickedChannels.length })}
        </h3>
        <p class="mt-1 text-sm text-surface-400">{m.livetv_simple_setup_channels_body()}</p>
        {#if unavailableCount > 0}
            <p class="mt-2 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-200" role="status">
                {m.livetv_simple_setup_unavailable({ count: unavailableCount })}
            </p>
        {/if}
        {#if pickedChannels.length === 0}
            <p class="mt-3 rounded-lg border border-dashed border-surface-600 p-4 text-sm">
                {m.livetv_simple_setup_no_channels()}
            </p>
        {:else}
            <ol class="mt-3 space-y-2">
                {#each pickedChannels as channel, i (channel.id)}
                    <li class="flex items-center gap-3 rounded-lg bg-surface-800 px-3 py-2">
                        <span class="w-8 text-right text-xl font-bold text-amber-200 tabular-nums"
                            >{i + 1}</span>
                        <SimpleChannelDisc {channel} size={2.5} />
                        <span class="min-w-0 flex-1 truncate font-medium text-white"
                            >{channel.name}</span>
                        <button
                            type="button"
                            class="min-h-10 min-w-10 rounded-lg bg-surface-700 px-2 disabled:opacity-30"
                            disabled={i === 0}
                            aria-label={m.livetv_simple_setup_move_up({ name: channel.name })}
                            onclick={() => move(i, -1)}>↑</button>
                        <button
                            type="button"
                            class="min-h-10 min-w-10 rounded-lg bg-surface-700 px-2 disabled:opacity-30"
                            disabled={i === pickedChannels.length - 1}
                            aria-label={m.livetv_simple_setup_move_down({ name: channel.name })}
                            onclick={() => move(i, 1)}>↓</button>
                        <button
                            type="button"
                            class="min-h-10 rounded-lg bg-surface-700 px-3 text-sm"
                            aria-label={m.livetv_simple_setup_remove({ name: channel.name })}
                            onclick={() => remove(channel.id)}
                            >{m.livetv_simple_setup_remove_short()}</button>
                    </li>
                {/each}
            </ol>
        {/if}
        <label class="mt-4 block text-sm font-medium" for="simple-add-channel"
            >{m.livetv_simple_setup_add()}</label>
        <input
            id="simple-add-channel"
            type="search"
            class="mt-1 w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2"
            placeholder={m.livetv_simple_setup_add_placeholder()}
            bind:value={query} />
        {#if matches.length > 0}
            <ul class="mt-2 max-h-72 space-y-1 overflow-y-auto">
                {#each matches as channel (channel.id)}
                    <li>
                        <button
                            type="button"
                            class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-800"
                            onclick={() => add(channel)}>
                            <SimpleChannelDisc {channel} size={2} />
                            <span class="min-w-0 flex-1 truncate">{channel.name}</span>
                            <span class="text-sm text-primary-300"
                                >+ {m.livetv_simple_setup_add_short()}</span>
                        </button>
                    </li>
                {/each}
            </ul>
        {:else if query.trim()}
            <p class="mt-2 text-sm text-surface-400">{m.livetv_simple_setup_add_none()}</p>
        {/if}
    </section>

    <section>
        <h3 class="text-lg font-semibold text-white">{m.livetv_simple_setup_layout()}</h3>
        <div class="mt-3 grid gap-3 sm:grid-cols-3" role="radiogroup">
            {#each LAYOUTS as item (item.key)}
                <button
                    type="button"
                    role="radio"
                    aria-checked={layout === item.key}
                    class="rounded-xl border-2 p-3 text-left {layout === item.key
                        ? 'border-amber-300 bg-surface-800'
                        : 'border-surface-700 hover:border-surface-500'}"
                    onclick={() => {
                        layout = item.key;
                        message = null;
                    }}>
                    <span class="sketch sketch-{item.key}" aria-hidden="true">
                        {#if item.key === 'tv'}
                            <span class="screen"><span class="banner"></span></span>
                        {:else if item.key === 'list'}
                            <span class="rows"><span></span><span></span><span></span></span>
                            <span class="panel"></span>
                        {:else}
                            <span class="tile"></span><span class="tile"></span><span class="tile"
                            ></span
                            ><span class="tile"></span>
                        {/if}
                    </span>
                    <span class="mt-2 block font-semibold text-white">{item.title()}</span>
                    <span class="mt-1 block text-sm text-surface-400">{item.body()}</span>
                </button>
            {/each}
        </div>
    </section>

    <section class="grid gap-6 sm:grid-cols-2">
        <div>
            <label class="block text-sm font-medium" for="simple-start"
                >{m.livetv_simple_setup_start()}</label>
            <select
                id="simple-start"
                class="mt-1 w-full rounded-lg border border-surface-600 bg-surface-900 px-3 py-2"
                bind:value={startStationId}>
                <option value="">{m.livetv_simple_setup_start_first()}</option>
                {#each pickedChannels as channel, i (channel.id)}
                    <option value={channel.id}>{i + 1} · {channel.name}</option>
                {/each}
            </select>
            <p class="mt-1 text-xs text-surface-400">{m.livetv_simple_setup_start_body()}</p>
        </div>
        <div>
            <span class="block text-sm font-medium">{m.livetv_simple_setup_text_size()}</span>
            <div class="mt-1 flex gap-2" role="radiogroup">
                {#each [['large', m.livetv_simple_setup_text_large()], ['xlarge', m.livetv_simple_setup_text_xlarge()]] as [key, label] (key)}
                    <button
                        type="button"
                        role="radio"
                        aria-checked={textSize === key}
                        class="min-h-10 flex-1 rounded-lg border-2 px-3 {textSize === key
                            ? 'border-amber-300 bg-surface-800 text-white'
                            : 'border-surface-700'} {key === 'xlarge' ? 'text-lg' : ''}"
                        onclick={() => (textSize = key as SimpleModeTextSize)}>{label}</button>
                {/each}
            </div>
        </div>
    </section>

    <section class="flex items-start justify-between gap-4">
        <div>
            <h3 class="font-semibold text-white">{m.livetv_simple_setup_autostart()}</h3>
            <p class="mt-1 text-sm text-surface-400">{m.livetv_simple_setup_autostart_body()}</p>
        </div>
        <Toggle
            checked={autostart}
            label={m.livetv_simple_setup_autostart()}
            onchange={({ checked }) => (autostart = checked)} />
    </section>

    <section class="rounded-xl border border-surface-700 p-4">
        <div class="flex items-start justify-between gap-4">
            <div>
                <h3 class="font-semibold text-white">{m.livetv_simple_setup_lock()}</h3>
                <p class="mt-1 text-sm text-surface-400">
                    {asAdmin
                        ? m.livetv_simple_setup_lock_body_admin()
                        : m.livetv_simple_setup_lock_body()}
                </p>
            </div>
            <Toggle
                checked={lock}
                label={m.livetv_simple_setup_lock()}
                onchange={({ checked }) => (lock = checked)} />
        </div>
        {#if lock}
            <label class="mt-3 block text-sm font-medium" for="simple-pin"
                >{wasLocked
                    ? m.livetv_simple_setup_pin_change()
                    : m.livetv_simple_setup_pin_new()}</label>
            <input
                id="simple-pin"
                type="password"
                inputmode="numeric"
                autocomplete="new-password"
                maxlength="8"
                class="mt-1 w-40 rounded-lg border border-surface-600 bg-surface-900 px-3 py-2 tracking-widest"
                bind:value={newPin} />
            <p class="mt-1 text-xs text-surface-400">{m.livetv_simple_setup_pin_hint()}</p>
        {/if}
    </section>

    <div class="flex flex-wrap items-center gap-3">
        <button
            type="button"
            class="min-h-11 rounded-lg bg-primary-600 px-5 font-semibold text-white hover:bg-primary-500 disabled:opacity-50"
            disabled={saving}
            onclick={() => void submit()}>
            {saving ? m.livetv_simple_setup_saving() : m.livetv_simple_setup_save()}
        </button>
        {#if message}
            <p
                class="text-sm {message.ok ? 'text-emerald-300' : 'text-red-300'}"
                role={message.ok ? 'status' : 'alert'}>
                {message.text}
            </p>
        {/if}
    </div>
    {#if mode.updatedBy && mode.updatedAt}
        <p class="text-xs text-surface-500">
            {m.livetv_simple_setup_last_change({
                name: mode.updatedBy.displayName ?? m.social_someone(),
                date: new Date(mode.updatedAt).toLocaleString(),
            })}
        </p>
    {/if}
</div>

<style>
    .sketch {
        display: flex;
        height: 4.5rem;
        gap: 4px;
        padding: 6px;
        border-radius: 0.5rem;
        background: #030712;
        border: 1px solid #374151;
    }
    .sketch-tv .screen {
        position: relative;
        flex: 1;
        border-radius: 4px;
        background: linear-gradient(135deg, #1e3a8a, #134e4a);
    }
    .sketch-tv .banner {
        position: absolute;
        left: 6%;
        right: 6%;
        bottom: 10%;
        height: 26%;
        border-radius: 3px;
        background: rgb(255 255 255 / 0.85);
    }
    .sketch-list .rows {
        display: flex;
        flex: 1.1;
        flex-direction: column;
        gap: 3px;
    }
    .sketch-list .rows span {
        flex: 1;
        border-radius: 3px;
        background: #374151;
    }
    .sketch-list .rows span:first-child {
        background: #fde047;
    }
    .sketch-list .panel {
        flex: 1;
        border-radius: 3px;
        background: #1f2937;
    }
    .sketch-tiles {
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
    }
    .sketch-tiles .tile {
        border-radius: 3px;
        background: #374151;
    }
</style>
