// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Input-based user-idle signal for surfaces that generate server work on a
 * timer (the home hero's rotating previews). `document.hidden` only covers a
 * hidden tab; a visible window nobody is looking at never flips it — prod
 * 2026-09-25 had one such tab rotate the hero for 30 hours (5,995 preview
 * sessions). Calls `onChange(true)` after `idleMs` without input and
 * `onChange(false)` on the next input. Returns a cleanup function.
 */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

export function watchUserIdle(idleMs: number, onChange: (idle: boolean) => void): () => void {
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            idle = true;
            onChange(true);
        }, idleMs);
    };
    const onActivity = () => {
        if (idle) {
            idle = false;
            onChange(false);
        }
        arm();
    };

    for (const type of ACTIVITY_EVENTS) {
        window.addEventListener(type, onActivity, { passive: true, capture: true });
    }
    arm();

    return () => {
        if (timer) clearTimeout(timer);
        timer = null;
        for (const type of ACTIVITY_EVENTS) {
            window.removeEventListener(type, onActivity, { capture: true });
        }
    };
}
