// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lazy, once-per-process schema ensure. Features have no migration mechanism
 * (migrations are a TaskDefinition-only field), so the shoutbox creates its own
 * table idempotently. Guarded so concurrent route calls don't re-issue DDL.
 * @type {Promise<void> | null}
 */
let ensured = null;

/** @param {import('postgres').Sql} sql */
export function ensureSchema(sql) {
    if (ensured) return ensured;
    ensured = (async () => {
        // One tagged-template call carries every DDL statement. postgres.js needs
        // `.simple()` to run multiple commands in a single round-trip (the extended
        // protocol allows only one statement per query); guarded so a plain mock
        // `sql` in unit tests still works.
        //
        // ── Schema evolution without migrations ──────────────────────────────
        //
        // `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so
        // it CANNOT introduce a new column on an upgrade — the table is created
        // once and then frozen forever. Every change after the first release has
        // to be expressed as its own separately-guarded statement, which is what
        // the ALTER/UPDATE block below is. This runs on every process start; all
        // of it must stay idempotent and cheap.
        //
        // `user_id` is the 2026-08-11 addition. The table predates user UUIDs
        // entirely and keyed authorship by `username`, a mutable handle that an
        // IdP rename changes and a deleted account frees for reuse — so the next
        // holder of a name inherited the previous holder's messages. `username`
        // stays, denormalised, because a chat log wants the handle as it was at
        // write time; it is display data now, not identity.
        const q = sql`
            CREATE TABLE IF NOT EXISTS shoutbox_messages (
                id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                username    text NOT NULL,
                user_group  text,
                author_kind text NOT NULL DEFAULT 'user',
                reply_to    uuid,
                body        text NOT NULL,
                created_at  timestamptz NOT NULL DEFAULT now(),
                deleted_at  timestamptz
            );
            CREATE INDEX IF NOT EXISTS idx_shoutbox_created
            ON shoutbox_messages (created_at DESC) WHERE deleted_at IS NULL;

            -- Nullable on purpose. Historical rows whose username no longer
            -- resolves keep NULL forever, and NULL must never match an owner:
            -- an unattributable message is deletable by moderators only, never
            -- claimable by whoever happens to hold that name today.
            ALTER TABLE shoutbox_messages
                ADD COLUMN IF NOT EXISTS user_id uuid;

            -- ON DELETE CASCADE: erasing a user erases their messages. The host's
            -- GDPR registry does not cover plugin-created tables, so the FK is
            -- what makes erasure correct here rather than an entry someone has to
            -- remember to add. Named so re-running this is a no-op.
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'shoutbox_messages_user_id_fkey'
                ) THEN
                    ALTER TABLE shoutbox_messages
                        ADD CONSTRAINT shoutbox_messages_user_id_fkey
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                END IF;
            END $$;

            -- One-time backfill, self-limiting via the NULL guard. Case-folded to
            -- match how usernames are compared everywhere else in this codebase.
            -- Ambiguous names (two accounts folding to the same handle) are left
            -- NULL rather than guessed — a wrong attribution here would hand one
            -- user delete rights over another's messages, which is the exact bug
            -- being closed.
            UPDATE shoutbox_messages m
               SET user_id = u.id
              FROM users u
             WHERE m.user_id IS NULL
               AND m.author_kind = 'user'
               AND lower(m.username) = lower(u.username)
               AND NOT EXISTS (
                    SELECT 1 FROM users u2
                     WHERE lower(u2.username) = lower(m.username) AND u2.id <> u.id
               );

            CREATE INDEX IF NOT EXISTS idx_shoutbox_user_rate
            ON shoutbox_messages (user_id, created_at DESC) WHERE author_kind = 'user';

            -- security review 2026-09-13, C25: backs reserveAiInvocation's
            -- atomic per-user, per-hour cap on ai.js's maybeAnswer — the
            -- plugin declared aiRateLimitPerHour but never enforced it.
            -- One row per invocation (not per-message), so the window is
            -- exactly "how many times did we call the AI backend for this
            -- user", independent of whether that reply itself succeeded.
            CREATE TABLE IF NOT EXISTS shoutbox_ai_invocations (
                id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id    uuid NOT NULL,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_shoutbox_ai_invocations_user_rate
            ON shoutbox_ai_invocations (user_id, created_at DESC);

            -- Retention: reserveAiInvocation and pruneAiInvocations delete by
            -- created_at across ALL users, which the (user_id, created_at)
            -- index above cannot drive — it is ordered by user first. Steady
            -- state the table holds only a couple of hours of invocations and
            -- the planner will happily seq-scan that; this index is for the
            -- FIRST prune on an install that ran without retention and
            -- accumulated rows for the life of every account.
            CREATE INDEX IF NOT EXISTS idx_shoutbox_ai_invocations_created_at
            ON shoutbox_ai_invocations (created_at);

            -- ON DELETE CASCADE mirrors shoutbox_messages_user_id_fkey above:
            -- erasing a user erases their AI-invocation history too.
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'shoutbox_ai_invocations_user_id_fkey'
                ) THEN
                    ALTER TABLE shoutbox_ai_invocations
                        ADD CONSTRAINT shoutbox_ai_invocations_user_id_fkey
                        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
                END IF;
            END $$;
        `;
        await (typeof q?.simple === 'function' ? q.simple() : q);
    })().catch((err) => {
        // Don't memoize a rejected promise: a transient DB error at startup or
        // first route call would otherwise wedge schema ensure for the whole
        // process lifetime. Reset so the next call retries; in-flight callers
        // sharing this promise still reject together.
        ensured = null;
        throw err;
    });
    return ensured;
}

/** Test-only: reset the once-guard. */
export function __resetSchemaGuardForTests() {
    ensured = null;
}
