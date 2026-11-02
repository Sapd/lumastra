// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Create Test Database Script
 *
 * Creates the lumastra_tests database using credentials from DATABASE_URL.
 * Run with: npx tsx tests/integration/setup/create-test-db.ts
 */

import 'dotenv/config';
import postgres from 'postgres';

const TEST_DATABASE_NAME = 'lumastra_tests';

async function createTestDatabase(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
        console.error('DATABASE_URL not found in environment');
        process.exit(1);
    }

    // Parse the URL and connect to 'postgres' database to create test db
    const url = new URL(databaseUrl);
    url.pathname = '/postgres'; // Connect to default postgres database

    console.log(`[create-test-db] Connecting to PostgreSQL server...`);
    const sql = postgres(url.toString(), {
        max: 1,
        connect_timeout: 10,
    });

    try {
        // Check if database exists
        const result = await sql`
            SELECT 1 FROM pg_database WHERE datname = ${TEST_DATABASE_NAME}
        `;

        if (result.length > 0) {
            console.log(`[create-test-db] Database '${TEST_DATABASE_NAME}' already exists`);
        } else {
            // Create the database
            await sql.unsafe(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
            console.log(`[create-test-db] Created database '${TEST_DATABASE_NAME}'`);
        }
    } catch (error) {
        console.error('[create-test-db] Error:', (error as Error).message);
        process.exit(1);
    } finally {
        await sql.end();
    }
}

createTestDatabase()
    .then(() => {
        console.log('[create-test-db] Done');
        process.exit(0);
    })
    .catch((error) => {
        console.error('[create-test-db] Failed:', error);
        process.exit(1);
    });
