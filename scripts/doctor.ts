#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Config doctor CLI — validates environment configuration that would otherwise
// fail silently or only at first use (e.g. an EMBEDDING_DIMENSIONS value that
// doesn't match the embedding model).
//
//   npm run doctor
//
// Exits 0 when there are no errors (warnings are allowed), 1 when any
// error-severity issue is found. Safe to run before `npm run startup-migration`
// or as a quick post-install sanity check.

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

async function main(): Promise<void> {
    await loadDotenvIfAvailable();
    // Import AFTER dotenv so env-derived defaults are seen.
    const { runConfigDoctor, formatDoctorReport } =
        await import('../src/lib/server/preflight/config-doctor.js');

    const report = runConfigDoctor();
    console.log('='.repeat(60));
    console.log('🩺 LUMASTRA — CONFIG DOCTOR');
    console.log('='.repeat(60));
    console.log(formatDoctorReport(report));
    console.log('='.repeat(60));

    if (!report.ok) {
        console.error(
            `\n💥 ${report.errorCount} configuration error(s) — fix the above before deploying.`,
        );
        process.exit(1);
    }
    process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    void main();
}
