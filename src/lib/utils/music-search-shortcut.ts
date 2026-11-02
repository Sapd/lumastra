// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyboard shortcut that focuses the music search input on /music and
 * /music/search: ⌘F / Ctrl+F, or a bare '/'.
 *
 * ⌘F is taken over only while focus is NOT already in a text field — so a
 * second ⌘F from inside the search box (or any other input) still opens the
 * browser's native find-in-page. Skipped while a modal dialog is open and
 * when the input is not rendered (the home-page input is desktop-only).
 */
export function handleMusicSearchShortcut(
    e: KeyboardEvent,
    input: HTMLInputElement | undefined,
): void {
    if (!input || e.defaultPrevented || e.isComposing || e.altKey) return;
    const isFind = (e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === 'f' || e.key === 'F');
    const isSlash = e.key === '/' && !e.metaKey && !e.ctrlKey;
    if (!isFind && !isSlash) return;
    if (isEditableTarget(e.target)) return;
    if (input.getClientRects().length === 0) return;
    if (document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]')) return;
    e.preventDefault();
    input.focus();
    input.select();
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
        target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
    );
}

/** Platform-appropriate label for the hint badge inside the search input. */
export function musicSearchShortcutLabel(): string {
    if (typeof navigator === 'undefined') return 'Ctrl F';
    const platform =
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
            ?.platform ?? navigator.platform;
    return /mac|iphone|ipad/i.test(platform) ? '⌘F' : 'Ctrl F';
}
