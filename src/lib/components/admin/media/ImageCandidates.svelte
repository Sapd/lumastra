<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { untrack } from 'svelte';
    import { getImageCandidates, curateImageCandidates } from '$lib/api/image-candidates.js';
    import type { ImageCandidate, CandidateMutationSchema } from '$lib/schemas/image-candidates.js';
    import type { z } from 'zod';
    import * as m from '$lib/paraglide/messages.js';

    let {
        mediaId,
        revision = 0,
        onsaved,
    }: { mediaId: string; revision?: number; onsaved?: () => void } = $props();
    let candidates = $state<ImageCandidate[]>([]);
    let error = $state('');
    let busy = $state(false);
    let version = 0;
    let undoId = $state<string | undefined>();
    function roleLabel(role: string): string {
        return (
            (
                {
                    poster: m.media_p5_poster(),
                    thumb: m.media_p5_thumb(),
                    backdrop: m.media_p5_backdrop(),
                    logo: m.media_p5_logo(),
                    banner: m.media_p5_banner(),
                } as Record<string, string>
            )[role] ?? role
        );
    }
    const roles = $derived([...new Set(candidates.map((candidate) => candidate.artwork_type))]);

    $effect(() => {
        const id = mediaId;
        void revision;
        version++;
        let cancelled = false;
        untrack(() => {
            busy = false;
            candidates = [];
            undoId = undefined;
            error = '';
        });
        void getImageCandidates(id)
            .then((result) => {
                if (cancelled) return;
                if (result.data) {
                    candidates = result.data.candidates;
                    undoId = result.data.undoId;
                } else error = result.error ?? m.image_candidates_load_failed();
            })
            .catch(() => {
                if (!cancelled) error = m.image_candidates_load_failed();
            });
        return () => {
            cancelled = true;
        };
    });
    async function mutate(input: z.infer<typeof CandidateMutationSchema>): Promise<void> {
        if (busy) return;
        const id = mediaId;
        const requestVersion = version;
        busy = true;
        error = '';
        try {
            const result = await curateImageCandidates(id, input);
            if (id !== mediaId || requestVersion !== version) return;
            if (!result.data) {
                error =
                    result.status === 409
                        ? m.media_p5_undo_conflict()
                        : (result.error ?? m.image_candidates_update_failed());
                return;
            }
            candidates = result.data.candidates;
            undoId = result.data.undoId;
            onsaved?.();
            if (input.action === 'undo') {
                const refreshed = await getImageCandidates(id);
                if (id === mediaId && requestVersion === version && refreshed.data)
                    undoId = refreshed.data.undoId;
            }
        } catch {
            if (id === mediaId && requestVersion === version)
                error = m.image_candidates_update_failed();
        } finally {
            if (id === mediaId && requestVersion === version) busy = false;
        }
    }
</script>

{#if error}<p role="alert" class="mt-2 text-sm text-red-400">{error}</p>{/if}
{#if undoId}
    <div
        role="status"
        class="flex items-center gap-3 rounded border border-surface-700 p-3 text-sm text-surface-200">
        <span>{m.media_p5_artwork_recoverable()}</span>
        <button
            type="button"
            class="text-primary-400"
            disabled={busy}
            onclick={() => undoId && mutate({ action: 'undo', receiptId: undoId })}
            >{m.media_p5_undo_artwork()}</button>
    </div>
{/if}
<details class="rounded border border-surface-700 p-3">
    <summary class="cursor-pointer text-sm font-medium text-surface-200"
        >{m.image_candidates_title()}</summary>
    <p class="mt-2 text-xs text-surface-400">{m.media_p5_artwork_automatic_help()}</p>
    <div class="mt-2 flex flex-wrap gap-3">
        {#each roles as role (role)}
            <button
                type="button"
                class="text-xs text-primary-400"
                disabled={busy}
                onclick={() => mutate({ action: 'automatic', role })}
                >{m.media_p5_automatic_artwork({ type: roleLabel(role) })}</button>
        {/each}
    </div>
    <ul class="mt-3 space-y-3">
        {#each candidates as candidate (candidate.id)}
            <li class="rounded bg-surface-800 p-3 text-xs text-surface-300">
                <p class="font-medium">
                    {roleLabel(candidate.artwork_type)}{candidate.selected
                        ? ` · ${
                              candidate.artwork_type === 'backdrop' &&
                              candidate.selection_order !== undefined
                                  ? m.image_candidates_selected_position({
                                        position: candidate.selection_order + 1,
                                    })
                                  : m.image_candidates_selected()
                          }`
                        : ''}
                    {candidate.suppressed ? ` · ${m.media_p5_artwork_hidden()}` : ''}
                </p>
                <p>{m.image_candidates_source()}: {candidate.provider}</p>
                <details class="mt-1 text-surface-400">
                    <summary>{m.media_p5_details()}</summary>
                    <p class="break-all">
                        {candidate.provider_ref} · {new Date(
                            candidate.fetched_at,
                        ).toLocaleDateString()} · {candidate.chosen_by}
                    </p>
                </details>
                <div class="mt-2 flex flex-wrap gap-3">
                    <button
                        type="button"
                        class="text-primary-400 disabled:opacity-50"
                        disabled={busy || (candidate.selected && candidate.locked)}
                        onclick={() =>
                            mutate({ action: 'select', candidateId: candidate.id, locked: true })}
                        >{m.media_p5_use_image()}</button>
                    {#if candidate.selected}<button
                            type="button"
                            class="text-primary-400 disabled:opacity-50"
                            disabled={busy}
                            onclick={() => mutate({ action: 'hide', candidateId: candidate.id })}
                            >{m.media_p5_hide_image()}</button
                        >{/if}
                    <button
                        type="button"
                        class="text-primary-400 disabled:opacity-50"
                        disabled={busy || candidate.suppressed}
                        onclick={() =>
                            mutate({ action: 'suppress-provider', provider: candidate.provider })}
                        >{m.media_p5_hide_source({ provider: candidate.provider })}</button>
                </div>
            </li>
        {:else}
            <li class="text-xs text-surface-400">{m.image_candidates_no_candidates()}</li>
        {/each}
    </ul>
</details>
