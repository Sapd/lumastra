// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// happy-dom so the swipe-card action's disable-mid-drag notification can be
// exercised with real DOM events; the pure-math tests are environment-agnostic.
// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { swipeCard } from './swipe-card';
import { dragDirection, dragProgress, dragTransform, resolveCommit } from './swipe-math';

describe('dragDirection', () => {
    it('returns null in the dead zone (< 24px)', () => {
        expect(dragDirection(10, 5)).toBeNull();
    });

    it('picks the dominant horizontal axis', () => {
        expect(dragDirection(80, 20)).toBe('right');
    });

    it('picks the dominant vertical axis', () => {
        expect(dragDirection(-30, -100)).toBe('up');
    });

    it('picks left for a dominant negative horizontal drag', () => {
        expect(dragDirection(-80, 20)).toBe('left');
    });

    it('picks down for a dominant positive vertical drag', () => {
        expect(dragDirection(20, 80)).toBe('down');
    });
});

describe('dragProgress', () => {
    it('clamps to 0 at the origin', () => {
        expect(dragProgress(0, 0)).toBe(0);
    });

    it('clamps to 1 well past the swipe threshold', () => {
        expect(dragProgress(500, 0)).toBe(1);
    });

    it('stays within 0..1 partway through the drag', () => {
        const progress = dragProgress(45, 0);
        expect(progress).toBeGreaterThan(0);
        expect(progress).toBeLessThan(1);
    });
});

describe('resolveCommit', () => {
    it('commits on distance threshold alone', () => {
        expect(resolveCommit({ dx: 100, dy: 0, vx: 0, vy: 0 })).toBe('right');
    });

    it('commits on velocity threshold below the distance threshold', () => {
        expect(resolveCommit({ dx: 40, dy: 0, vx: 0.9, vy: 0 })).toBe('right');
    });

    it('springs back when neither threshold is met', () => {
        expect(resolveCommit({ dx: 40, dy: 0, vx: 0.1, vy: 0 })).toBeNull();
    });
});

describe('dragTransform', () => {
    it('produces a translate + rotate transform proportional to dx', () => {
        const transform = dragTransform(100, 20);
        expect(transform).toContain('translate(100px, 20px)');
        expect(transform).toContain('rotate(5deg)');
    });
});

describe('swipeCard action (DOM wiring)', () => {
    it('notifies the consumer (spring back + zeroed progress) when disabled mid-drag', () => {
        const node = document.createElement('div');
        document.body.appendChild(node);
        const params = {
            enabled: true,
            onprogress: vi.fn(),
            oncommit: vi.fn(),
            onrelease: vi.fn(),
        };
        const action = swipeCard(node, params);

        node.dispatchEvent(
            new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
        node.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 0 }),
        );
        expect(params.onprogress).toHaveBeenCalled();
        params.onprogress.mockClear();

        // Disabling mid-drag must tell the consumer to spring the card back —
        // otherwise it stays visually frozen at the last drag offset.
        action.update({ ...params, enabled: false });
        expect(params.onrelease).toHaveBeenCalledTimes(1);
        expect(params.onprogress).toHaveBeenCalledWith(null, 0, '');
        expect(params.oncommit).not.toHaveBeenCalled();

        // A second disable (no drag active) must not re-fire callbacks.
        params.onrelease.mockClear();
        action.update({ ...params, enabled: false });
        expect(params.onrelease).not.toHaveBeenCalled();

        action.destroy();
        node.remove();
    });

    it('pointercancel never commits — always aborts via reset + onrelease + zeroed onprogress', () => {
        const node = document.createElement('div');
        document.body.appendChild(node);
        const params = {
            enabled: true,
            onprogress: vi.fn(),
            oncommit: vi.fn(),
            onrelease: vi.fn(),
        };
        const action = swipeCard(node, params);

        node.dispatchEvent(
            new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
        // Drag far enough past the commit threshold — if pointercancel were
        // wired to the same resolveCommit path as pointerup, this would commit.
        node.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 0 }),
        );
        params.onprogress.mockClear();

        node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));

        expect(params.oncommit).not.toHaveBeenCalled();
        expect(params.onrelease).toHaveBeenCalledTimes(1);
        expect(params.onprogress).toHaveBeenCalledWith(null, 0, '');

        // A stray pointercancel for an unrelated pointer (not the active drag)
        // must not fire anything.
        params.onrelease.mockClear();
        node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 99 }));
        expect(params.onrelease).not.toHaveBeenCalled();

        action.destroy();
        node.remove();
    });

    it('lostpointercapture aborts the drag the same way pointercancel does', () => {
        const node = document.createElement('div');
        document.body.appendChild(node);
        const params = {
            enabled: true,
            onprogress: vi.fn(),
            oncommit: vi.fn(),
            onrelease: vi.fn(),
        };
        const action = swipeCard(node, params);

        node.dispatchEvent(
            new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
        node.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 0 }),
        );
        params.onprogress.mockClear();

        // Involuntary capture loss (e.g. the OS reassigns it) must not leave
        // the card frozen mid-transform — it aborts just like pointercancel.
        node.dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 }));

        expect(params.oncommit).not.toHaveBeenCalled();
        expect(params.onrelease).toHaveBeenCalledTimes(1);
        expect(params.onprogress).toHaveBeenCalledWith(null, 0, '');

        action.destroy();
        node.remove();
    });

    it('a second concurrent pointerdown mid-drag is ignored (does not hijack/reset the active drag)', () => {
        const node = document.createElement('div');
        document.body.appendChild(node);
        const params = {
            enabled: true,
            onprogress: vi.fn(),
            oncommit: vi.fn(),
            onrelease: vi.fn(),
        };
        const action = swipeCard(node, params);

        node.dispatchEvent(
            new PointerEvent('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
        node.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 60, clientY: 0 }),
        );
        params.onprogress.mockClear();

        // A second pointer goes down (e.g. a stray touch) while pointer 1 is
        // still dragging — must be a no-op, not a reset of the active drag.
        node.dispatchEvent(
            new PointerEvent('pointerdown', { pointerId: 2, clientX: 300, clientY: 300 }),
        );
        expect(params.onprogress).not.toHaveBeenCalled();
        expect(params.onrelease).not.toHaveBeenCalled();

        // Pointer 1's original drag is still live and can still commit normally.
        node.dispatchEvent(
            new PointerEvent('pointermove', { pointerId: 1, clientX: 150, clientY: 0 }),
        );
        expect(params.onprogress).toHaveBeenCalled();
        node.dispatchEvent(
            new PointerEvent('pointerup', { pointerId: 1, clientX: 150, clientY: 0 }),
        );
        expect(params.oncommit).toHaveBeenCalledWith('right');

        action.destroy();
        node.remove();
    });
});
