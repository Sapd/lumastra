// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structured logging utility for consistent logging across the application
 *
 * Usage:
 *   const logger = Logger.for('TMDBEmbeddings');
 *   logger.info('Starting generation', { maxMovies: 15000 });
 *   logger.error('Failed to fetch', error, { tmdbId: 123 });
 *
 * Log Level Configuration:
 *   Set LOG_LEVEL environment variable to: 'debug' | 'info' | 'warn' | 'error'
 *   Default: 'debug' in development, 'info' in production
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log level priority (lower = more verbose)
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

// Get configured log level (lazy loaded to avoid circular dependency with config)
let configuredLogLevel: LogLevel | null = null;

function getConfiguredLogLevel(): LogLevel {
    if (configuredLogLevel === null) {
        // Try to get from config, fallback to env/defaults
        try {
            // Dynamic import to avoid circular dependency
            const envLevel = process.env.LOG_LEVEL as LogLevel;
            if (envLevel && LOG_LEVEL_PRIORITY[envLevel] !== undefined) {
                configuredLogLevel = envLevel;
            } else {
                configuredLogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
            }
        } catch {
            // best-effort: cannot log here (this IS the logger) — fall back to a sane default level.
            configuredLogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
        }
    }
    return configuredLogLevel;
}

/**
 * Log context data - accepts any object with string keys.
 * Uses object to allow passing typed interfaces without requiring explicit index signatures.
 */
export type LogContext = object;

// security review 2026-09-13, C17: strip C0 (0x00-0x1F, DEL 0x7F) and C1
// (0x80-0x9F) control characters — covers \r, \n, and ESC (\x1b, used to
// start terminal escape sequences) — from a value about to be concatenated
// verbatim into a console log line. See formatConsoleMessage.
// eslint-disable-next-line no-control-regex -- deliberately matching control chars to strip them
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

function stripControlChars(value: string): string {
    return value.replace(CONTROL_CHARS_RE, '');
}

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    context: string;
    message: string;
    data?: object;
    error?: string;
    stack?: string;
}

export class LoggerInstance {
    protected context: string;

    constructor(context: string) {
        this.context = context;
    }

    /**
     * Return the current logger context (e.g. `SyncProcessor:tmdb-metadata`).
     * Exposed for wrappers (see {@link makeTaskLogger}) that need to build a
     * subclass instance while preserving the base logger's context string.
     */
    getContext(): string {
        return this.context;
    }

