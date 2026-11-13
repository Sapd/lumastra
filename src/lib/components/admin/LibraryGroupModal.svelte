<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import { modals } from '$lib/stores/modal.store';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { createLibraryGroup, updateLibraryGroup } from '$lib/api/admin';
    import { dndzone } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { Icon, XMark } from 'svelte-hero-icons';
    import { requireValue } from '$lib/utils/runtime-validation';

    interface LibraryGroupData {
        id: string;
        name: string;
        description?: string;
        icon?: string;
        sortOrder: number;
        maxAgeRating?: number | null;
        metadataProviderChain?: string[];
    }

    interface Props {
        /** Pass existing group to edit, or omit for create mode */
        group?: LibraryGroupData;
        /** Default sort order for new groups */
        defaultSortOrder?: number;
        /** Called after successful save with 'created' or 'updated' */
        onSaved: (action: 'created' | 'updated') => void;
    }

    let { group, defaultSortOrder = 0, onSaved }: Props = $props();

    // Modal props are immutable after open — snapshot initial values intentionally
    // svelte-ignore state_referenced_locally
    const isEdit = !!group;
    // svelte-ignore state_referenced_locally
    let name = $state(group?.name ?? '');
    // svelte-ignore state_referenced_locally
    let description = $state(group?.description ?? '');
    // svelte-ignore state_referenced_locally
    let icon = $state(group?.icon ?? '');
    // svelte-ignore state_referenced_locally
    let sortOrder = $state(group?.sortOrder ?? defaultSortOrder);
    // svelte-ignore state_referenced_locally
    let maxAgeRating = $state<number | null>(group?.maxAgeRating ?? null);
    // svelte-ignore state_referenced_locally
    let useGlobalChain = $state(!group?.metadataProviderChain);
    // svelte-ignore state_referenced_locally
    let providerChain = $state<string[] | null>(
        group?.metadataProviderChain ? [...group.metadataProviderChain] : null,
    );
    let saving = $state(false);

    // Provider chain DnD
    const availableProviders = ['tmdb', 'mdblist', 'anidb', 'tvdb', 'mal', 'trakt', 'jellyfin'];
    let dndIdCounter = 0;
    // svelte-ignore state_referenced_locally
    let chainDndItems = $state<Array<{ id: string; provider: string }>>(
        (group?.metadataProviderChain ?? []).map((p: string) => ({
            id: `prov-${dndIdCounter++}`,
            provider: p,
        })),
    );
    let unusedProviders = $derived(availableProviders.filter((p) => !providerChain?.includes(p)));

    function syncChainDndItems(): void {
        chainDndItems = (providerChain ?? []).map((p) => ({
            id: `prov-${dndIdCounter++}`,
            provider: p,
        }));
    }

    async function handleSave(): Promise<void> {
        if (saving) return;
        if (!name.trim()) {
            toasts.error('Library name is required');
            return;
        }
        saving = true;
        let saved = false;
        try {
            // No `Record<string, unknown>` annotation: it discards the literal
            // type that createLibraryGroup/updateLibraryGroup require.
            const body = {
                name: name.trim(),
                description: description.trim() || null,
                icon: icon.trim() || null,
                sort_order: Number.isFinite(sortOrder) ? sortOrder : 0,
                max_age_rating: maxAgeRating,
                metadata_provider_chain: useGlobalChain ? null : providerChain,
            };

            const { error } = isEdit
                ? await updateLibraryGroup(
                      requireValue(group, 'group must exist in edit mode').id,
                      body,
                  )
                : await createLibraryGroup(body);

            if (error) {
                toasts.error(error);
            } else {
                saved = true;
                toasts.success(isEdit ? 'Library updated' : 'Library created');
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, 'Failed to save group'));
        } finally {
            saving = false;
        }
        // Outside the try: a throw from the caller's refresh used to show
        // "Failed to save group" after a save that succeeded, inviting a
        // retry that created a duplicate library.
        if (saved) {
            await modals.close();
            onSaved(isEdit ? 'updated' : 'created');
        }
    }

    async function handleClose(): Promise<void> {
        await modals.close();
    }
</script>

