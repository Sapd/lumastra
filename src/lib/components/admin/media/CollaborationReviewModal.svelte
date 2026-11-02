<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { onMount } from 'svelte';
    import MusicEditUndo from './MusicEditUndo.svelte';
    import { bodyPortal } from '$lib/utils/body-portal';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { Z } from '$lib/utils/z-index';
    import { resolve } from '$lib/paths';
    import { reviewArtistCollaboration, searchArtists } from '$lib/api/admin.js';
    import type {
        CollaborationMember,
        CollaborationPreviewResult,
    } from '$lib/schemas/collaboration-review.js';
    import * as m from '$lib/paraglide/messages.js';

    let {
        artistId,
        onclose,
        onchanged,
    }: {
        artistId: string;
        onclose: () => void;
        onchanged: () => void | Promise<void>;
    } = $props();
    let members = $state<CollaborationMember[]>([]);
    let preview = $state<CollaborationPreviewResult | null>(null);
    let selected = $state<string[]>([]);
    let query = $state('');
    let newName = $state('');
    let candidates = $state<Array<{ id: string; title: string }>>([]);
    let loading = $state(false);
    let previewGeneration = 0;
    let searching = $state(false);
    let saving = $state(false);
    let recoveryKey = $state(0);
    let error = $state('');
    let message = $state('');
    let saveUncertain = $state(false);
    const eligibleCount = $derived(
        preview?.tracks.filter((track) => track.status === 'eligible').length ?? 0,
    );
    const unresolvedCount = $derived(
        preview?.tracks.filter((track) => track.status === 'abstain').length ?? 0,
    );
    const canComplete = $derived(
        !!preview &&
            !preview.reviewed &&
            !preview.overflow &&
            preview.tracks.length > 0 &&
            preview.tracks.every(
                (track) => track.status === 'already-resolved' || track.reason === 'dismissed',
            ),
    );
    function reasonText(reason: string): string {
        switch (reason) {
            case 'missing-source-tag':
                return m.collaboration_reason_source();
            case 'uncertain-files':
                return m.collaboration_reason_files();
            case 'locked':
                return m.collaboration_reason_locked();
            case 'dismissed':
                return m.collaboration_reason_dismissed();
            case 'choose-members':
                return m.collaboration_reason_members();
            case 'combined-remixer':
                return m.collaboration_reason_remixer();
            case 'unsupported-performer':
                return m.collaboration_reason_performer();
            case 'unsupported-remixer':
                return m.collaboration_reason_unresolved_remixer();
            case 'identity-collision':
                return m.collaboration_reason_collision();
            default:
                return reason;
        }
    }
    function statusText(status: 'eligible' | 'already-resolved' | 'abstain'): string {
        return status === 'eligible'
            ? m.collaboration_status_eligible()
            : status === 'already-resolved'
              ? m.collaboration_status_resolved()
              : m.collaboration_status_abstain();
    }

    function changed(): void {
        previewGeneration++;
        loading = false;
        preview = null;
        selected = [];
        message = '';
        error = '';
    }
    function add(member: CollaborationMember): void {
        if (
            members.some((candidate) =>
                'id' in candidate && 'id' in member
                    ? candidate.id === member.id
                    : 'newName' in candidate &&
                      'newName' in member &&
                      candidate.newName.toLowerCase() === member.newName.toLowerCase(),
            )
        )
            return;
        members = [...members, member];
        query = '';
        newName = '';
        candidates = [];
        changed();
    }
    function remove(index: number): void {
        members = members.filter((_, i) => i !== index);
        changed();
    }
    function move(index: number, direction: number): void {
        const target = index + direction;
        if (target < 0 || target >= members.length) return;
        const copy = [...members];
        [copy[index], copy[target]] = [copy[target], copy[index]];
        members = copy;
        changed();
    }
    async function search(): Promise<void> {
        candidates = [];
        if (query.trim().length < 2) return;
        searching = true;
        try {
            const result = await searchArtists(artistId, query.trim());
            if (result.data) candidates = result.data.artists;
            else error = m.collaboration_search_error();
        } catch {
            error = m.collaboration_search_error();
        } finally {
            searching = false;
        }
    }
    async function loadPreview(keepMessage = false): Promise<boolean> {
        const generation = ++previewGeneration;
        loading = true;
        error = '';
        if (!keepMessage) message = '';
        try {
            const result = await reviewArtistCollaboration(artistId, {
                action: 'preview',
                members,
            });
            if (generation !== previewGeneration) return false;
            if (!result.data || result.data.action !== 'preview') throw new Error('preview');
            preview = result.data.preview;
            selected = preview.tracks
                .filter((track) => track.status === 'eligible')
                .map((track) => track.id);
            saveUncertain = false;
            return true;
        } catch {
            if (generation === previewGeneration) error = m.collaboration_preview_error();
            return false;
        } finally {
            if (generation === previewGeneration) loading = false;
        }
    }
    async function apply(): Promise<void> {
        if (!preview || saving || saveUncertain) return;
        saving = true;
        error = '';
        try {
            const result = await reviewArtistCollaboration(artistId, {
                action: 'apply',
                snapshot: preview.snapshot,
                members,
                trackIds: selected,
            });
            if (result.error) {
                error = result.error;
                return;
            }
            if (!result.data || result.data.action !== 'apply') throw new Error('apply');
            const savedMessage =
                result.data.result.reviewed && result.data.result.changedTracks === 0
                    ? m.collaboration_review_saved()
                    : m.collaboration_saved({
                          changed: String(result.data.result.changedTracks),
                          albums: String(result.data.result.unchangedAlbums),
                      });
            changed();
            recoveryKey++;
            message = savedMessage;
            try {
                await onchanged();
                if (!(await loadPreview(true))) throw new Error('refresh');
                message = savedMessage;
            } catch {
                saveUncertain = true;
                error = m.collaboration_refresh_error();
            }
        } catch {
            error = m.collaboration_apply_error();
        } finally {
            saving = false;
        }
    }
    async function returnToQueue(): Promise<void> {
        if (saving) return;
        saving = true;
        error = '';
        try {
            const result = await reviewArtistCollaboration(artistId, { action: 'return' });
            if (!result.data || result.data.action !== 'return' || !result.data.returned)
                throw new Error('return');
            await loadPreview();
            await onchanged();
            message = m.collaboration_returned();
        } catch {
            error = m.collaboration_return_error();
        } finally {
            saving = false;
        }
    }
    function toggleSelected(id: string): void {
        selected = selected.includes(id)
            ? selected.filter((candidate) => candidate !== id)
            : [...selected, id];
    }
    onMount(() => {
        void loadPreview();
    });