    private formatTimestamp(): string {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 19);
    }

    private formatLogEntry(level: LogLevel, message: string, data?: object): LogEntry {
        return {
            timestamp: this.formatTimestamp(),
            level,
            context: this.context,
            message,
            data,
        };
    }

    private formatConsoleMessage(entry: LogEntry): string {
        // Plugin log payloads can carry circular refs, BigInts, or host
        // objects with throwing getters. If one of those slips through to
        // JSON.stringify, the console sink would throw and swallow the
        // log line (and, in the TaskLogger subclass, short-circuit the
        // tee into the SSE ring buffer). Wrap in try/catch so the log is
        // still emitted with a sentinel instead of lost. See W11-P-A #6.
        let dataStr = '';
        if (entry.data) {
            try {
                dataStr = ` ${JSON.stringify(entry.data)}`;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                dataStr = ` [unserializable data: ${msg}]`;
            }
        }
        // security review 2026-09-13, C17: `message` and `context` are plain
        // strings concatenated verbatim into one console line — unlike
        // `data`, they are NOT run through JSON.stringify, which is what
        // would otherwise escape control characters. A call site that
        // interpolates attacker-controlled input into either (e.g. the old
        // Subsonic dispatcher building `Unknown Subsonic method: ${method}`
        // from an unauthenticated, URL-decoded route param) could forge
        // fake log lines via CR/LF, or terminal-escape sequences via ESC.
        // Strip C0 (0x00-0x1F, DEL 0x7F) and C1 (0x80-0x9F) control
        // characters here as defense-in-depth, regardless of what any
        // caller passes in — callers should still prefer putting untrusted
        // values in `data` (JSON-escaped) rather than the message/context.
        const context = stripControlChars(entry.context);
        const message = stripControlChars(entry.message);
        return `[${entry.timestamp}] [${context}] [${entry.level.toUpperCase()}] ${message}${dataStr}`;
    }

    private shouldLog(level: LogLevel): boolean {
        const configuredLevel = getConfiguredLogLevel();
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[configuredLevel];
    }

    private log(level: LogLevel, message: string, data?: object, error?: Error): void {
        if (!this.shouldLog(level)) {
            return;
        }

        const entry = this.formatLogEntry(level, message, data);

        if (error) {
            entry.error = error.message;
            entry.stack = error.stack;
        }

        // Console output
        const consoleMessage = this.formatConsoleMessage(entry);

        switch (level) {
            case 'debug':
            case 'info':
                console.log(consoleMessage);
                if (error) console.error(error.stack || error.message);
                break;
            case 'warn':
                console.warn(consoleMessage);
                if (error) console.warn(error.stack || error.message);
                break;
            case 'error':
                console.error(consoleMessage);
                if (error) console.error(error.stack || error.message);
                break;
        }
    }

    debug(message: string, data?: object): void {
        this.log('debug', message, data);
    }

    info(message: string, data?: object): void {
        this.log('info', message, data);
    }

    warn(message: string, data?: object | Error, error?: Error): void {
        if (data instanceof Error) {
            this.log('warn', message, undefined, data);
            return;
        }
        this.log('warn', message, data, error);
    }

    error(message: string, errorOrData?: object | Error, data?: object): void {
        // Second arg may be the Error (canonical `error(msg, err, data)`) or,
        // Winston-style, a plain context object (`error(msg, { … })`). Route
        // an Error to the error slot and any other object to the data slot so
        // callers using either shape are typed and logged correctly.
        if (errorOrData instanceof Error || errorOrData === undefined) {
            this.log('error', message, data, errorOrData);
        } else {
            this.log('error', message, errorOrData, undefined);
        }
    }

    /**
     * Log task progress with standardized format
     */
    progress(
        taskId: string,
        progress: { processed: number; total: number; percentage?: number },
    ): void {
        const percentage =
            progress.percentage ?? Math.round((progress.processed / progress.total) * 100);
        this.info('Task progress', {
            taskId,
            processed: progress.processed,
            total: progress.total,
            percentage: `${percentage}%`,
        });
    }

    /**
     * Create a child logger with additional context
     */
    child(childContext: string): LoggerInstance {
        return new LoggerInstance(`${this.context}:${childContext}`);
    }
}

/**
 * Logger factory - creates contextual logger instances
 */
export class Logger {
    private static instances: Map<string, LoggerInstance> = new Map();

    /**
     * Get or create a logger for the given context
     */
    static for(context: string): LoggerInstance {
        if (!this.instances.has(context)) {
            this.instances.set(context, new LoggerInstance(context));
        }
        return this.instances.get(context)!;
    }

    /**
     * Create a new logger instance (useful for one-off contexts)
     */
    static create(context: string): LoggerInstance {
        return new LoggerInstance(context);
    }
}

// Export a default logger for quick usage
export const defaultLogger = Logger.for('App');

/**
 * Wrap a `LoggerInstance` so every `info/warn/error/debug` call ALSO tees
 * a structured entry into the per-task ring buffer (`task-log-buffer.ts`),
 * which the admin task-detail log viewer reads via SSE.
 *
 * Behavior:
 *   - Pass-through: every call forwards to the base logger unchanged, so
 *     container logs (`docker logs`) still see the same output.
 *   - Tee: a structured entry is pushed into the buffer with `taskId`,
 *     `jobId`, `level`, `context`, `message`, `data`, and (for warn/error
 *     variants that receive an Error) `error.message` + `error.stack`.
 *   - The wrapper returns a new LoggerInstance subclass so plugins that
 *     call `.child('sub-scope')` still get a nested logger — the child
 *     tees into the same taskId/jobId buffer automatically.
 *
 * Plugins see no API change. The sync processor swaps the base logger for
 * a task-scoped logger before calling `plugin.execute(ctx)`.
 */
export function makeTaskLogger(
    base: LoggerInstance,
    taskId: string,
    jobId: string | null,
): LoggerInstance {
    return new TaskLogger(base.getContext(), taskId, jobId);
}

/**
 * Internal subclass used by {@link makeTaskLogger}. Declared in this module
 * so it has access to the private `log` path; public API is identical to
 * {@link LoggerInstance}.
 */
