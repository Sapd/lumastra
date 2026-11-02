// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Round trip of the ingest → reconcile skip marker against a real Valkey:
 * recorded paths are listed inside the window and drop out after it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { requireClient } from '../../valkey-types.js';
import {
    SKIP_WINDOW_MS,
    listRecentReconcileSkips,
    reconcileSkipKey,
    recordReconcileSkips,
} from './file-reconcile-skips.js';

const LIB = `skips-test-${crypto.randomUUID()}`;

describe('file-reconcile skip marker (real Valkey)', () => {
    beforeAll(async () => {
        await connectValkey();
    });

    afterAll(async () => {
        await requireClient().customCommand(['DEL', reconcileSkipKey(LIB)]);
        await disconnectValkey();
    });

    beforeEach(async () => {
        await requireClient().customCommand(['DEL', reconcileSkipKey(LIB)]);
    });

    it('lists a recorded path within the window, per library path', async () => {
        await recordReconcileSkips(LIB, ['Show/S11/dup.mp4']);

        expect([...(await listRecentReconcileSkips(LIB))]).toEqual(['Show/S11/dup.mp4']);
        expect((await listRecentReconcileSkips(`${LIB}-other`)).size).toBe(0);
    });

    it('a skip older than the window is no longer listed, so the file is re-evaluated', async () => {
        const now = Date.now();
        await recordReconcileSkips(LIB, ['old.mp4'], now - SKIP_WINDOW_MS - 60_000);
        await recordReconcileSkips(LIB, ['new.mp4'], now);

        expect([...(await listRecentReconcileSkips(LIB, now))]).toEqual(['new.mp4']);
    });

    it('re-recording refreshes the timestamp instead of duplicating', async () => {
        const now = Date.now();
        await recordReconcileSkips(LIB, ['dup.mp4'], now - 1000);
        await recordReconcileSkips(LIB, ['dup.mp4'], now);

        const card = await requireClient().customCommand(['ZCARD', reconcileSkipKey(LIB)]);
        expect(Number(card)).toBe(1);
    });
});
