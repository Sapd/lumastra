// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Pure endpoint validation, shared by runtime launchers and direct clients. */
export interface ValkeyEndpointEnvironment {
    TASK_CACHE_URL?: string;
    CACHE_URL?: string;
}

export interface ValkeyEndpoint {
    host: string;
    port: number;
    username?: string;
    password?: string;
    database: number;
    tls: boolean;
}

export interface ValkeyEndpoints {
    task: ValkeyEndpoint;
    cache: ValkeyEndpoint | null;
}

/** Upgrade guide for installs that still run a single Valkey and/or the combined web+worker container. */
export const VALKEY_UPGRADE_DOCS_URL =
    'https://lumastra.org/guides/deploy-docker/#upgrading-to-the-dedicated-worker-and-two-valkeys';

/** A permanent configuration error, distinct from a transient connection outage. */
export class ValkeyEndpointConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValkeyEndpointConfigurationError';
    }
}

export function parseValkeyEndpoint(
    value: string,
    name: string,
    defaultDatabase: number,
): ValkeyEndpoint {
    // Never retain URL parser errors: Node includes the original credential-bearing input.
    try {
        const url = new URL(value);
        const path = url.pathname;
        const port = Number(url.port || 6379);
        if (
            !['redis:', 'rediss:'].includes(url.protocol) ||
            !url.hostname ||
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535 ||
            !/^\/(?:\d+)?$|^$/.test(path) ||
            url.search ||
            url.hash ||
            value.trim() !== value ||
            /[\r\n\t]/.test(value)
        )
            throw new Error();
        const database = path && path !== '/' ? Number(path.slice(1)) : defaultDatabase;
        // SELECT uses a bounded database index; GLIDE serializes it as uint32.
        // Reject before clients disagree (large JS integers otherwise wrap to DB0).
        if (!Number.isSafeInteger(database) || database < 0 || database > 2_147_483_647)
            throw new Error();
        // DNS names are case-insensitive; a final dot is an absolute spelling of the same name.
        let host = url.hostname.toLowerCase().replace(/\.$/, '');
        // Normalize IP literals using WHATWG's special-scheme host parser (no DNS/network).
        const normalized = new URL(`http://${host}`).hostname;
        host = normalized.replace(/^\[|\]$/g, '').replace(/\.$/, '');
        return {
            host,
            port,
            username: url.username ? decodeURIComponent(url.username) : undefined,
            password: url.password ? decodeURIComponent(url.password) : undefined,
            database,
            tls: url.protocol === 'rediss:',
        };
    } catch {
        throw new ValkeyEndpointConfigurationError(
            `${name} must be a valid redis:// or rediss:// URL with a host, valid port and optional database number from 0 to 2147483647; query strings and fragments are unsupported. ` +
                'A password containing # ? / @ : % or spaces breaks the URL: percent-encode those characters (e.g. # as %23) or use a password of letters, digits and - . _ ~ only. ' +
                `See ${VALKEY_UPGRADE_DOCS_URL}`,
        );
    }
}

/** IPv4-mapped IPv6 is a deterministic alias, requiring no DNS lookup. */
function instanceHostIdentity(host: string): string {
    const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(host);
    if (!mapped) return host;
    const upper = Number.parseInt(mapped[1], 16);
    const lower = Number.parseInt(mapped[2], 16);
    return `${upper >>> 8}.${upper & 255}.${lower >>> 8}.${lower & 255}`;
}

/**
 * Require the persistent noeviction task instance. Cache may be disabled (memory
 * caching); when enabled it must use a distinct endpoint. Credentials, TLS and
 * logical databases do not isolate instance-wide eviction/persistence policy.
 * This comparison catches equivalent endpoint spellings, not DNS aliases or proxies.
 * Operators must ensure different names actually address distinct instances.
 * No configuration is evaluated and no network work occurs at module import.
 */
export function assertValkeyEndpointConfiguration(
    env: ValkeyEndpointEnvironment = {
        TASK_CACHE_URL: process.env.TASK_CACHE_URL,
        CACHE_URL: process.env.CACHE_URL,
    },
): ValkeyEndpoints {
    if (!env.TASK_CACHE_URL) {
        throw new ValkeyEndpointConfigurationError(
            'TASK_CACHE_URL is required. Lumastra now needs two Valkey servers: add a second Valkey service ' +
                'for the disposable cache and keep your existing Valkey as the task store. ' +
                'Set TASK_CACHE_URL to your existing Valkey with the database it used so far, normally /0 ' +
                '(redis://default:<password>@<existing-valkey-host>:6379/0); it becomes the persistent task store. ' +
                'Switch it to noeviction + AOF WITHOUT losing data: first run `CONFIG SET maxmemory-policy noeviction` and ' +
                '`CONFIG SET appendonly yes` on the running server, wait until INFO persistence shows ' +
                'aof_rewrite_in_progress:0 and aof_last_bgrewrite_status:ok, and only then add ' +
                '--maxmemory-policy noeviction --appendonly yes to its command (restarting an RDB-only Valkey with ' +
                '--appendonly yes starts it EMPTY). Point CACHE_URL at the new cache Valkey (a different host or port). ' +
                `CACHE_URL is never used as a task fallback. Step-by-step upgrade: ${VALKEY_UPGRADE_DOCS_URL}`,
        );
    }
    // DB 0 without a /<db> path: single-Valkey installs kept their task data
    // (bull:*, task:*) in DB 0, so that is where an upgraded task store has it.
    // The task-runtime boot guard refuses when the data sits in another DB.
    const task = parseValkeyEndpoint(env.TASK_CACHE_URL, 'TASK_CACHE_URL', 0);
    const cache = env.CACHE_URL ? parseValkeyEndpoint(env.CACHE_URL, 'CACHE_URL', 0) : null;
    if (
        cache &&
        instanceHostIdentity(task.host) === instanceHostIdentity(cache.host) &&
        task.port === cache.port
    ) {
        throw new ValkeyEndpointConfigurationError(
            'TASK_CACHE_URL and CACHE_URL must point to distinct Valkey instances. Different databases, credentials or redis/rediss schemes on the same host and port do not provide isolation. ' +
                'Add a second Valkey service for CACHE_URL (the disposable cache) and keep your existing Valkey as TASK_CACHE_URL. ' +
                `Step-by-step upgrade: ${VALKEY_UPGRADE_DOCS_URL}`,
        );
    }
    return { task, cache };
}
