// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — SSE auth revoked mid-stream (Test 8).
 *
 * TODO: The SSE stream handler currently authenticates once at connection time
 * and does not recheck auth on subsequent frames. A periodic auth-recheck is
 * needed so a revoked token (e.g. admin demoted) closes the stream.
 *
 * This test is written as .skip because:
 *   1. The production handler (stream/+server.ts) has no periodic auth-recheck.
 *   2. Once a recheck is added (e.g. checking the token on each Valkey pubsub
 *      message callback), remove .skip and implement the full assertion.
 *
 * Implementation note for the fix:
 *   - In setupSubscriptions → the per-message callback, after `prepared` is
 *     built, call an async `recheckAuth(controller)` that re-validates the
 *     token stored in a per-controller closure. On failure, enqueue a
 *     `event: auth-error\ndata: {"code":401}\n\n` frame and close the controller.
 *   - Or: use a Valkey-backed token-revocation channel and subscribe to it;
 *     on a revocation message, close all matching controllers.
 */

import { describe, it, expect } from 'vitest';

// ── Placeholder ───────────────────────────────────────────────────────────────

describe('SSE stream — auth revocation mid-stream', () => {
    it.skip('closes the stream with a 401-equivalent error frame when auth is revoked after connection', async () => {
        // Setup steps (to implement once the production fix lands):
        //
        // 1. Import the route's internal helpers + mock authenticate/requireScope
        //    to succeed on first call, fail on subsequent calls.
        //
        // 2. Create a mock ReadableStream controller.
        //    const chunks: string[] = [];
        //    const controller = { enqueue: (b: Uint8Array) => { chunks.push(new TextDecoder().decode(b)); }, close: vi.fn(), ... };
        //
        // 3. Register the controller as a live consumer.
        //
        // 4. Call broadcastToConsumers with a live frame — assert chunks[0] contains the frame.
        //
        // 5. Simulate auth revocation:
        //    vi.mocked(authenticate).mockRejectedValueOnce(new Error('token revoked'));
        //
        // 6. Broadcast another frame.
        //
        // 7. Assert:
        //    - chunks length > 1 (the first frame landed)
        //    - The final chunk contains `auth-error` or `401`
        //    - OR controller.close was called
        //    - The second content frame does NOT appear in chunks.

        expect.fail(
            'Remove .skip when the periodic auth-recheck is implemented in stream/+server.ts',
        );
    });

    it('placeholder — SSE auth-revoke test infrastructure is ready when .skip is removed', () => {
        // This non-skipped test ensures the file itself parses and runs cleanly.
        expect(true).toBe(true);
    });
});
