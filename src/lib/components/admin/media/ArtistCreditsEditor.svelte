<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd) -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { onDestroy, untrack } from 'svelte';
    import MusicEditUndo from './MusicEditUndo.svelte';
    import { page } from '$app/state';
    import { resolve } from '$lib/paths';
    import { musicAlbumPath } from './music-context.js';
    import { readArtistCredits, applyArtistCredits } from '$lib/api/music-credits.js';
    import { searchArtists } from '$lib/api/admin';
    import {
        ConfirmArtistCreditsSchema,
        type ArtistCreditChoice,
        type ArtistCreditReview,
    } from '$lib/schemas/music-credit-review.js';
    import * as m from '$lib/paraglide/messages.js';
    let {
        mediaId,
        refreshKey,
        metadataBusy = false,
        onbusychange,
        onsaved,
    }: {
        mediaId: string;
        refreshKey: string;
        metadataBusy?: boolean;
        onbusychange?: (id: string, busy: boolean) => void;
        onsaved?: () => void | Promise<void>;
    } = $props();
    interface Row {
        key: number;
        artist: ArtistCreditChoice['artist'] | null;
        creditedAs: string;
        role: 'performer' | 'remixer';
    }
    let review = $state<ArtistCreditReview | null>(null);
    let rows = $state<Row[]>([]);
    let loading = $state(false);
    let saving = $state(false);
    let dirty = $state(false);
    let stale = $state(false);
    let committed = $state(false);
    let message = $state('');
    let error = $state('');
    let query = $state('');
    let newName = $state('');
    let addRole = $state<'performer' | 'remixer'>('performer');
    let searching = $state(false);
    let candidates = $state<Array<{ id: string; title: string }>>([]);
    let recoveryKey = $state(0);
    let generation = 0;
    let searchGeneration = 0;
    let key = 0;
    let loadedId = '';
    let loadedKey = '';
    const proposed = $derived(
        rows.every((row) => row.artist !== null)
            ? rows.map((row) => ({
                  artist: row.artist!,
                  creditedAs: row.creditedAs,
                  role: row.role,
              }))
            : [],
    );
    const confirmation = $derived(
        ConfirmArtistCreditsSchema.safeParse({
            snapshot: review?.snapshot ?? '',
            credits: proposed,
        }),
    );
    function adopt(next: ArtistCreditReview): void {
        review = next;
        rows = next.credits.map((credit) => ({
            key: ++key,
            artist:
                credit.id && credit.name && credit.active
                    ? { id: credit.id, name: credit.name }
                    : null,
            creditedAs: credit.creditedAs,
            role: credit.role,
        }));
        dirty = false;
        stale = false;
        committed = false;
    }
    async function load(): Promise<void> {
        const token = ++generation;
        const id = mediaId;
        loading = true;
        error = '';
        searchGeneration += 1;
        candidates = [];
        try {
            const result = await readArtistCredits(id);
            if (token !== generation || id !== mediaId) return;
            if (!result.data) {
                error = m.music_credits_load_failed();
                return;
            }
            adopt(result.data.artistCreditReview);
        } catch {
            if (token === generation && id === mediaId) error = m.music_credits_load_failed();
        } finally {
            if (token === generation && id === mediaId) loading = false;
        }
    }
    $effect(() => {
        const id = mediaId;
        const version = refreshKey;
        untrack(() => {
            if (id !== loadedId) {
                loadedId = id;
                loadedKey = version;
                generation += 1;
                searchGeneration += 1;
                review = null;
                rows = [];
                dirty = false;
                stale = false;
                committed = false;
                saving = false;
                message = '';
                error = '';
                query = '';
                newName = '';
                void load();
            } else if (version !== loadedKey) {
                loadedKey = version;
                if (dirty || saving || committed) stale = true;
                else void load();
            }
        });
    });
    onDestroy(() => {
        generation += 1;
        searchGeneration += 1;
    });
    function changed(): void {
        dirty = true;
        message = '';
    }
    async function search(): Promise<void> {
        const token = ++searchGeneration;
        const id = mediaId;
        const subject = generation;
        const value = query.trim();
        candidates = [];
        error = '';
        if (value.length < 2) {
            searching = false;
            return;
        }
        searching = true;
        try {
            const result = await searchArtists(id, value);
            if (token !== searchGeneration || subject !== generation || id !== mediaId) return;
            if (result.data) candidates = result.data.artists;
            else error = m.music_credits_search_failed();
        } catch {
            if (token === searchGeneration && subject === generation && id === mediaId)
                error = m.music_credits_search_failed();
        } finally {
            if (token === searchGeneration && subject === generation && id === mediaId)
                searching = false;
        }
    }
    function add(artist: ArtistCreditChoice['artist']): void {
        rows = [
            ...rows,
            {
                key: ++key,
                artist,
                creditedAs: 'id' in artist ? artist.name : artist.newName,
                role: addRole,
            },
        ];
        rows = [
            ...rows.filter((row) => row.role === 'performer'),
            ...rows.filter((row) => row.role === 'remixer'),
        ];
        candidates = [];
        query = '';
        newName = '';
        changed();
    }
    function move(index: number, delta: number): void {
        const other = index + delta;
        if (other < 0 || other >= rows.length || rows[index].role !== rows[other].role) return;
        const next = [...rows];
        [next[index], next[other]] = [next[other], next[index]];
        rows = next;
        changed();
    }
    function setRole(index: number, role: 'performer' | 'remixer'): void {
        rows[index].role = role;
        rows = [
            ...rows.filter((row) => row.role === 'performer'),
            ...rows.filter((row) => row.role === 'remixer'),
        ];
        changed();
    }
    async function confirm(): Promise<void> {
        if (!review || !confirmation.success || saving || metadataBusy || stale || committed)
            return;
        const id = mediaId;
        const token = generation;
        const busy = onbusychange;
        const refresh = onsaved;
        const expected = confirmation.data;
        const before = review;
        saving = true;
        error = '';
        message = '';
        busy?.(id, true);
        try {
            const result = await applyArtistCredits(id, expected);
            if (token !== generation || id !== mediaId) return;
            if (result.error || !result.data) {
                if (!result.status || result.status >= 500) {
                    committed = true;
                    error = m.music_credits_uncertain();
                } else {
                    error = result.error ?? m.music_credits_load_failed();
                    if (result.status === 409) stale = true;
                }
                return;
            }
            committed = true;
            recoveryKey++;
            // Refresh the owner page before the final review read. That refresh
            // may update `refreshKey`; the effect correctly marks an in-flight
            // draft stale, and the authoritative read below either adopts the
            // confirmed current snapshot or leaves the stale warning in place.
            let refreshFailed = false;
            try {
                await refresh?.();
            } catch {
                refreshFailed = true;
            }
            if (token !== generation || id !== mediaId) return;
            const verified = await readArtistCredits(id);
            if (token !== generation || id !== mediaId) return;
            if (!verified.data) {
                error = m.music_credits_committed();
                return;
            }
            const actual = verified.data.artistCreditReview;
            const matches =
                actual.track.id === before.track.id &&
                actual.track.title === before.track.title &&
                actual.track.titleSource === before.track.titleSource &&
                actual.album?.id === before.album?.id &&
                actual.albumArtist?.id === before.albumArtist?.id &&
                actual.protection.locked &&
                !!actual.protection.lockedBy &&
                !!actual.protection.lockedAt &&
                actual.credits.length === expected.credits.length &&
                expected.credits.every((credit, index) => {
                    const saved = actual.credits[index];
                    return (
                        saved.active &&
                        saved.role === credit.role &&
                        saved.creditedAs === credit.creditedAs &&
                        ('id' in credit.artist
                            ? saved.id === credit.artist.id
                            : !!saved.id &&
                              saved.name?.normalize('NFC') ===
                                  credit.artist.newName.normalize('NFC'))
                    );
                });
            if (matches) {
                adopt(actual);
                message = m.music_credits_saved();
                if (refreshFailed) error = m.music_credits_refresh_failed();
            } else {
                review = actual;
                stale = true;
                error = m.music_credits_result_changed();
            }
        } catch {
            if (token === generation && id === mediaId) {
                error = committed ? m.music_credits_committed() : m.music_credits_uncertain();
                committed = true;
            }
        } finally {
            if (token === generation && id === mediaId) saving = false;
            busy?.(id, false);
        }
    }
    function roleLabel(role: 'performer' | 'remixer'): string {
        return role === 'performer' ? m.music_credits_performer() : m.music_credits_remixer();
    }
