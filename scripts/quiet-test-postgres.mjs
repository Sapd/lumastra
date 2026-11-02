// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Quieten and speed up the ephemeral CI test Postgres.
 *
 * WHY THIS EXISTS
 *
 * GitHub dumps every service container's stderr into the job log at teardown,
 * AFTER all steps. For the integration jobs that dump is ~35_000 characters and
 * it is the LAST thing in the log, so it occupies the entire tail — the window
 * every log reader actually gets. On run 34140506114 the last 420 lines contain
 * not one test name. The failing test output is above it, and so is the
 * failing-file list check-vitest-json.mjs prints.
 *
 * Measured on the log of run 34135484429, three shapes account for nearly all of
 * it, and none of them is signal:
 *
 *   1. `STATEMENT:` blocks — the full SQL text re-logged under every ERROR. The
 *      integration suite provokes constraint violations ON PURPOSE (duplicate
 *      usernames, FK violations, `cast('not-a-number' as integer)`), so these
 *      are expected errors, and each one costs 10-40 lines of SQL.
 *   2. `LOG: checkpoint starting/complete` — timer-driven, unrelated to tests.
 *   3. `LOG: skipping analyze of "..." --- lock not available` — autovacuum
 *      losing a race with the suite, dozens of lines at a time.
 *
 * WHAT IS KEPT
 *
 * `log_min_error_statement = panic` suppresses only the STATEMENT companion
 * line. The `ERROR:` and `DETAIL:` lines survive untouched, so the constraint
 * name and the offending key are still in the log — measured locally on 16.13:
 * a duplicate-key error went from 8 log lines to 2, keeping both diagnostics.
 * The client side is not affected at all: postgres.js still receives the full
 * error and the test still sees it. This is server-side logging only.
 *
 * The trade is the SQL text of an unexpected error. That is recoverable (the
 * error names the relation and constraint, and the query lives in the repo),
 * whereas a log tail that cannot show which test failed is not.
 *
 * NON-FATAL BY DESIGN: this is test-service tuning. Every failure path warns and exits
 * 0 — a CI run must never go red because the logs could not be made tidier.
 * ALTER SYSTEM needs superuser, which the postgres image grants POSTGRES_USER;
 * against anything else this simply no-ops with a warning.
 *
 * Writes to the container's postgresql.auto.conf, which is job-scoped and torn
 * down with the container, so nothing persists.
 *
 * Usage: node scripts/quiet-test-postgres.mjs   (reads TEST_DATABASE_URL)
 */

import postgres from 'postgres';

const SETTINGS = [
    // Ephemeral CI databases can trade crash durability for test throughput.
    ['fsync', 'off'],
    ['synchronous_commit', 'off'],
    ['full_page_writes', 'off'],
    // Drop the SQL text under expected errors; keep ERROR + DETAIL.
    ['log_min_error_statement', 'panic'],
    // Timer-driven, says nothing about any test.
    ['log_checkpoints', 'off'],
    // The "skipping analyze --- lock not available" floods.
    ['log_autovacuum_min_duration', '-1'],
];

/**
 * QUIET_PG_SILENCE_ERRORS=1 additionally drops the ERROR/DETAIL lines themselves.
 *
 * Opt-in, and only e2e.yml sets it, because the two tiers are not in the same
 * situation. Keeping ERROR + DETAIL costs the integration job ~40 lines — its
 * guard output stays readable above them, as runs 246 and 247 both showed.
 *
 * The e2e job is a different story. Its specs drive the same handful of fixture
 * ids over and over, so a run emits HUNDREDS of identical
 * `invalid input syntax for type uuid: "e2e00000-0000-0000-0000-music0000003"`
 * pairs. That dump is appended AFTER every step, which is why re-ordering
 * check-playwright-json.mjs's own output did not help: nothing a step prints can
 * outlive a teardown dump larger than the whole readable window. Runs 2 and 3
 * both ended with the ratchet list written, uploaded, and unreadable.
 *
 * `log_min_messages = fatal` is server-side logging only — postgres.js still
 * receives every error and the specs still see and assert on them. What is lost
 * is the server's copy of errors the test framework already reports better.
 */
if (process.env.QUIET_PG_SILENCE_ERRORS) {
    SETTINGS.push(['log_min_messages', 'fatal']);
}

async function main() {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) {
        console.log('[quiet-pg] TEST_DATABASE_URL is not set — nothing to do.');
        return;
    }

    // The constructor is INSIDE the try on purpose. postgres() parses the URL
    // eagerly and throws ERR_INVALID_URL on a malformed one — with it outside,
    // a bad TEST_DATABASE_URL crashed this script with exit 1 and would have
    // failed the step, which is the opposite of the non-fatal contract above.
    // Caught while testing exactly that case.
    let sql;
    let verify;
    try {
        // Short timeouts: this runs before the suite and must not become a way
        // for CI to hang. max:1 — the settings, then leave.
        sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 5, onnotice: () => {} });

        for (const [name, value] of SETTINGS) {
            // ALTER SYSTEM takes no parameters — the name is an identifier and
            // the value a literal, neither of which postgres.js can bind. Both
            // sides come from the frozen SETTINGS list above, never from input,
            // so there is nothing here an attacker could reach.
            await sql.unsafe(`ALTER SYSTEM SET ${name} = '${value}'`);
        }
        await sql.unsafe('SELECT pg_reload_conf()');
        await sql.end({ timeout: 5 }).catch(() => {});
        sql = undefined;

        // Read the settings back rather than trusting the writes: pg_reload_conf
        // returns true for "signal sent", not "applied", and a non-superuser
        // ALTER SYSTEM would have thrown above but a silently ignored one would
        // not. This turns the claim into an observation.
        //
        // It MUST be a fresh connection. Doing this on the same one reported the
        // pre-reload values every time — the backend applies a SIGHUP between
        // commands, and the read raced it. That read-back was worse than none:
        // it made a working script look broken. A new backend inherits the
        // reloaded config at startup, so there is no race left to lose.
        verify = postgres(url, {
            max: 1,
            connect_timeout: 10,
            idle_timeout: 5,
            onnotice: () => {},
        });
        const rows = await verify.unsafe(
            `SELECT name, setting FROM pg_settings WHERE name IN (${SETTINGS.map(
                ([n]) => `'${n}'`,
            ).join(', ')}) ORDER BY name`,
        );
        console.log('[quiet-pg] applied:', rows.map((r) => `${r.name}=${r.setting}`).join(' '));
    } catch (err) {
        console.log(`[quiet-pg] could not quieten Postgres (continuing): ${err.message}`);
    } finally {
        // Either can be undefined: the constructor may have thrown, and sql is
        // deliberately closed early so the verification gets a fresh backend.
        await sql?.end({ timeout: 5 }).catch(() => {});
        await verify?.end({ timeout: 5 }).catch(() => {});
    }
}

await main();
