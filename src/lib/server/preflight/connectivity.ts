// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Shared connectivity probes for the config doctor and the preflight CLI.
//
// Both `scripts/preflight.ts` (CLI) and the config doctor's DB/cache checks need
// the same fast, side-effect-free reachability tests. Factoring them here keeps a
// single implementation: probes open a one-shot connection with a short timeout,
// run a trivial query, and tear it down. They NEVER throw — a failure is returned
// as `{ ok: false }` so callers (the doctor, boot) can turn it into a finding
// rather than an unhandled exception that crashes boot.

export interface ConnectivityResult {
    readonly service: string;
    readonly ok: boolean;
    readonly message: string;
    readonly details?: string;
}

/**
 * Probe PostgreSQL reachability with a one-shot connection and `SELECT version()`.
 * `url` unset → `{ ok: false }` (not an exception). Short connect timeout so a
 * dead host fails fast instead of hanging boot.
 */
export async function testDatabaseConnection(url?: string): Promise<ConnectivityResult> {
    if (!url) {
        return {
            service: 'Database',
            ok: false,
            message: 'DATABASE_URL is not set.',
        };
    }

    try {
        const postgres = await import('postgres');
        const sql = postgres.default(url, {
            max: 1,
            idle_timeout: 5,
            connect_timeout: 10,
        });
        try {
            const result = await sql`SELECT version() AS v`;
            const version = result[0]?.v as string | undefined;
            return {
                service: 'Database',
                ok: true,
                message: 'Connected',
                details: version?.split(' ').slice(0, 2).join(' ') ?? undefined,
            };
        } finally {
            await sql.end();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            service: 'Database',
            ok: false,
            message: 'Connection failed',
            details: message,
        };
    }
}

/**
 * Probe Valkey/Redis reachability with a one-shot `lazyConnect` client and an
 * `INFO server` round-trip. `url` unset → `{ ok: false }`. Bounded retries +
 * connect timeout so a dead cache fails fast.
 */
export async function testCacheConnection(
    url?: string,
    service = 'Cache',
    envName = 'CACHE_URL',
): Promise<ConnectivityResult> {
    if (!url) {
        return {
            service,
            ok: false,
            message: `${envName} is not set.`,
        };
    }

    try {
        const { default: Redis } = await import('ioredis');
        const redis = new Redis(url, {
            maxRetriesPerRequest: 1,
            connectTimeout: 10000,
            lazyConnect: true,
        });
        try {
            // Explicitly connect so we catch errors here, not on first use.
            await redis.connect();
            const info = await redis.info('server');

            const versionMatch =
                /valkey_version:([^\r\n]+)/.exec(info) ?? /redis_version:([^\r\n]+)/.exec(info);
            const version = versionMatch?.[1]?.trim();
            const flavor = info.includes('valkey_version') ? 'Valkey' : 'Redis';

            return {
                service,
                ok: true,
                message: 'Connected',
                details: version ? `${flavor} ${version}` : flavor,
            };
        } finally {
            await redis.quit();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            service,
            ok: false,
            message: 'Connection failed',
            details: message,
        };
    }
}