</script>

<section
    id="artist-credits"
    tabindex="-1"
    class="min-w-0 scroll-mt-24 space-y-4 rounded-xl border border-surface-700 bg-surface-800/30 p-4"
    aria-label={m.music_credits_heading()}>
    <h3 class="font-semibold">{m.music_credits_heading()}</h3>
    <p class="text-sm text-surface-400">{m.music_credits_help()}</p>
    {#if error}<p role="alert" class="break-words text-sm text-amber-200">{error}</p>{/if}
    {#if message}<p role="status" class="text-sm text-green-300">{message}</p>{/if}
    {#if stale}<p class="text-sm text-amber-200">{m.music_credits_stale()}</p>{/if}
    {#if (error || stale || committed) && !saving}<button
            type="button"
            class="btn btn-sm"
            onclick={() => void load()}>{m.music_credits_reload()}</button
        >{/if}
    {#if loading}<p class="text-sm text-surface-400">{m.loading()}</p>{:else if review}
        <p class="text-sm text-surface-300">
            {m.music_credits_owner({
                album: review.album?.title ?? '—',
                artist: review.albumArtist?.title ?? '—',
            })}
        </p>
        {#if review.album}<a
                class="text-sm text-primary-300 underline"
                href={resolve(
                    musicAlbumPath(review.album.id, page.url.searchParams, 'overview', true),
                )}>{m.music_credits_edit_owner()}</a
            >{/if}
        <details class="text-xs text-surface-400">
            <summary class="cursor-pointer">{m.music_credits_raw()}</summary>
            <pre class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(
                    review.rawEvidence,
                    null,
                    2,
                )}</pre>
        </details>
        <fieldset disabled={saving || loading || committed} class="min-w-0 space-y-3">
            <ol class="space-y-3" aria-label={m.music_credits_after()}>
                {#each rows as row, index (row.key)}
                    <li class="min-w-0 rounded-lg border border-surface-700 p-3 space-y-2">
                        <p class="break-words text-sm">
                            {row.artist
                                ? 'id' in row.artist
                                    ? row.artist.name
                                    : `${m.music_credits_new_badge()}: ${row.artist.newName}`
                                : m.music_credits_identity()}
                        </p>
                        {#if row.artist && 'id' in row.artist}<a
                                class="text-xs text-primary-300 underline"
                                href={resolve(`/admin/library/media/${row.artist.id}`)}
                                >{row.artist.name}</a
                            >{/if}
                        <div class="flex flex-wrap gap-3">
                            <label class="min-w-0 flex-1 text-xs"
                                >{m.music_credits_credited_as()}<input
                                    class="input mt-1 w-full"
                                    aria-label={m.music_credits_credited_as()}
                                    value={row.creditedAs}
                                    oninput={(event) => {
                                        rows[index].creditedAs = event.currentTarget.value;
                                        changed();
                                    }}
                                    maxlength="255" /></label>
                            <label class="text-xs"
                                >{m.music_credits_role()}<select
                                    class="select mt-1 block"
                                    aria-label={m.music_credits_role()}
                                    value={row.role}
                                    onchange={(event) =>
                                        setRole(
                                            index,
                                            event.currentTarget.value as 'performer' | 'remixer',
                                        )}
                                    ><option value="performer">{m.music_credits_performer()}</option
                                    ><option value="remixer">{m.music_credits_remixer()}</option
                                    ></select
                                ></label>
                        </div>
                        <div class="flex flex-wrap gap-3 text-xs">
                            <button
                                type="button"
                                class="btn btn-sm"
                                aria-label={m.music_credits_up()}
                                disabled={index === 0 || rows[index - 1]?.role !== row.role}
                                onclick={() => move(index, -1)}>↑</button
                            ><button
                                type="button"
                                class="btn btn-sm"
                                aria-label={m.music_credits_down()}
                                disabled={index === rows.length - 1 ||
                                    rows[index + 1]?.role !== row.role}
                                onclick={() => move(index, 1)}>↓</button
                            ><button
                                type="button"
                                class="btn btn-sm variant-ghost-error"
                                onclick={() => {
                                    rows = rows.filter((entry) => entry.key !== row.key);
                                    changed();
                                }}>{m.music_credits_remove()}</button>
                        </div>
                    </li>
                {/each}
            </ol>
            <label class="block text-xs"
                >{m.music_credits_add_role()}<select
                    class="select mt-1"
                    aria-label={m.music_credits_add_role()}
                    bind:value={addRole}
                    ><option value="performer">{m.music_credits_performer()}</option><option
                        value="remixer">{m.music_credits_remixer()}</option
                    ></select
                ></label>
            <label class="block text-sm"
                >{m.music_credits_find()}<input
                    type="search"
                    class="input mt-1 w-full"
                    aria-label={m.music_credits_find()}
                    bind:value={query}
                    oninput={() => void search()} /></label>
            {#if searching}<p class="text-xs text-surface-400">{m.loading()}</p>{/if}
            <ul class="space-y-1">
                {#each candidates as artist (artist.id)}<li>
                        <button
                            type="button"
                            class="btn btn-sm text-left break-words"
                            onclick={() => add({ id: artist.id, name: artist.title })}
                            >{artist.title}</button>
                    </li>{/each}
            </ul>
            <label class="block text-sm"
                >{m.music_credits_new_name()}<input
                    class="input mt-1 w-full"
                    aria-label={m.music_credits_new_name()}
                    bind:value={newName}
                    maxlength="255" /></label>
            <p class="text-xs text-surface-400">{m.music_credits_new_help()}</p>
            <button
                type="button"
                class="btn btn-sm"
                disabled={!newName.trim()}
                onclick={() => add({ newName: newName.trim() })}
                >{m.music_credits_add_new()}</button>
            {#if !confirmation.success}<p class="text-sm text-amber-200">
                    {m.music_credits_invalid()}
                </p>{/if}
            <button
                type="button"
                class="btn btn-sm variant-filled-primary"
                disabled={!dirty || !confirmation.success || stale || metadataBusy}
                onclick={() => void confirm()}>{m.music_credits_confirm()}</button>
            <details class="space-y-3 rounded-lg border border-surface-700 p-3">
                <summary class="cursor-pointer">{m.music_credits_review()}</summary>
                <h4 class="font-medium">{m.music_credits_before()}</h4>
                <ol class="space-y-1 text-sm">
                    {#each review.credits as credit, index (index)}<li class="break-words">
                            {roleLabel(credit.role)} · {credit.creditedAs} → {credit.name ?? '—'}
                        </li>{/each}
                </ol>
                <h4 class="font-medium">{m.music_credits_after()}</h4>
                <ol class="space-y-1 text-sm">
                    {#each proposed as credit, index (index)}<li class="break-words">
                            {roleLabel(credit.role)} · {credit.creditedAs} → {'id' in credit.artist
                                ? credit.artist.name
                                : `${m.music_credits_new_badge()}: ${credit.artist.newName}`}
                        </li>{/each}
                </ol>
            </details>
        </fieldset>
    {/if}
    <MusicEditUndo
        {mediaId}
        refreshKey={`${refreshKey}:${recoveryKey}`}
        disabled={saving || dirty || metadataBusy}
        onsaved={async () => {
            await onsaved?.();
            await load();
        }} />
</section>
