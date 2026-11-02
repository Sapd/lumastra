// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Fit the fixed popup inside the visible player, above its playback controls. */
export function fitTrackMenu(node: HTMLElement): { destroy: () => void } {
    const player = node.closest<HTMLElement>('.player-container');
    const controls = node.closest<HTMLElement>('.controls-container');
    const viewport = window.visualViewport;

    function fit(): void {
        const viewportTop = viewport?.offsetTop ?? 0;
        const viewportLeft = viewport?.offsetLeft ?? 0;
        const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
        const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
        const bounds = player?.getBoundingClientRect();
        let top = Math.max(viewportTop, bounds?.top ?? viewportTop) + 24;
        const bottom = Math.min(viewportBottom, bounds?.bottom ?? viewportBottom);
        let menuBottom =
            Math.min(bottom - 16, controls?.getBoundingClientRect().top ?? bottom - 80) - 8;
        let left = Math.max(viewportLeft, bounds?.left ?? viewportLeft) + 16;
        let right = Math.min(viewportRight, bounds?.right ?? viewportRight) - 16;

        // The watch-party avatars sit above playback menus. Leave their
        // occupied corner clear so they cannot intercept the Close button.
        const avatars = player?.querySelector<HTMLElement>('.cluster-wrapper');
        const avatarBounds = avatars?.getBoundingClientRect();
        function clearAvatars(): void {
            if (
                avatarBounds &&
                avatarBounds.height > 0 &&
                avatarBounds.left < right &&
                avatarBounds.right > right - Math.min(380, right - left) &&
                avatarBounds.bottom > top &&
                avatarBounds.top < menuBottom
            ) {
                top = avatarBounds.bottom + 8;
            }
        }
        clearAvatars();

        const box = getComputedStyle(node);
        let minimumHeight =
            96 +
            parseFloat(box.paddingTop) +
            parseFloat(box.paddingBottom) +
            parseFloat(box.borderTopWidth) +
            parseFloat(box.borderBottomWidth);
        for (const child of Array.from(node.children)) {
            if (
                !(child instanceof HTMLElement) ||
                child.matches('.track-content, .style-panel-container')
            )
                continue;
            const style = getComputedStyle(child);
            if (style.display === 'none') continue;
            minimumHeight +=
                child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        }

        // Reserve a full row and its heading below the fixed chrome. Short
        // screens and tiny embedded players use the available viewport instead.
        if (menuBottom - top < minimumHeight || right - left < 240) {
            top = viewportTop + 24;
            menuBottom = viewportBottom - 24;
            left = viewportLeft + 16;
            right = viewportRight - 16;
            clearAvatars();
        }

        node.style.setProperty('--track-menu-bottom', `${window.innerHeight - menuBottom}px`);
        node.style.setProperty('--track-menu-right', `${window.innerWidth - right}px`);
        node.style.setProperty('--track-menu-max-width', `${Math.max(0, right - left)}px`);
        node.style.setProperty(
            '--track-menu-max-height',
            `${Math.max(0, Math.min(640, menuBottom - top))}px`,
        );
    }

    const observer = new ResizeObserver(fit);
    // Appearance and tracks have different fixed chrome. A viewport resize
    // while appearance is open must also be reconsidered when Back restores it.
    const mutations = new MutationObserver(fit);
    mutations.observe(node, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden'],
    });
    if (player) observer.observe(player);
    if (controls) observer.observe(controls);
    const avatars = player?.querySelector<HTMLElement>('.cluster-wrapper');
    if (avatars) observer.observe(avatars);
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    fit();

    return {
        destroy(): void {
            observer.disconnect();
            mutations.disconnect();
            window.removeEventListener('resize', fit);
            window.removeEventListener('scroll', fit, true);
            viewport?.removeEventListener('resize', fit);
            viewport?.removeEventListener('scroll', fit);
        },
    };
}