</script>

<svelte:window
    onkeydown={(event) => {
        if (event.key === 'Escape' && !saving) onclose();
    }} />
<div
    use:bodyPortal
    style:z-index={Z.MODAL}
    class="fixed inset-0 overflow-y-auto overscroll-contain bg-black/75 p-3 sm:p-8">
    <div
        use:trapFocus
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-title"
        class="mx-auto max-w-4xl space-y-5 rounded-xl border border-surface-600 bg-surface-900 p-4 text-surface-100 shadow-2xl sm:p-6">
        <div class="flex items-start justify-between gap-4">
            <div>
                <h2 id="collaboration-title" class="text-xl font-semibold">
                    {m.collaboration_title()}
                </h2>
                <p class="text-sm text-surface-400">{preview?.artist.title ?? ''}</p>
            </div>
            <button
                type="button"
                class="rounded px-2 py-1 hover:bg-surface-700"
                onclick={onclose}
                aria-label={m.collaboration_close()}>×</button>
        </div>
        <p class="text-sm text-surface-300">{m.collaboration_help()}</p>
        {#if error}<p role="alert" class="rounded bg-red-900/40 p-2 text-sm text-red-200">
                {error}
            </p>{/if}
        {#if message}<p role="status" class="rounded bg-green-900/30 p-2 text-sm text-green-200">
                {message}
            </p>{/if}
        {#if preview?.reviewed}
            <button
                type="button"
                class="rounded border border-amber-500 px-3 py-1.5 text-sm text-amber-200"
                disabled={saving}
                onclick={() => void returnToQueue()}>{m.collaboration_return_queue()}</button>
        {/if}
        {#if preview?.suggestedNames.length}
            <div class="space-y-2 text-sm text-surface-300">
                <p>{m.collaboration_suggestions()}</p>
                {#each preview.suggestedNames as name (name)}
                    <button
                        type="button"
                        class="btn btn-sm"
                        onclick={() => {
                            query = name;
                            void search();
                        }}>{m.collaboration_search_name({ name })}</button>
                {/each}
            </div>
        {/if}
        <section aria-label={m.collaboration_members()} class="space-y-2">
            <h3 class="text-base font-semibold">{m.collaboration_members()}</h3>
            {#each members as member, index (index)}
                <div
                    class="flex flex-wrap items-center gap-2 rounded border border-surface-700 p-2 text-sm">
                    <span class="min-w-0 flex-1"
                        >{index + 1}. {'id' in member ? member.name : member.newName}
                        {'newName' in member ? `(${m.collaboration_new_identity()})` : ''}</span>
                    <button
                        type="button"
                        class="rounded border border-surface-600 px-2"
                        disabled={index === 0}
                        onclick={() => move(index, -1)}
                        aria-label={m.collaboration_move_up()}>↑</button>
                    <button
                        type="button"
                        class="rounded border border-surface-600 px-2"
                        disabled={index === members.length - 1}
                        onclick={() => move(index, 1)}
                        aria-label={m.collaboration_move_down()}>↓</button>
                    <button
                        type="button"
                        class="rounded border border-surface-600 px-2"
                        onclick={() => remove(index)}>{m.collaboration_remove()}</button>
                </div>
            {/each}
            <div class="flex flex-wrap gap-2">
                <label class="min-w-48 flex-1 text-sm"
                    >{m.collaboration_search_artist()}
                    <input
                        class="mt-1 w-full rounded border border-surface-600 bg-surface-800 p-2"
                        bind:value={query} />
                </label>
                <button
                    type="button"
                    class="self-end rounded border border-surface-600 px-3 py-2 text-sm"
                    disabled={searching}
                    onclick={() => void search()}>{m.collaboration_search()}</button>
            </div>
            {#if candidates.length}
                <ul class="max-h-40 overflow-auto rounded border border-surface-700 p-2">
                    {#each candidates as candidate (candidate.id)}
                        <li>
                            <button
                                type="button"
                                class="w-full px-2 py-1 text-left text-sm hover:bg-surface-700"
                                onclick={() => add({ id: candidate.id, name: candidate.title })}
                                >{candidate.title}</button>
                        </li>
                    {/each}
                </ul>
            {/if}
            <div class="flex flex-wrap gap-2">
                <label class="min-w-48 flex-1 text-sm"
                    >{m.collaboration_new_artist()}
                    <input
                        class="mt-1 w-full rounded border border-surface-600 bg-surface-800 p-2"
                        bind:value={newName}
                        maxlength="255" />
                </label>
                <button
                    type="button"
                    class="self-end rounded border border-surface-600 px-3 py-2 text-sm"
                    disabled={!newName.trim()}
                    onclick={() => add({ newName: newName.trim() })}
                    >{m.collaboration_add_new()}</button>
            </div>
            <button
                type="button"
                class="rounded bg-primary-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                disabled={loading || members.length < 2}
                onclick={() => void loadPreview()}>{m.collaboration_preview()}</button>
        </section>
        {#if loading && !message}<p role="status">{m.collaboration_loading()}</p>{/if}
        {#if preview && members.length >= 2}
            <section class="space-y-3">
                <h3 class="text-base font-semibold">{m.collaboration_impact()}</h3>
                <p class="text-sm text-surface-300">
                    {m.collaboration_counts({
                        eligible: String(eligibleCount),
                        unresolved: String(unresolvedCount),
                        albums: String(preview.albums.length),
                    })}
                </p>
                {#if preview.overflow}<p class="text-sm text-amber-300">
                        {m.collaboration_overflow()}
                    </p>{/if}
                {#each preview.witnesses as witness (witness.member)}
                    <p class="text-xs text-surface-400">
                        {witness.member}: {witness.tags.length
                            ? witness.tags.join(' · ')
                            : m.collaboration_no_witnesses()}
                    </p>
                {/each}
                <div class="max-h-80 space-y-2 overflow-auto">
                    {#each preview.tracks as track (track.id)}
                        <div class="rounded border border-surface-700 p-2 text-sm">
                            <div class="flex items-start gap-2">
                                <input
                                    type="checkbox"
                                    aria-label={m.collaboration_select_track({
                                        title: track.title ?? track.id,
                                    })}
                                    checked={selected.includes(track.id)}
                                    disabled={track.status !== 'eligible'}
                                    onchange={() => toggleSelected(track.id)} />
                                <div class="min-w-0 flex-1">
                                    <div class="font-medium">{track.title ?? track.id}</div>
                                    <div class="text-xs text-surface-400">
                                        {track.albumTitle ?? '—'} · {statusText(track.status)}
                                    </div>
                                    <div class="text-xs">
                                        {m.collaboration_source()}: {track.sourceTag ?? '—'}
                                    </div>
                                    <div class="text-xs">
                                        {m.collaboration_before()}: {track.before
                                            .filter((credit) => credit.role === 'performer')
                                            .map((credit) => credit.creditedAs)
                                            .join(' · ') || '—'}
                                    </div>
                                    <div class="text-xs">
                                        {m.collaboration_after()}: {track.after
                                            .filter((credit) => credit.role === 'performer')
                                            .map((credit) => credit.creditedAs)
                                            .join(' · ') || '—'}
                                    </div>
                                    {#if track.reason}<p class="text-xs text-amber-300">
                                            {reasonText(track.reason)}
                                        </p>{/if}
                                    {#if track.status === 'abstain'}<a
                                            class="text-xs text-primary-300 underline"
                                            href={resolve(`/admin/library/media/${track.id}`)}
                                            >{m.collaboration_manual_editor()}</a
                                        >{/if}
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
                <h3 class="text-base font-semibold">{m.collaboration_album_owners()}</h3>
                <ul class="text-sm text-surface-300">
                    {#each preview.albums as album (album.id)}
                        <li>
                            {album.title ?? album.id} → {album.ownerTitle ?? '—'} ({m.collaboration_unchanged()})
                        </li>
                    {/each}
                </ul>
                <p class="text-sm text-surface-400">{m.collaboration_completion_help()}</p>
                <button
                    type="button"
                    class="rounded bg-primary-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
                    disabled={saving || saveUncertain || (selected.length === 0 && !canComplete)}
                    onclick={() => void apply()}>{m.collaboration_confirm()}</button>
            </section>
        {/if}
        <MusicEditUndo
            mediaId={artistId}
            refreshKey={recoveryKey}
            disabled={saving}
            onsaved={async () => {
                await onchanged();
                await loadPreview();
            }} />
    </div>
</div>