class TaskLogger extends LoggerInstance {
    private readonly taskId: string;
    private readonly jobId: string | null;

    constructor(context: string, taskId: string, jobId: string | null) {
        super(context);
        this.taskId = taskId;
        this.jobId = jobId;
    }

    override debug(message: string, data?: object): void {
        super.debug(message, data);
        this.tee('debug', message, data);
    }

    override info(message: string, data?: object): void {
        super.info(message, data);
        this.tee('info', message, data);
    }

    override warn(message: string, data?: object | Error, error?: Error): void {
        super.warn(message, data, error);
        if (data instanceof Error) {
            this.tee('warn', message, undefined, data);
        } else {
            this.tee('warn', message, data, error);
        }
    }

    override error(message: string, errorOrData?: object | Error, data?: object): void {
        if (errorOrData instanceof Error || errorOrData === undefined) {
            super.error(message, errorOrData, data);
            this.tee('error', message, data, errorOrData);
        } else {
            super.error(message, errorOrData);
            this.tee('error', message, errorOrData, undefined);
        }
    }

    override child(childContext: string): LoggerInstance {
        return new TaskLogger(`${this.getContext()}:${childContext}`, this.taskId, this.jobId);
    }

    private tee(level: LogLevel, message: string, data?: object, err?: Error): void {
        const sink = taskLogSink;
        if (!sink) return;
        try {
            sink({
                taskId: this.taskId,
                jobId: this.jobId,
                timestamp: Date.now(),
                level,
                context: this.getContext(),
                message,
                data: data && !(data instanceof Error) ? toPlainRecord(data) : undefined,
                error: err ? { message: err.message, stack: err.stack } : undefined,
            });
        } catch {
            // Never let a buffer failure break the base logger's contract.
        }
    }
}

/**
 * Shape mirrored from task-log-buffer.ts — logger.ts intentionally keeps no
 * type-level dep on the queue module. The sink validates the shape at
 * runtime before pushing into its ring.
 */
export interface TaskLogTeeEntry {
    taskId: string;
    jobId: string | null;
    timestamp: number;
    level: LogLevel;
    context: string;
    message: string;
    data?: Record<string, unknown>;
    error?: { message: string; stack?: string };
}

export type TaskLogSink = (entry: TaskLogTeeEntry) => void;

/**
 * Module-level sink populated by `task-log-buffer.ts` at its own import
 * time. Keeping the sink optional + injected (rather than a direct import)
 * means logger.ts has zero inbound deps on the queue layer — this module is
 * imported by hundreds of files, and pulling `queue/` into that dep graph
 * would create cycles during the per-test module reset.
 */
let taskLogSink: TaskLogSink | null = null;

/**
 * Register the task-log sink. Called once by `task-log-buffer.ts`. Passing
 * `null` detaches the sink, which is useful for tests that want to run the
 * logger in isolation.
 */
export function registerTaskLogSink(sink: TaskLogSink | null): void {
    taskLogSink = sink;
}

/**
 * Keys whose values should be redacted from log output to prevent accidental
 * secret leakage. Matches any key that contains one of these substrings
 * (case-insensitive). Applies to both top-level and deeply-nested keys.
 */
const SECRET_KEY_PATTERN = /api_key|apikey|password|passwd|secret|token|auth/i;

/** Returns true when a log field name matches the secret blocklist. */
function isSecretKey(key: string): boolean {
    return SECRET_KEY_PATTERN.test(key);
}

const REDACTED_SENTINEL = '[redacted]';

/**
 * Walk a plain (already JSON-safe) object and replace values whose key
 * matches `isSecretKey` with the redacted sentinel. Operates on the
 * post-JSON.parse snapshot so only plain objects/arrays are ever seen.
 */
function redactSecretsDeep(value: unknown): unknown {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        return value.map((item) => redactSecretsDeep(item));
    }
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        out[key] = isSecretKey(key) ? REDACTED_SENTINEL : redactSecretsDeep(record[key]);
    }
    return out;
}

