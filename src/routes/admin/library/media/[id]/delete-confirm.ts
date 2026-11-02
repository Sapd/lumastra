// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the typed delete confirmation in the media detail's delete dialog
 * expects the operator to type, and whether what they typed matches.
 *
 * Lives in a sibling module rather than in `+page.svelte` for the reason
 * `detail-actions.ts` does: a rule buried in a component cannot be
 * unit-tested.
 *
 * A season's raw `title` can be the empty string (`''`, not `null` — the
 * header falls back to displaying "Season N" for those, but the underlying
 * value the dialog compares against stays `''`). Matching the confirmation
 * input against that raw title directly would make `''.trim() === ''` true
 * before the operator types anything, so Delete would be enabled the instant
 * the dialog opens on exactly the items most likely to be deleted by
 * accident. When the raw title is empty this falls back to a fixed word
 * instead, so the guard always requires a deliberate act.
 */

/** What the operator must type when the item's raw title is empty. */
export const EMPTY_TITLE_DELETE_CONFIRM_WORD = 'DELETE';

/** The exact string the confirmation input must equal to unlock Delete. */
export function deleteConfirmExpectedValue(rawTitle: string): string {
    const trimmed = rawTitle.trim();
    return trimmed.length > 0 ? trimmed : EMPTY_TITLE_DELETE_CONFIRM_WORD;
}

/** Whether the operator's typed input satisfies the delete confirmation. */
export function isDeleteConfirmed(input: string, rawTitle: string): boolean {
    return input.trim() === deleteConfirmExpectedValue(rawTitle);
}
