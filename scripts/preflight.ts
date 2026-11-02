#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Preflight script — validates both configuration AND connectivity.
//
//   npm run preflight
//
// Runs the config doctor (same as `npm run doctor`) and additionally tests:
//   - Database connectivity (PostgreSQL)
//   - Cache connectivity (Valkey/Redis)
//
// Exits 0 when all checks pass, 1 when any error is found. Warnings are allowed.
// Designed for CI pipelines, container health checks, and post-install verification.

import type { DoctorReport } from '../src/lib/server/preflight/config-doctor.js';
import {
    testCacheConnection,
    testDatabaseConnection,
    type ConnectivityResult,
} from '../src/lib/server/preflight/connectivity.js';

async function loadDotenvIfAvailable(): Promise<void> {
    try {
        const dotenvModule = await import('dotenv');
        const config =
            'default' in dotenvModule
                ? (dotenvModule.default?.config ?? dotenvModule.config)
                : dotenvModule.config;
        if (typeof config === 'function') config({ quiet: true });
    } catch (error) {
        const err = error as { code?: string };
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
}

function formatConnectivityResults(results: ConnectivityResult[]): string {
    const lines: string[] = [];
    lines.push('Connectivity checks:');
    for (const r of results) {
        const icon = r.ok ? '✅' : '❌';
        lines.push(`  ${icon} ${r.service}: ${r.message}`);
        if (r.details) lines.push(`     ${r.details}`);
    }
    return lines.join('\n');
}

async function main(): Promise<void> {
    await loadDotenvIfAvailable();

    // Import AFTER dotenv so env-derived defaults are seen.
    const { runConfigDoctor, formatDoctorReport } =
        await import('../src/lib/server/preflight/config-doctor.js');

    const report: DoctorReport = runConfigDoctor();

    const dbResult = await testDatabaseConnection(process.env.DATABASE_URL);
    // TASK_CACHE_URL is required; CACHE_URL is optional (unset = memory cache).
    const taskResult = await testCacheConnection(
        process.env.TASK_CACHE_URL,
        'Task Valkey',
        'TASK_CACHE_URL',
    );
    const connectivityResults = [dbResult, taskResult];
    if (process.env.CACHE_URL)
        connectivityResults.push(await testCacheConnection(process.env.CACHE_URL));

    const connectivityErrors = connectivityResults.filter((r) => !r.ok).length;
    const totalErrors = report.errorCount + connectivityErrors;

    console.log('='.repeat(60));
    console.log('🩺 LUMASTRA — PREFLIGHT');
    console.log('='.repeat(60));
    console.log(formatDoctorReport(report));
    console.log('');
    console.log(formatConnectivityResults(connectivityResults));
    console.log('='.repeat(60));

    if (totalErrors > 0) {
        console.error(`\n💥 ${totalErrors} error(s) — fix the above before deploying.`);
        process.exit(1);
    }

    console.log('\n✅ All checks passed.');
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    void main();
}
