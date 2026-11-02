// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { createHoldToAct, type HoldToActHandlers } from './hold-to-act';

/** Mock target with a spyable (optionally throwing) releasePointerCapture. */
function mockTarget(opts: { throws?: boolean } = {}): EventTarget & {
    releasePointerCapture: ReturnType<typeof vi.fn>;
} {
    return {
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        releasePointerCapture: vi.fn(() => {
            if (opts.throws) throw new Error('not captured');
        }),
    };
}

function pointerEvent(overrides: Partial<PointerEvent> & { target?: unknown } = {}): PointerEvent {
    return {
        isPrimary: true,
        pointerType: 'touch',
        button: 0,
        pointerId: 1,
        target: mockTarget(),
        preventDefault: vi.fn(),
        ...overrides,
    } as unknown as PointerEvent;
}

function clickEvent(detail: number): MouseEvent {
    return { detail, preventDefault: vi.fn() } as unknown as MouseEvent;
}

describe('createHoldToAct', () => {
    let onTap: Mock<() => void>;
    let onHoldCommit: Mock<() => void>;
    let onHoldStart: Mock<() => void>;
    let onHoldCancel: Mock<() => void>;
    let onHoldEnd: Mock<() => void>;
    let gesture: HoldToActHandlers;

    beforeEach(() => {
        vi.useFakeTimers();
        onTap = vi.fn<() => void>(() => {});
        onHoldCommit = vi.fn<() => void>(() => {});
        onHoldStart = vi.fn<() => void>(() => {});
        onHoldCancel = vi.fn<() => void>(() => {});
        onHoldEnd = vi.fn<() => void>(() => {});
        gesture = createHoldToAct({
            thresholdMs: 600,
            onTap,
            onHoldCommit,
            onHoldStart,
            onHoldCancel,
            onHoldEnd,
        });
    });

    afterEach(() => {
        gesture.destroy();
        vi.useRealTimers();
    });

    it('release before the threshold is a tap', () => {
        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(300);
        gesture.handlePointerUp(pointerEvent());
        expect(onTap).toHaveBeenCalledTimes(1);
        expect(onHoldCommit).not.toHaveBeenCalled();
        expect(onHoldStart).toHaveBeenCalledTimes(1);
    });

    it('commits at the threshold even while still held; the later release does nothing', () => {
        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(600);
        expect(onHoldCommit).toHaveBeenCalledTimes(1);
        gesture.handlePointerUp(pointerEvent());
        expect(onTap).not.toHaveBeenCalled();
        expect(onHoldCommit).toHaveBeenCalledTimes(1);
        expect(onHoldCancel).not.toHaveBeenCalled();
    });

    it('pointer leaving before the threshold cancels — no tap, no commit', () => {
        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(300);
        gesture.handlePointerCancel(pointerEvent());
        vi.advanceTimersByTime(600);
        gesture.handlePointerUp(pointerEvent());
        expect(onTap).not.toHaveBeenCalled();
        expect(onHoldCommit).not.toHaveBeenCalled();
        expect(onHoldCancel).toHaveBeenCalledTimes(1);
    });

    it('keyboard activation (click with detail 0) is a tap', () => {
        gesture.handleClick(clickEvent(0));
        expect(onTap).toHaveBeenCalledTimes(1);
    });

    it('pointer-synthesized click (detail 1) is swallowed — no double fire', () => {
        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(100);
        gesture.handlePointerUp(pointerEvent());
        gesture.handleClick(clickEvent(1));
        expect(onTap).toHaveBeenCalledTimes(1); // from pointerup only
    });

    it('suppresses contextmenu during the hold (touch long-press menu)', () => {
        gesture.handlePointerDown(pointerEvent());
        const ctx = { preventDefault: vi.fn() } as unknown as Event;
        gesture.handleContextMenu(ctx);
        expect(ctx.preventDefault).toHaveBeenCalled();
    });

    it('does not suppress contextmenu when idle', () => {
        const ctx = { preventDefault: vi.fn() } as unknown as Event;
        gesture.handleContextMenu(ctx);
        expect(ctx.preventDefault).not.toHaveBeenCalled();
    });

    it('ignores non-primary pointers and secondary mouse buttons', () => {
        gesture.handlePointerDown(pointerEvent({ isPrimary: false }));
        vi.advanceTimersByTime(600);
        expect(onHoldCommit).not.toHaveBeenCalled();
        gesture.handlePointerDown(pointerEvent({ pointerType: 'mouse', button: 2 }));
        vi.advanceTimersByTime(600);
        expect(onHoldCommit).not.toHaveBeenCalled();
    });

    it('a second press after a commit works fresh', () => {
        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(600);
        gesture.handlePointerUp(pointerEvent());
        expect(onHoldCommit).toHaveBeenCalledTimes(1);

        gesture.handlePointerDown(pointerEvent());
        vi.advanceTimersByTime(200);
        gesture.handlePointerUp(pointerEvent());
        expect(onTap).toHaveBeenCalledTimes(1);
        expect(onHoldCommit).toHaveBeenCalledTimes(1);
    });

    it('destroy() clears a pending hold timer', () => {
        gesture.handlePointerDown(pointerEvent());
        gesture.destroy();
        vi.advanceTimersByTime(600);
        expect(onHoldCommit).not.toHaveBeenCalled();
    });

    describe('onHoldEnd', () => {
        it('fires exactly once on a tap (after onTap)', () => {
            gesture.handlePointerDown(pointerEvent());
            vi.advanceTimersByTime(300);
            gesture.handlePointerUp(pointerEvent());
            expect(onTap).toHaveBeenCalledTimes(1);
            expect(onHoldEnd).toHaveBeenCalledTimes(1);
        });

        it('fires exactly once on a hold-commit at the threshold (after onHoldCommit)', () => {
            gesture.handlePointerDown(pointerEvent());
            vi.advanceTimersByTime(600);
            expect(onHoldCommit).toHaveBeenCalledTimes(1);
            expect(onHoldEnd).toHaveBeenCalledTimes(1);
            // The later release is inert and must not fire onHoldEnd again.
            gesture.handlePointerUp(pointerEvent());
            expect(onHoldEnd).toHaveBeenCalledTimes(1);
        });

        it('fires exactly once on a drag-away cancel (after onHoldCancel)', () => {
            gesture.handlePointerDown(pointerEvent());
            vi.advanceTimersByTime(300);
            gesture.handlePointerCancel(pointerEvent());
            expect(onHoldCancel).toHaveBeenCalledTimes(1);
            expect(onHoldEnd).toHaveBeenCalledTimes(1);
        });

        it('does NOT fire on keyboard click (detail 0)', () => {
            gesture.handleClick(clickEvent(0));
            expect(onTap).toHaveBeenCalledTimes(1);
            expect(onHoldEnd).not.toHaveBeenCalled();
        });

        it('does NOT fire on destroy()', () => {
            gesture.handlePointerDown(pointerEvent());
            gesture.destroy();
            expect(onHoldEnd).not.toHaveBeenCalled();
        });
    });

    describe('touch implicit pointer-capture release (drag-away cancel fix)', () => {
        it('releases implicit pointer capture on pointerdown for touch', () => {
            const target = mockTarget();
            gesture.handlePointerDown(pointerEvent({ pointerType: 'touch', target, pointerId: 7 }));
            expect(target.releasePointerCapture).toHaveBeenCalledTimes(1);
            expect(target.releasePointerCapture).toHaveBeenCalledWith(7);
        });

        it('releases implicit pointer capture on pointerdown for pen', () => {
            const target = mockTarget();
            gesture.handlePointerDown(pointerEvent({ pointerType: 'pen', target }));
            expect(target.releasePointerCapture).toHaveBeenCalledTimes(1);
        });

        it('does NOT release pointer capture for mouse', () => {
            const target = mockTarget();
            gesture.handlePointerDown(pointerEvent({ pointerType: 'mouse', button: 0, target }));
            expect(target.releasePointerCapture).not.toHaveBeenCalled();
        });

        it('a throwing releasePointerCapture does not break the hold flow', () => {
            const target = mockTarget({ throws: true });
            expect(() =>
                gesture.handlePointerDown(pointerEvent({ pointerType: 'touch', target })),
            ).not.toThrow();
            vi.advanceTimersByTime(600);
            expect(onHoldCommit).toHaveBeenCalledTimes(1);
        });
    });
});