<div class="card card-glass p-6 w-full max-w-2xl shadow-xl">
    <header class="flex items-center justify-between mb-5">
        <h2 class="text-xl font-semibold text-white">
            {isEdit ? 'Edit library' : 'New empty library'}
        </h2>
        <button
            type="button"
            class="btn btn-ghost btn-sm btn-square"
            onclick={handleClose}
            aria-label="Close">
            <Icon src={XMark} class="w-5 h-5" />
        </button>
    </header>

    <div class="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="group-name">
                    {m.playlist_name()} <span class="text-red-400">*</span>
                </label>
                <input
                    id="group-name"
                    type="text"
                    class="input w-full"
                    placeholder="Movies, TV Shows, Music..."
                    bind:value={name} />
            </div>
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="group-icon">
                    Icon
                    <span class="text-surface-500 text-xs font-normal ml-1">(optional emoji)</span>
                </label>
                <!-- The placeholder spells out "none": a bare emoji placeholder renders
                     in full colour and reads as an icon that is already set. -->
                <input
                    id="group-icon"
                    type="text"
                    class="input w-full"
                    placeholder="None, e.g. &#x1F3AC;"
                    bind:value={icon} />
            </div>
            <div class="sm:col-span-2">
                <label class="block text-sm text-surface-400 mb-1" for="group-description">
                    {m.modal_description_aria()}
                </label>
                <input
                    id="group-description"
                    type="text"
                    class="input w-full"
                    placeholder="Optional description..."
                    bind:value={description} />
            </div>
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="group-sort-order">
                    Sort Order
                </label>
                <input
                    id="group-sort-order"
                    type="number"
                    class="input w-full"
                    bind:value={sortOrder} />
            </div>
            <div>
                <label class="block text-sm text-surface-400 mb-1" for="group-age-rating">
                    Max Age Rating
                    <span class="text-surface-500 text-xs font-normal ml-1">(optional)</span>
                </label>
                <input
                    id="group-age-rating"
                    type="number"
                    min="0"
                    max="21"
                    class="input w-full"
                    placeholder="No restriction"
                    value={maxAgeRating ?? ''}
                    oninput={(e) => {
                        const val = e.currentTarget.value;
                        const parsed = parseInt(val, 10);
                        maxAgeRating = val === '' || isNaN(parsed) ? null : parsed;
                    }} />
                <p class="text-xs text-surface-500 mt-1">
                    Users below this age don't see this library. Audiobooks in it count as at least
                    this age. Movies and series keep their own age rating. Leave empty for no restriction.
                </p>
            </div>
        </div>

        <!-- Metadata Provider Chain -->
        <div class="space-y-3 border-t border-surface-700 pt-4">
            <h4 class="text-sm font-semibold text-surface-300">Metadata Provider Priority</h4>

            <label class="flex items-center gap-2">
                <input
                    type="checkbox"
                    class="checkbox"
                    checked={useGlobalChain}
                    onchange={() => {
                        useGlobalChain = !useGlobalChain;
                        if (!useGlobalChain && !providerChain) {
                            providerChain = ['tmdb', 'mdblist'];
                        }
                        syncChainDndItems();
                    }} />
                <span class="text-sm text-surface-400">Use global default</span>
            </label>

            {#if !useGlobalChain && providerChain}
                <div
                    class="space-y-1"
                    use:dndzone={{
                        items: chainDndItems,
                        flipDurationMs: 200,
                        dropTargetStyle: {
                            outline: '2px dashed rgb(var(--color-primary-500-rgb) / 0.5)',
                        },
                    }}
                    onconsider={(
                        e: CustomEvent<{
                            items: Array<{ id: string; provider: string }>;
                        }>,
                    ) => {
                        chainDndItems = e.detail.items;
                    }}
                    onfinalize={(
                        e: CustomEvent<{
                            items: Array<{ id: string; provider: string }>;
                        }>,
                    ) => {
                        chainDndItems = e.detail.items;
                        providerChain = e.detail.items.map((item) => item.provider);
                    }}>
                    {#each chainDndItems as item (item.id)}
                        <div
                            class="flex items-center gap-2 p-2 rounded bg-surface-700 cursor-grab"
                            animate:flip={{ duration: 200 }}>
                            <span class="text-surface-400">&#x2630;</span>
                            <span class="text-sm flex-1 text-white">{item.provider}</span>
                            <button
                                type="button"
                                class="btn btn-sm text-red-400 hover:text-red-300 p-1"
                                onclick={() => {
                                    providerChain =
                                        providerChain?.filter((p) => p !== item.provider) ?? null;
                                    syncChainDndItems();
                                }}>
                                &times;
                            </button>
                        </div>
                    {/each}
                </div>

                {#if unusedProviders.length > 0}
                    <select
                        class="select select-sm w-full"
                        onchange={(e) => {
                            const value = e.currentTarget.value;
                            if (value && providerChain) {
                                providerChain = [...providerChain, value];
                                syncChainDndItems();
                                e.currentTarget.value = '';
                            }
                        }}>
                        <option value="">Add provider...</option>
                        {#each unusedProviders as p (p)}
                            <option value={p}>{p}</option>
                        {/each}
                    </select>
                {/if}

                <p class="text-xs text-surface-500">
                    Drag to reorder. Higher = tried first. "aggregated" is always prepended
                    automatically.
                </p>
            {/if}
        </div>
    </div>

    <footer class="flex justify-end gap-3 mt-5 pt-4 border-t border-surface-700">
        <button type="button" class="btn btn-ghost" onclick={handleClose} disabled={saving}>
            {m.cancel()}
        </button>
        <button
            type="button"
            class="btn btn-blue"
            onclick={() => void handleSave()}
            disabled={saving}>
            {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
        </button>
    </footer>
</div>
