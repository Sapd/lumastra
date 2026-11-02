// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Global shortcut registry using Svelte 5 runes
 * Pages register shortcuts on mount and deregister on destroy.
 */

import { untrack } from 'svelte';

export interface ShortcutEntry {
    keys: string[];
    description: string;
}

export interface ShortcutGroup {
    label: string;
    entries: ShortcutEntry[];
}

let groups = $state<ShortcutGroup[]>([]);

export const shortcuts = {
    register(group: ShortcutGroup): () => void {
        // `register`/teardown are called from callers' `$effect`s (e.g. the
        // admin/media page registers inside an effect whose label/entries come
        // from reactive i18n messages). Reading + writing `groups` directly
        // would make that effect depend on `groups` and re-trigger itself —
        // an infinite read/write loop (`effect_update_depth_exceeded`), and the
        // churn left two same-label groups in the array, which the help modal's
        // label-keyed `{#each}` rejects with `each_key_duplicate`. `untrack`
        // keeps these mutations from creating that dependency. The modal reads
        // `groups` through its own effect, so it still updates reactively.
        untrack(() => {
            // Replace any existing group with the same label so a locale-driven
            // re-register stays idempotent (one group per label).
            groups = [...groups.filter((g) => g.label !== group.label), group];
        });
        return () => {
            untrack(() => {
                groups = groups.filter((g) => g !== group);
            });
        };
    },
    get groups() {
        return groups;
    },
};
