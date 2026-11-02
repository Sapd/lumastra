// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('$lib/stores/modal.store', () => ({ modals: { close: vi.fn() } }));
import ConfirmModal from './ConfirmModal.svelte';
afterEach(cleanup);

describe('long reviewed decision confirmation', () => {
    it('mounts the real scrollable body without truncating any of 1000 exact identities or titles', async () => {
        const lines = Array.from(
            { length: 1000 },
            (_, i) =>
                `${String(i).padStart(8, '0')}-1234-4234-8234-123456789abc · Current title ${i} → Proposed title ${i} · TMDB ${870000 + i} → ${880000 + i}`,
        );
        const onConfirm = vi.fn();
        const { container } = render(ConfirmModal, {
            title: 'Review 1000 decisions',
            body: lines.join('\n'),
            scrollBody: true,
            confirmText: 'Accept reviewed decisions',
            cancelText: 'Cancel',
            onConfirm,
        });
        expect(screen.queryByRole('button', { name: 'Jump to actions' })).toBeNull();
        const body = container.querySelector('article')!;
        expect(container.querySelector('#confirm-modal-desc')?.textContent).toBe(lines.join('\n'));
        expect(body.classList.contains('scroll-body')).toBe(true);
        expect(body.tabIndex).toBe(0);
        body.focus();
        expect(document.activeElement).toBe(body);
        const cancel = screen.getByRole('button', { name: 'Cancel' });
        const confirm = screen.getByRole('button', { name: 'Accept reviewed decisions' });
        expect(body.contains(cancel)).toBe(false);
        expect(body.contains(confirm)).toBe(false);
        confirm.focus();
        expect(document.activeElement).toBe(confirm);
        await fireEvent.click(confirm);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });
    it('renders escaped canonical inspection links in the keyboard-accessible review region', () => {
        const id = '12345678-1234-4234-8234-123456789abc';
        const { container } = render(ConfirmModal, {
            body: 'Review',
            scrollBody: true,
            onConfirm: vi.fn(),
            reviewLinks: [
                { href: `/admin/library/media/${id}`, label: 'Inspect <script>example</script>' },
            ],
        });
        const link = screen.getByRole('link', { name: 'Inspect <script>example</script>' });
        expect(link.getAttribute('href')).toBe(`/admin/library/media/${id}`);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(container.querySelector('article')?.contains(link)).toBe(true);
        expect(container.querySelector('script')).toBeNull();
        link.focus();
        expect(document.activeElement).toBe(link);
    });
    it('jumps from a localized keyboard action past 1000 inspection links to the existing footer', async () => {
        const links = Array.from({ length: 1000 }, (_, i) => ({
            href: `/admin/library/media/${i}`,
            label: `Inspect ${i}`,
        }));
        const { container } = render(ConfirmModal, {
            body: 'Review',
            scrollBody: true,
            reviewLinks: links,
            onConfirm: vi.fn(),
        });
        expect(screen.getAllByRole('link')).toHaveLength(1000);
        const jump = screen.getByRole('button', { name: 'Jump to actions' });
        jump.focus();
        expect(document.activeElement).toBe(jump);
        await fireEvent.click(jump); // native keyboard activation dispatches this same click
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
        expect(container.querySelector('article')?.contains(jump)).toBe(false);
    });
});
