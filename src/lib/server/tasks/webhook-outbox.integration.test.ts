// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for security review C8 (2026-09-17, fix plan 4 task 5):
 * `WebhookOutbox.deliveryPass()`'s claim query had no join to `users`, so a
 * per-user webhook row queued BEFORE an admin disabled the owning user kept
 * being claimed and delivered after the disable — the disabled user's event
 * stream kept reaching a destination they control.
 *
 * Proving test per the fix-plan brief (§9): disable a user, then assert the
 * next `deliveryPass()` claims ZERO of their rows, against REAL Postgres —
 * asserted via the claimed row set (whether `next_attempt_at` was bumped by
 * the claim transaction), not a mock's call count. An active user's row is
 * asserted claimed in the same pass as a positive control, proving the test
 * actually exercises claiming rather than trivially seeing nothing move.
 *
 * Both fixture URLs are loopback (`http://127.0.0.1:1/...`), which
 * `assertPublicHttpUrl`'s SSRF guard rejects synchronously with no real
 * network I/O — so a claimed-but-undeliverable row fails fast inside
 * `deliver()` without needing a live HTTP listener or DNS.
 *
 * Requires a live PostgreSQL database (lumastra_tests).
 * Run with: npm run test:integration src/lib/server/tasks/webhook-outbox.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from '$lib/server/config.js';
import { WebhookOutbox, OUTBOX_RETIRED_ERROR_PREFIX } from './webhook-outbox.js';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import {
    upsertUserNotificationWebhook,
    enqueueUserWebhookDelivery,
} from '../database/queries/user-notification-webhooks.queries.js';

const disabledUserId = randomUUID();
const activeUserId = randomUUID();

interface Row {
    next_attempt_at: Date;
    attempts: number;
    dead: boolean;
    last_error: string | null;
}

async function cleanup(): Promise<void> {
    const sql = getTestDb();
    await sql`
        DELETE FROM task_webhook_outbox
        WHERE user_hook_id IN (
            SELECT id FROM user_notification_webhooks
            WHERE user_id = ANY(${[disabledUserId, activeUserId]}::uuid[])
        )
    `;
    await sql`
        DELETE FROM user_notification_webhooks
        WHERE user_id = ANY(${[disabledUserId, activeUserId]}::uuid[])
    `;
    await sql`DELETE FROM users WHERE id = ANY(${[disabledUserId, activeUserId]}::uuid[])`;
}

beforeEach(async () => {
    // FEATURE_USER_NOTIFICATION_WEBHOOKS defaults OFF, and deliveryPass()'s
    // feature gate retires EVERY claimed per-user row when it is off. Left at
    // the default, this file was a false green in both directions: the
    // "positive control" row below was marked dead by the feature gate rather
    // than by any delivery attempt, so `deliver()` — and with it the SSRF
    // rejection this file's header describes — never executed at all, and the
    // owner-inactive sweep could not be told apart from the feature gate
    // because both write `dead = true`.
    //
    // `config` exposes its flags as getters and the outbox reads them per
    // call, so spying on the getter turns the feature gate inert and leaves
    // the owner sweep as the ONLY thing that can retire a row here.
    vi.spyOn(config, 'FEATURE_USER_NOTIFICATION_WEBHOOKS', 'get').mockReturnValue(true);
    await cleanup();
    const sql = getTestDb();
    await ensureTestUser(sql, disabledUserId);
    await ensureTestUser(sql, activeUserId);
    // Deliberately does NOT disable `disabledUserId` here — the named
    // scenario (fix-plan brief §9, and this file's own doc comment) is
    // "queued BEFORE disable", i.e. the disable must happen AFTER the
    // enqueue, inside the `it` body below. Review round 1, Minor 5:
    // disabling here in `beforeEach` (which always runs before the `it`
    // body's enqueue) tested "enqueued while already disabled" instead —
    // the join holds either way, but that was not the scenario this test
    // claimed to cover.
});

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
});

