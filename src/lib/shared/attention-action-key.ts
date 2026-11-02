// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The keyed-`{#each}` key for an attention item's action buttons.
 *
 * Pure and dependency-free (types only), the same shape as
 * `attention-health-files-panel.ts`, and for the same reason: a `.svelte` file's
 * inline `{#each ... (key)}` expression is invisible to `npm run typecheck`
 * (tsgo skips `.svelte`) and to every server test, so the rule it encodes can
 * only be tested if it lives here.
 *
 * ## Why `href` and `label` are in the key
 *
 * The key used to be `kind + taskId + runId + itemId + stageId` — the action's
 * "scope" fields. That assumes two actions on one item always differ by kind or
 * by scope. They do not: `adaptScanRun` emits THREE actions of kind
 * `investigate` — recent items, fix-matches, scan history — carrying no scope
 * fields at all, because what separates them is where they link. All three
 * therefore produced the key `"investigate"`, and Svelte threw
 * `each_key_duplicate`.
 *
 * That is not a cosmetic failure. `AttentionItemRow` renders inside the admin
 * layout, so the throw took down the render of every admin page that showed the
 * board, not just the panel that owned the item.
 *
 * The general rule: an action's identity is everything a user can tell apart.
 * Two buttons with the same words pointing at the same place are the same
 * button; anything else is a distinct one and needs a distinct key.
 */

/** The fields of an attention action that contribute to its identity. */
export interface AttentionActionKeyParts {
    kind: string;
    label?: string;
    href?: string;
    taskId?: string;
    runId?: string;
    itemId?: string;
    stageId?: string;
}

/**
 * Stable per-action key, unique within one item's `actions[]`.
 *
 * Fields are joined with `|` rather than concatenated: bare concatenation lets
 * adjacent fields blur together, so `{kind:'a', href:'bc'}` and
 * `{kind:'ab', href:'c'}` would collide.
 */
export function attentionActionKey(a: AttentionActionKeyParts): string {
    return [
        a.kind,
        a.href ?? '',
        a.label ?? '',
        a.taskId ?? '',
        a.runId ?? '',
        a.itemId ?? '',
        a.stageId ?? '',
    ].join('|');
}
