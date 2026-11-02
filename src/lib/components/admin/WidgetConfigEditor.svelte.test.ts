// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The widget list was built from `widgetOrder` once. Discarding a dragged
 * order reverted the form's value while the list kept showing the drag, so the
 * next unrelated change saved an order the screen had shown as discarded.
 */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api/client.js', () => ({ apiPost: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import WidgetConfigEditor from './WidgetConfigEditor.svelte';

afterEach(cleanup);

function shownOrder(ids: string[]): string[] {
    const labels: Record<string, string> = {
        'watch-parties': 'Watch Parties',
        'streaming-sessions': 'Streaming Sessions',
        'for-you': 'For You',
    };
    const nodes = ids.map((id) => screen.getByText(labels[id]));
    return [...nodes]
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map((n) => Object.keys(labels).find((k) => labels[k] === n.textContent?.trim())!);
}

describe('WidgetConfigEditor', () => {
    it('follows an order change from the parent (Discard)', async () => {
        const ids = ['for-you', 'watch-parties', 'streaming-sessions'];
        const { rerender } = render(WidgetConfigEditor, { widgetOrder: ids });
        expect(shownOrder(ids)).toEqual(ids);

        const reverted = ['streaming-sessions', 'for-you', 'watch-parties'];
        await rerender({ widgetOrder: reverted });
        expect(shownOrder(ids)).toEqual(reverted);
    });
});