describe('WebhookOutbox.deliveryPass — C8: a disabled user’s queued rows must not be claimed', () => {
    it('claims zero rows owned by a disabled user, while still claiming an active user’s row in the same pass', async () => {
        const sql = getTestDb();

        const disabledHook = await upsertUserNotificationWebhook(sql, {
            userId: disabledUserId,
            url: 'http://127.0.0.1:1/disabled-hook',
            secretEncrypted: Buffer.from('dummy-secret-disabled'),
        });
        const activeHook = await upsertUserNotificationWebhook(sql, {
            userId: activeUserId,
            url: 'http://127.0.0.1:1/active-hook',
            secretEncrypted: Buffer.from('dummy-secret-active'),
        });

        const disabledEnqueued = await enqueueUserWebhookDelivery(sql, {
            userHookId: disabledHook.id,
            eventId: `evt-disabled-${randomUUID()}`,
            payload: { hello: 'disabled' },
        });
        const activeEnqueued = await enqueueUserWebhookDelivery(sql, {
            userHookId: activeHook.id,
            eventId: `evt-active-${randomUUID()}`,
            payload: { hello: 'active' },
        });
        expect(disabledEnqueued).toBe(true);
        expect(activeEnqueued).toBe(true);

        // The admin-disable event under test happens HERE — AFTER the row
        // above was already enqueued — so this is genuinely "queued before
        // disable", the case revocation alone (`revokeAllCredentialsForUser`,
        // which never reaches `user_notification_webhooks`) cannot fix.
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${disabledUserId}::uuid`;

        const [beforeDisabled] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${disabledHook.id}::uuid
        `;
        const [beforeActive] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${activeHook.id}::uuid
        `;

        const outbox = new WebhookOutbox(sql);
        await outbox.deliveryPass();

        const [afterDisabled] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${disabledHook.id}::uuid
        `;
        const [afterActive] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${activeHook.id}::uuid
        `;

        // The disabled user's row must be the SAME row, untouched by the
        // claim transaction — deliveryPass()'s claim query must exclude it
        // via the users join, not merely fail to deliver it after claiming.
        expect(afterDisabled).toBeDefined();
        expect(afterDisabled.next_attempt_at.getTime()).toBe(
            beforeDisabled.next_attempt_at.getTime(),
        );
        expect(afterDisabled.attempts).toBe(beforeDisabled.attempts);

        // Positive control: the active user's row WAS claimed (the claim
        // transaction bumps next_attempt_at forward by the claim TTL before
        // delivery is attempted) — proves deliveryPass() actually ran
        // against real rows in this pass, not that nothing happened at all.
        expect(afterActive).toBeDefined();
        expect(afterActive.next_attempt_at.getTime()).toBeGreaterThan(
            beforeActive.next_attempt_at.getTime(),
        );

        // Retirement (cleanup follow-up to C8). The claim join alone left the
        // row pending forever: `pruneDeliveredWebhookOutbox` only deletes
        // delivered-or-dead rows, so an unclaimable row is never reclaimed.
        // The sweep must mark it dead WITHOUT going through the claim path —
        // which is exactly what the two assertions above already pin down, so
        // together they say "retired, but never claimed".
        expect(beforeDisabled.dead).toBe(false);
        expect(afterDisabled.dead).toBe(true);
        expect(afterDisabled.last_error).toBe(
            `${OUTBOX_RETIRED_ERROR_PREFIX}the owning user account is disabled or deleted`,
        );

        // Negative control: the active user's row must NOT be swept. It was
        // claimed and its delivery failed (loopback URL, rejected by the SSRF
        // guard), so it carries a real last_error — which must not wear the
        // retired marker, or component health would stop counting genuine
        // delivery failures.
        expect(afterActive.dead).toBe(false);
        expect(afterActive.last_error ?? '').not.toContain(OUTBOX_RETIRED_ERROR_PREFIX);
        // It really did go down the delivery path (attempts incremented, SSRF
        // guard rejected the loopback URL) rather than being skipped — without
        // this, `dead === false` would also be satisfied by a row nothing
        // touched, and the control would prove nothing.
        expect(afterActive.attempts).toBe(beforeActive.attempts + 1);
        expect(afterActive.last_error).toContain('SSRF guard');
    });

    it('does not resurrect a retired row when the owning user is re-enabled', async () => {
        const sql = getTestDb();

        const hook = await upsertUserNotificationWebhook(sql, {
            userId: disabledUserId,
            url: 'http://127.0.0.1:1/reenable-hook',
            secretEncrypted: Buffer.from('dummy-secret-reenable'),
        });
        await enqueueUserWebhookDelivery(sql, {
            userHookId: hook.id,
            eventId: `evt-reenable-${randomUUID()}`,
            payload: { hello: 'reenable' },
        });

        // Disable → sweep retires the queued row.
        await sql`UPDATE users SET disabled_at = NOW() WHERE id = ${disabledUserId}::uuid`;
        const outbox = new WebhookOutbox(sql);
        await outbox.deliveryPass();

        const [retired] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${hook.id}::uuid
        `;
        expect(retired.dead).toBe(true);

        // Re-enable. Without retirement the row would become claimable again
        // with a `next_attempt_at` stale by however long the account was
        // disabled, and fire off a notification from weeks ago on the very
        // next tick. `dead = true` is what makes that unreachable for good.
        await sql`UPDATE users SET disabled_at = NULL WHERE id = ${disabledUserId}::uuid`;
        await outbox.deliveryPass();

        const [afterReenable] = await sql<Row[]>`
            SELECT next_attempt_at, attempts, dead, last_error FROM task_webhook_outbox
            WHERE user_hook_id = ${hook.id}::uuid
        `;
        expect(afterReenable.dead).toBe(true);
        // Never claimed: the claim transaction is what bumps next_attempt_at,
        // so an unchanged stamp proves the re-enabled account did not drag the
        // stale payload back into the delivery path.
        expect(afterReenable.next_attempt_at.getTime()).toBe(retired.next_attempt_at.getTime());
        expect(afterReenable.attempts).toBe(retired.attempts);
    });
});
