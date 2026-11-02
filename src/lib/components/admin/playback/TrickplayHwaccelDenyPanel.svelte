<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  Read/reset panel for the trickplay generator's learned hardware-decode deny
  list — a SEPARATE deny-map from the one TranscodeDiagnosticsPanel resets
  (that one belongs to the transcoding backend; this one belongs to trickplay
  sprite-sheet generation). Mirrors the clear-button pattern from the
  transcode-failures / playback-incidents admin pages: a list to show WHAT is
  denied, a per-row clear button, a clear-all, both behind ConfirmModal.
-->
<script lang="ts">
    import { Icon, ArrowPath, Trash } from 'svelte-hero-icons';
    import { apiGet, apiDelete } from '$lib/api/client.js';
    import ConfirmModal from '$lib/components/ui/ConfirmModal.svelte';
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import {
        TrickplayHwaccelDenyListResponseSchema,
        TrickplayHwaccelDenyClearedResponseSchema,
        type TrickplayHwaccelDenyEntry,
    } from '$lib/schemas/api-trickplay-hwaccel-deny.js';

    let loading = $state(false);
    let clearing = $state(false);
    let error = $state<string | null>(null);
    let device = $state<string | null>(null);
    let denied = $state<TrickplayHwaccelDenyEntry[]>([]);

    async function load(): Promise<void> {
        loading = true;
        error = null;
        const { data: result, error: err } = await apiGet(
            '/api/admin/trickplay-hwaccel-deny',
            TrickplayHwaccelDenyListResponseSchema,
        );
        loading = false;
        if (err || !result) {
            error = err ?? 'Could not load the trickplay hardware-decode deny list.';
            device = null;
            denied = [];
            return;
        }
        device = result.device;
        denied = result.denied;
    }

    function formatExpiry(expiresAt: string | null): string {
        if (!expiresAt) return 'no expiry';
        const parsed = new Date(expiresAt);
        return Number.isNaN(parsed.getTime()) ? expiresAt : parsed.toLocaleString();
    }

    async function clearOne(entry: TrickplayHwaccelDenyEntry): Promise<number | null> {
        const params = new URLSearchParams({ codec: entry.codec, pixFmt: entry.pixFmt });
        const { data: result, error: err } = await apiDelete(
            `/api/admin/trickplay-hwaccel-deny?${params.toString()}`,
            TrickplayHwaccelDenyClearedResponseSchema,
        );
        if (err || !result) {
            toasts.error(`Could not clear entry: ${err ?? 'unknown error'}`);
            return null;
        }
        return result.cleared;
    }

    function confirmClearOne(entry: TrickplayHwaccelDenyEntry): void {
        modals.open(ConfirmModal, {
            title: 'Clear deny entry',
            body: `Stop treating ${entry.codec}/${entry.pixFmt} as undecodable in hardware on ${entry.device}? The next matching source will be re-probed on this and every other replica.`,
            confirmText: 'Clear',
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                const cleared = await clearOne(entry);
                clearing = false;
                if (cleared === null) return;
                toasts.success(`Cleared ${cleared} ${cleared === 1 ? 'entry' : 'entries'}.`);
                await load();
            },
        });
    }

    function confirmClearAll(): void {
        modals.open(ConfirmModal, {
            title: 'Clear all deny entries',
            body: `Stop treating all ${denied.length} recorded codec/pixel-format combination${denied.length === 1 ? '' : 's'} as undecodable in hardware on ${device ?? 'this device'}? Every replica will re-probe them on the next matching source.`,
            confirmText: 'Clear all',
            confirmVariant: 'danger' as const,
            onConfirm: async () => {
                clearing = true;
                const { data: result, error: err } = await apiDelete(
                    '/api/admin/trickplay-hwaccel-deny',
                    TrickplayHwaccelDenyClearedResponseSchema,
                );
                clearing = false;
                if (err || !result) {
                    toasts.error(`Could not clear deny entries: ${err ?? 'unknown error'}`);
                    return;
                }
                toasts.success(
                    `Cleared ${result.cleared} entr${result.cleared === 1 ? 'y' : 'ies'}.`,
                );
                await load();
            },
        });
    }

    $effect(() => {
        void load();
    });
</script>

<section class="card-bordered p-4 space-y-3">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
            <h3 class="text-sm font-semibold text-surface-100">
                Trickplay hardware-decode deny list
            </h3>
            <p class="mt-1 text-xs text-surface-500">
                Codec/pixel-format combinations proven undecodable in hardware for trickplay
                generation. A false deny (e.g. from a since-fixed transcode bug) forces the software
                fallback until it is cleared here — clearing also resets every replica, not just
                this one.
            </p>
        </div>
        <div class="flex gap-2">
            <button
                type="button"
                class="btn btn-secondary btn-sm inline-flex items-center gap-1"
                onclick={load}
                disabled={loading}>
                <Icon src={ArrowPath} class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
                <span>Refresh</span>
            </button>
            <button
                type="button"
                class="btn btn-ghost btn-sm inline-flex items-center gap-1"
                onclick={confirmClearAll}
                disabled={clearing || denied.length === 0}>
                <Icon src={Trash} class="h-4 w-4" />
                <span>Clear all</span>
            </button>
        </div>
    </div>

    {#if error}
        <div class="rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
        </div>
    {:else if denied.length === 0}
        <p class="text-xs text-surface-500">
            {loading ? 'Loading…' : `No deny entries for ${device ?? 'the configured device'}.`}
        </p>
    {:else}
        <div class="overflow-x-auto rounded border border-surface-700/60">
            <table class="w-full text-left text-sm">
                <thead class="bg-surface-900/40 text-xs uppercase text-surface-500">
                    <tr>
                        <th class="px-3 py-2 font-medium">Codec</th>
                        <th class="px-3 py-2 font-medium">Pixel format</th>
                        <th class="px-3 py-2 font-medium">Expires</th>
                        <th class="px-3 py-2 font-medium"></th>
                    </tr>
                </thead>
                <tbody>
                    {#each denied as entry (`${entry.codec}:${entry.pixFmt}`)}
                        <tr class="border-t border-surface-800/60">
                            <td class="px-3 py-2 font-mono text-surface-200">{entry.codec}</td>
                            <td class="px-3 py-2 font-mono text-surface-200">{entry.pixFmt}</td>
                            <td class="px-3 py-2 text-surface-400"
                                >{formatExpiry(entry.expiresAt)}</td>
                            <td class="px-3 py-2 text-right">
                                <button
                                    type="button"
                                    class="btn btn-ghost btn-sm inline-flex items-center gap-1"
                                    onclick={() => confirmClearOne(entry)}
                                    disabled={clearing}>
                                    <Icon src={Trash} class="h-4 w-4" />
                                    <span>Clear</span>
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        </div>
    {/if}
</section>
