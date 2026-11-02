#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Container Startup Migration Script
// Runs database migrations and optionally syncs metadata on container startup

// CRITICAL: Load dotenv FIRST (when available), then use dynamic import to delay loading modules that need env vars
async function loadDotenvIfAvailable(): Promise<void> {
    try {
        const dotenvModule = await import('dotenv');
        const config =
            'default' in dotenvModule
                ? (dotenvModule.default?.config ?? dotenvModule.config)
                : dotenvModule.config;
        if (typeof config === 'function') {
            config({ quiet: true });
        }
    } catch (error) {
        const err = error as { code?: string };
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
            throw error;
        }
    }
}

const MIGRATION_VERSION = '4.2.1'; // Update this when adding new migrations (v4.2.1 = flattened base schema)

async function runStartupMigration(): Promise<void> {
    // Mandatory topology validation cannot be bypassed by optional preflight flags.
    const { assertValkeyEndpointConfiguration } =
        await import('../src/lib/server/config/valkey-endpoints.js');
    assertValkeyEndpointConfiguration();

    // Dynamic imports AFTER dotenv.config() to ensure env vars are loaded.
    const { migrateSchema } = await import('../src/lib/server/database/migrate-schema.js');
    const { runConfigDoctor, formatDoctorReport } =
        await import('../src/lib/server/preflight/config-doctor.js');
    console.log('='.repeat(60));
    console.log('🚀 LUMASTRA - CONTAINER STARTUP MIGRATION');
    console.log('='.repeat(60));

    const startTime = Date.now();

    try {
        // Step 0: Preflight configuration validation. Catches misconfig that
        // would otherwise fail silently or only at first use (e.g. an
        // EMBEDDING_DIMENSIONS that doesn't match the model → pgvector column
        // width mismatch → /api/assistant 500s, no library embeddings). Runs in
        // the container so operators see it in `docker logs` without cloning the
        // repo. Errors fail boot (loud > silently-wrong); warnings don't.
        // Escape hatch: LUMASTRA_SKIP_PREFLIGHT=true.
        console.log('\n🩺 STEP 0: Configuration Preflight');
        console.log('-'.repeat(40));
        const report = runConfigDoctor();
        console.log(formatDoctorReport(report));
        if (!report.ok) {
            const skipPreflight = process.env.LUMASTRA_SKIP_PREFLIGHT?.toLowerCase() === 'true';
            if (skipPreflight) {
                console.warn(
                    `\n⚠️  Preflight found ${report.errorCount} error(s) but LUMASTRA_SKIP_PREFLIGHT=true — continuing anyway.`,
                );
            } else {
                throw new Error(
                    `Configuration preflight failed with ${report.errorCount} error(s). Fix them (see above), or set LUMASTRA_SKIP_PREFLIGHT=true to bypass.`,
                );
            }
        }

        // Step 1: Run schema migration
        console.log('\n📊 STEP 1: Database Schema Migration');
        console.log('-'.repeat(40));

        await migrateSchema();
        console.log('✅ Schema migration completed successfully');

        // Step 1.2: Setup lock. Applies an operator's SETUP_UNLOCK (only while
        // no admin exists) and re-writes a missing lock when an admin exists.
        console.log('\n🔒 STEP 1.2: Setup Lock');
        console.log('-'.repeat(40));
        await runSetupLockStep();

        // Step 1.5: DB-aware preflight. Runs AFTER the schema migration so the
        // `media_embeddings.embedding` column exists. The DB-aware doctor adds
        // checks the env-only Step 0 cannot see:
        //   - embedding column dimension drift (provider switched without
        //     migrating the vector column — e.g. OpenAI 1536 over a leftover
        //     vector(1024)), which would otherwise surface as a cryptic
        //     first-insert pgvector failure;
        //   - cache (Valkey/Redis) reachability, so a dead CACHE_URL is loud at
        //     boot rather than failing on first cache use.
        // (The DB probe is redundant here — STEP 1 already proved DB reach — but
        // costs nothing and keeps the report complete.)
        // Honours the same LUMASTRA_SKIP_PREFLIGHT escape hatch.
        console.log('\n🩺 STEP 1.5: DB-Aware Preflight (embedding column + connectivity)');
        console.log('-'.repeat(40));
        const { runConfigDoctorWithDb } =
            await import('../src/lib/server/preflight/config-doctor.js');
        const { getDb } = await import('../src/lib/server/database/connection.js');
        const sql = getDb();
        if (!sql) {
            console.warn(
                '⚠️  Could not open a DB connection for the DB-aware preflight — skipping.',
            );
        } else {
            const dbReport = await runConfigDoctorWithDb(sql);
            // Surface only the issues the DB-aware pass ADDS over Step 0 (which
            // already reported env-only issues), so we don't double-log them.
            const step0Codes = new Set(report.issues.map((i) => i.code));
            const newIssues = dbReport.issues.filter((i) => !step0Codes.has(i.code));
            const newErrorCount = newIssues.filter((i) => i.severity === 'error').length;
            if (newIssues.length === 0) {
                console.log('✅ Embedding column width + connectivity checks passed');
            } else {
                console.log(formatDoctorReport({ ...dbReport, issues: newIssues }));
                if (newErrorCount > 0) {
                    const skipPreflight =
                        process.env.LUMASTRA_SKIP_PREFLIGHT?.toLowerCase() === 'true';
                    if (skipPreflight) {
                        console.warn(
                            `\n⚠️  DB-aware preflight found ${newErrorCount} error(s) but LUMASTRA_SKIP_PREFLIGHT=true — continuing anyway.`,
                        );
                    } else {
                        throw new Error(
                            `DB-aware preflight failed with ${newErrorCount} error(s) (see above). Fix them, or set LUMASTRA_SKIP_PREFLIGHT=true to bypass.`,
                        );
                    }
                }
            }
        }

        // Metadata backfill (missing IMDB IDs / cast / crew) is handled by the
        // task system's `metadata-update` task, whose stage-coverage sweep
        // auto-enqueues items that need it — no separate startup step required.
        // (Previously an optional STARTUP_SYNC_METADATA=true STEP 2 ran the same
        // `syncMissingMetadata()` synchronously here, blocking boot on external
        // provider calls with no retry/circuit-breaker/observability. Removed —
        // it duplicated what the task system already does safely.)

        // Step 3: Startup completion
        const duration = Date.now() - startTime;
        console.log('\n✅ STARTUP MIGRATION COMPLETED');
        console.log('-'.repeat(40));
        console.log(`Migration version: ${MIGRATION_VERSION}`);
        console.log(`Total time: ${Math.round(duration / 1000)}s`);
        console.log('Container is ready to serve requests');
        console.log('='.repeat(60));
    } catch (error) {
        console.error('\n❌ STARTUP MIGRATION FAILED');
        console.error('-'.repeat(40));
        console.error('Error:', error);
        console.error('\n🔧 TROUBLESHOOTING:');
        console.error('1. Check database connection (DATABASE_URL)');
        console.error('2. Verify database permissions');
        console.error('3. Check container logs for detailed error messages');
        console.error('='.repeat(60));

        // Fail fast on migration error regardless of NODE_ENV.
        //
        // The previous behavior — log a warning and continue startup in
        // production — silently masked the failed 15.0.0 cutover on 2026-05-13:
        // the container ran for 2 days with new code against the old schema
        // before anyone noticed.
        //
        // A DOWN container is loud and obvious; a SILENTLY WRONG container
        // is invisible and dangerous. Better that docker-compose/k8s health
        // checks flip red and force operator attention than that the app
        // run against a half-applied schema.
        throw error;
    }
}