/**
 * Coerce an arbitrary `object` passed as log data into a string-keyed record
 * suitable for JSON serialization in the buffer. Non-plain values (functions,
 * symbols) are dropped. Each value is trial-serialized and, on failure,
 * replaced with a `[unserializable: <reason>]` sentinel so a single circular
 * or exotic field cannot poison the entire log buffer. Keys matching the
 * secret blocklist (api_key/password/secret/token/auth) are redacted.
 *
 * Failure modes this guards against:
 *   - Circular references (`obj.self = obj`) — JSON.stringify throws
 *     `TypeError: Converting circular structure to JSON`. Before this guard,
 *     one such entry would make every subsequent SSE `JSON.stringify(entry)`
 *     in the /logs endpoint throw, closing the stream and starting an
 *     infinite reconnect loop (the poisoned entry replays on every
 *     reconnect). See the layered fix: buffer cap + SSE writeFrame guard.
 *   - BigInt values — JSON.stringify throws `TypeError: Do not know how to
 *     serialize a BigInt`. Coerced to a sentinel with a readable marker so
 *     the operator can see the field name and know the type was swallowed.
 *   - Host objects / proxies with throwing getters — caught by the trial
 *     stringify and replaced with the error's message.
 *   - Symbol-keyed properties — `Object.entries` / `for...in` skip Symbol
 *     keys. `Reflect.ownKeys` is used instead so Symbol keys are included
 *     with their description stringified as `Symbol(desc)`.
 *
 * Nested plain objects remain nested: we do not deep-walk on success because
 * JSON.stringify handles nested structures natively, and eager recursion
 * would change the buffer shape for log data that the UI already renders.
 *
 * Getter variance: each value is read once via `Reflect.ownKeys` and
 * immediately snapshotted by `sanitizeValue`. A getter that returns different
 * results per call is only invoked once, preventing a mismatch between the
 * trial-stringify pass and a second serialize in the SSE writeFrame.
 */
function toPlainRecord(input: object): Record<string, unknown> {
    if (Array.isArray(input)) return { items: sanitizeForLog(input) };
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
        const strKey =
            typeof key === 'symbol'
                ? String(key) // produces "Symbol(description)"
                : key;
        let rawValue: unknown;
        try {
            rawValue = (input as Record<string | symbol, unknown>)[key];
        } catch (getterErr) {
            // Getter threw — record the error as the sentinel value.
            const msg = getterErr instanceof Error ? getterErr.message : String(getterErr);
            out[strKey] = `[unserializable: getter threw ${msg}]`;
            continue;
        }
        if (typeof rawValue === 'function' || typeof rawValue === 'symbol') continue;
        // Redact secret keys before any further serialization.
        if (isSecretKey(strKey)) {
            out[strKey] = REDACTED_SENTINEL;
            continue;
        }
        out[strKey] = sanitizeValue(rawValue);
    }
    return out;
}

/**
 * Attempt `JSON.stringify(value)`. On failure, replace with a sentinel that
 * identifies the failure so downstream consumers (SSE endpoint) can render
 * a readable string instead of crashing.
 *
 * For objects, a deep snapshot is taken via `JSON.parse(JSON.stringify(value))`
 * so that getters are invoked exactly once. This prevents a mismatch where the
 * trial stringify succeeds but a subsequent serialize (e.g. in SSE writeFrame)
 * produces a different result because the getter returned a different value on
 * the second call.
 *
 * Secret keys nested inside objects are redacted after snapshotting via
 * `redactSecretsDeep`.
 *
 * Exported for tests in logger.test.ts; intentionally not part of the public
 * Logger API.
 */
function sanitizeValue(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'bigint') {
        // BigInt fails JSON.stringify outright. Preserve the numeric content
        // as a string so operators can still correlate by value.
        return `[unserializable: bigint ${String(value)}]`;
    }
    if (t === 'function' || t === 'symbol') {
        return `[unserializable: ${t}]`;
    }
    if (t !== 'object') return value;
    try {
        // Deep snapshot: invokes getters once, detects circular refs, and
        // produces a plain object that JSON.stringify can safely re-serialize.
        const snapshot = JSON.parse(JSON.stringify(value)) as unknown;
        // Redact any secret-named keys in the nested snapshot.
        return redactSecretsDeep(snapshot);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[unserializable: ${msg}]`;
    }
}

/**
 * Array variant of sanitizeValue. Each element is trial-serialized in
 * isolation so one poisoned element doesn't truncate the rest. Not exported:
 * only toPlainRecord needs array sanitation.
 */
function sanitizeForLog(arr: unknown[]): unknown[] {
    return arr.map((v) => sanitizeValue(v));
}
