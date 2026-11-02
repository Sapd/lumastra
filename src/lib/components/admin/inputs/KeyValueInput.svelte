<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, Plus, Trash } from 'svelte-hero-icons';
    import type { BaseInputProps } from './registry';

    interface Props extends BaseInputProps {}

    let { setting, value, disabled = false, envLocked = false, onchange }: Props = $props();

    // Effective disabled state
    let isDisabled = $derived(disabled || envLocked || setting.uiHints?.envOnly);

    interface Pair {
        key: string;
        value: string;
    }

    // Normalize an incoming value (a Record<string, unknown>) into an editable list of pairs.
    function toPairs(val: unknown): Pair[] {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            return Object.entries(val as Record<string, unknown>).map(([key, v]) => ({
                key,
                value: v == null ? '' : String(v),
            }));
        }
        return [];
    }

    // Editable working copy, seeded once from the initial value. This component is the
    // edit surface for the map: it owns the pair list (which can hold blank/in-progress
    // keys) and emits a normalized Record back to the parent on every change. The parent
    // re-renders a fresh instance on settings reload, so no prop re-sync effect is needed.
    // svelte-ignore state_referenced_locally
    let pairs = $state<Pair[]>(toPairs(value));

    // Build a Record from the current pairs (last write wins on duplicate keys; blank keys dropped).
    function emit(next: Pair[]): void {
        const record: Record<string, string> = {};
        for (const { key, value: v } of next) {
            const trimmedKey = key.trim();
            if (trimmedKey.length > 0) {
                record[trimmedKey] = v;
            }
        }
        onchange?.(record);
    }

    function updateKey(index: number, key: string): void {
        pairs[index] = { ...pairs[index], key };
        emit(pairs);
    }

    function updateValue(index: number, v: string): void {
        pairs[index] = { ...pairs[index], value: v };
        emit(pairs);
    }

    function addPair(): void {
        pairs = [...pairs, { key: '', value: '' }];
    }

    function removePair(index: number): void {
        pairs = pairs.filter((_, i) => i !== index);
        emit(pairs);
    }
</script>

<!-- Key/Value Map Input -->
<div class="space-y-2">
    {#each pairs as pair, index (index)}
        <div class="flex items-center gap-2">
            <input
                type="text"
                class="input input-sm flex-1
                    {isDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
                disabled={isDisabled}
                value={pair.key}
                placeholder="key"
                aria-label="Key"
                oninput={(e) => updateKey(index, (e.target as HTMLInputElement).value)} />
            <input
                type="text"
                class="input input-sm flex-1
                    {isDisabled ? 'opacity-50 cursor-not-allowed' : ''}"
                disabled={isDisabled}
                value={pair.value}
                placeholder={setting.uiHints?.placeholder || 'value'}
                aria-label="Value"
                oninput={(e) => updateValue(index, (e.target as HTMLInputElement).value)} />
            <button
                type="button"
                class="btn btn-ghost btn-sm btn-square"
                disabled={isDisabled}
                aria-label="Remove entry"
                onclick={() => removePair(index)}>
                <Icon src={Trash} class="w-4 h-4" />
            </button>
        </div>
    {/each}

    <button
        type="button"
        class="btn btn-ghost btn-sm gap-1"
        disabled={isDisabled}
        onclick={addPair}>
        <Icon src={Plus} class="w-4 h-4" />
        Add entry
    </button>
</div>
