// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { attentionActionKey, type AttentionActionKeyParts } from './attention-action-key.js';

/** The exact actions `adaptScanRun` emits — the ones that broke the board. */
const SCAN_RUN_ACTIONS: AttentionActionKeyParts[] = [
    { kind: 'investigate', label: 'View recent items', href: '/admin/library/media?addedSince=x' },
    { kind: 'investigate', label: 'Fix matches', href: '/admin/library/fix-matches' },
    { kind: 'investigate', label: 'View scan history', href: '/admin/library/sources' },
];

function keysOf(actions: AttentionActionKeyParts[]): string[] {
    return actions.map(attentionActionKey);
}

describe('attentionActionKey', () => {
    it('separates same-kind actions that differ only by href', () => {
        const keys = keysOf(SCAN_RUN_ACTIONS);
        expect(new Set(keys).size).toBe(SCAN_RUN_ACTIONS.length);

        // The old key was kind + the four scope ids. Shown explicitly, because
        // the whole failure is that this looks sufficient and is not: all three
        // scan-run actions carry no scope ids at all.
        const oldKey = (a: AttentionActionKeyParts) =>
            a.kind + (a.taskId ?? '') + (a.runId ?? '') + (a.itemId ?? '') + (a.stageId ?? '');
        expect(new Set(SCAN_RUN_ACTIONS.map(oldKey)).size).toBe(1);
    });

    it('separates actions that differ only by label', () => {
        const keys = keysOf([
            { kind: 'retry', label: 'Retry', href: '/x' },
            { kind: 'retry', label: 'Retry all', href: '/x' },
        ]);
        expect(new Set(keys).size).toBe(2);
    });

    it('still separates scoped actions of the same kind', () => {
        const keys = keysOf([
            { kind: 'bulk-retry', stageId: 'series-sync' },
            { kind: 'bulk-retry', stageId: 'image-sync' },
        ]);
        expect(new Set(keys).size).toBe(2);
    });

    it('does not let adjacent fields blur into each other', () => {
        // Bare concatenation would make both of these 'abc'.
        expect(attentionActionKey({ kind: 'a', href: 'bc' })).not.toBe(
            attentionActionKey({ kind: 'ab', href: 'c' }),
        );
    });

    it('is stable for the same action', () => {
        const a: AttentionActionKeyParts = { kind: 'investigate', label: 'L', href: '/h' };
        expect(attentionActionKey(a)).toBe(attentionActionKey({ ...a }));
    });

    it('treats a genuinely identical action as identical', () => {
        // Same words, same destination, no scope — the one case that SHOULD collide,
        // so a duplicate emitted by a producer is still surfaced rather than hidden.
        expect(
            new Set(
                keysOf([
                    { kind: 'investigate', label: 'View', href: '/h' },
                    { kind: 'investigate', label: 'View', href: '/h' },
                ]),
            ).size,
        ).toBe(1);
    });
});
