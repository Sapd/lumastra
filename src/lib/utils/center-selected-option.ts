// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Selector for the option a listbox-style dropdown currently has selected. */
const SELECTED_OPTION = '[role="option"][aria-selected="true"]';

/**
 * Scroll an open dropdown list so its selected option sits in the middle of
 * the visible band — a season browser opened on season 15 should not start at
 * season 1.
 *
 * Sets `scrollTop` on the list rather than calling `scrollIntoView`, which
 * would also scroll every scrollable ancestor (the modal or player behind the
 * dropdown). Callers whose list is positioned (`absolute`/`relative`) get
 * `offsetTop` relative to the list itself, which is what this math assumes;
 * the browser clamps an over-long target to the real scroll range.
 *
 * No-op when the list is not mounted or nothing is selected.
 */
export function centerSelectedOption(list: HTMLElement | undefined | null): void {
    const option = list?.querySelector<HTMLElement>(SELECTED_OPTION);
    if (!list || !option) return;
    list.scrollTop = Math.max(0, option.offsetTop - (list.clientHeight - option.offsetHeight) / 2);
}