/**
 * Reconcile the persistent setup lock (security review 6, ruling S-C5c-2) on
 * every container start. Never fails boot: on any error the lock is left as it
 * was, which keeps a completed install closed.
 */
async function runSetupLockStep(): Promise<void> {
    try {
        const { config } = await import('../src/lib/server/config.js');
        const { getDb } = await import('../src/lib/server/database/connection.js');
        const { reconcileSetupLock, describeSetupLockOutcome } =
            await import('../src/lib/server/services/setup-lock.service.js');
        const sql = getDb();
        if (!sql) {
            console.warn('⚠️  No database connection; setup lock not checked.');
            return;
        }
        const outcome = await reconcileSetupLock(sql, {
            unlockRequested: config.SETUP_UNLOCK,
            adminGroupNames: config.ADMIN_GROUPS,
        });
        const note = describeSetupLockOutcome(outcome);
        if (!note) {
            console.log('✅ Setup lock unchanged');
        } else if (note.level === 'warn') {
            console.warn(`⚠️  ${note.message}`);
        } else {
            console.log(`✅ ${note.message}`);
        }
    } catch (error) {
        console.warn(
            '⚠️  Setup lock could not be checked; left as it was:',
            error instanceof Error ? error.message : String(error),
        );
    }
}

// Environment validation
function validateEnvironment(): void {
    const requiredVars = ['DATABASE_URL'];
    const missingVars = requiredVars.filter((varName) => !process.env[varName]);

    if (missingVars.length > 0) {
        console.error('❌ Missing required environment variables:', missingVars.join(', '));
        process.exit(1);
    }

    // Log configuration
    console.log('🔧 Startup Configuration:');
    console.log(`   NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   DATABASE_URL: ${process.env.DATABASE_URL ? '[SET]' : '[MISSING]'}`);
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const main = async (): Promise<void> => {
        await loadDotenvIfAvailable();
        validateEnvironment();

        try {
            await runStartupMigration();
            console.log('\n🎉 Ready to start application server');
            process.exit(0);
        } catch (error) {
            console.error('\n💥 Startup migration failed:', error);
            process.exit(1);
        }
    };

    void main();
}
