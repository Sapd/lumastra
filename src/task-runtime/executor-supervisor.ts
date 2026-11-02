// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '$lib/server/utils/logger.js';
import type { AuthorityToken } from './authority/store.js';

const logger = Logger.for('ExecutorSupervisor');

/** What the executor child (and the tasks/plugins it runs) read from the
 * environment, derived from the variables `lib/server/config.ts`, the config
 * service, the database/cache modules and the task/plugin code read: runtime
 * basics, database/cache/config locations, the master-key material that decrypts
 * stored provider secrets, provider keys, and the instance/media/transcoding
 * settings. Web-only variables never reach the child, and a deny entry always
 * wins over an allow entry. */
const EXECUTOR_ENV_NAMES: ReadonlySet<string> = new Set([
    'PATH',
    'HOME',
    'TMPDIR',
    'TZ',
    'LANG',
    'HOSTNAME',
    'DATABASE_URL',
    'CACHE_URL',
    'TASK_CACHE_URL',
    'CONFIG_PATH',
    'CONFIG_DIR',
    'BASE_PATH',
    'LOG_LEVEL',
    'APP_VERSION',
    'APP_COMMIT_SHORT',
    'ASSET_HISTORY_DIR',
    'HOLIDAY_CONFIG_PATH',
    'VALKEY_GLIDE_LOG_LEVEL',
    'UV_THREADPOOL_SIZE',
    'SERVER_ID',
    'LIBRARY_ALLOWED_ROOTS',
    'SYNC_CURATED_LISTS_HOURS',
    'UPDATE_CHECK_ENABLED',
    'WEBHOOK_PRIVATE_HOST_ALLOWLIST',
    'SCAN_ENRICH_INLINE',
    'TASK_UPGRADE_PREPARED_TIMEOUT_MS',
    'ENCODING_PRESET',
    'DELETE_SEGMENTS',
    'THROTTLE_AFTER_SECONDS',
    'H264_CRF',
    'H265_CRF',
    'MAX_HEIGHT',
    'MAX_WIDTH',
    'MAX_MUXING_QUEUE_SIZE',
    'VAAPI_DEVICE',
    'QSV_DEVICE',
    'STORAGE_LOW_SPACE_WARN_GB',
    'TMDB_API_KEY',
    'OMDB_API_KEY',
    'MDBLIST_API_KEY',
    'ACOUSTID_API_KEY',
    'OPENAI_API_KEY',
    'VOYAGE_API_KEY',
]);
const EXECUTOR_ENV_PREFIXES: readonly string[] = [
    'NODE_',
    'LC_',
    'LUMASTRA_',
    'INSTANCE_',
    'PLUGIN_',
    'PLUGINS_',
    'FEATURE_',
    'DISABLE_',
    'ALLOW_',
    'ENABLE_',
    'EMBEDDING_',
    'ESSENTIA_',
    'LICENSE_',
    'TMDB_',
    'METADATA_',
    'PRIMARY_',
    'PROVIDER_ARTWORK_',
    'ANTHROPIC_',
    'OPENAI_',
    'TRAKT_',
    'MAL_',
    'ANIDB_',
    'JELLYFIN',
    'JELLYSEERR',
    'SEERR',
    'SONARR',
    'RADARR',
    'KAVITA',
    'AUDIO',
    'REMOVED_INTEGRATION',
    'FFMPEG_',
    'FFPROBE_',
    'HLS_',
    'TRICKPLAY_',
    'IMAGE_',
    'PREVIEW_',
    'MUSIC_',
    'SONIC_',
    'LIVETV_',
    'FORYOU_',
    'DB_CLEANUP_',
    'DOWNLOAD_',
    'CACHE_',
    'GPU_',
    'HW_',
    'NVENC_',
    'NVDEC_',
    'AMF_',
    'INTEL_',
    'VIDEOTOOLBOX_',
    'VPP_',
    'TONEMAPPING_',
    'DEINTERLACE_',
    'VIDEO_',
    'TRANSCODE_',
    'TRANSCODING_',
    'SOFTWARE_',
    'SUBTITLE_',
    'UPLOAD_',
    'INTEGRITY_',
    'RECONCILE_',
    'PIPELINE_',
    'WATCHER_',
    'ANALYSIS_',
    'TASK_',
];
/** Secrets and settings only the web process may see. Deny beats allow. */
const EXECUTOR_ENV_DENY_PREFIXES: readonly string[] = [
    'LUMASTRA_METRICS_',
    'LUMASTRA_TRUST_',
    'LUMASTRA_DEV_',
    'JWT_',
    'AUTH_',
    'FORWARD_AUTH_',
    'STREAM_PROXY_',
    'MUSIC_TRANSCODE_TOKEN_',
    'APNS_',
    'PUSH_RELAY_',
    'SETUP_UNLOCK',
    'ORIGIN',
    'ADDRESS_HEADER',
    'PROTOCOL_HEADER',
    'TRUSTED_PROXY_IPS',
    'CORS_',
    'SHOWCASE_',
    'DEVICE_',
    'TEST_',
];
const STDERR_TAIL_BYTES = 8 * 1024;

export function filterExecutorEnv(env: Record<string, string | undefined>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        if (EXECUTOR_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
        if (
            EXECUTOR_ENV_NAMES.has(key) ||
            EXECUTOR_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
        )
            result[key] = value;
    }
    return result;
}

export interface ExecutorProcessOptions {
    entry: string;
    guardianEntry?: string;
    env: Record<string, string | undefined>;
    authority?: AuthorityToken;
    eligibleTaskIds?: readonly string[];
    startupTimeoutMs?: number;
    stopTimeoutMs?: number;
    killTimeoutMs?: number;
}
export interface ExecutorStopResult {
    stopped: boolean;
    escalated: boolean;
}
export interface SupervisedExecutor {
    pid: number;
    directory: string;
    socketPath: string;
    controlSocketPath?: string;
    secret: string;
    catalogRevision?: string;
    stop(): Promise<ExecutorStopResult>;
}
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The independent guardian owns the POSIX executor group, even when this
 * controller dies or plugin code blocks its executor event loop. Plugins that
 * deliberately escape the group still require stronger cgroup containment. */
export async function startExecutorProcess(
    options: ExecutorProcessOptions,
): Promise<SupervisedExecutor> {
    if (process.platform === 'win32') throw new Error('Executor supervision requires POSIX');
    const deadline = options.startupTimeoutMs ?? 30_000;
    const stopTimeout = options.stopTimeoutMs ?? 10_000;
    const killTimeout = options.killTimeoutMs ?? 5_000;
    for (const value of [deadline, stopTimeout, killTimeout]) {
        if (!Number.isInteger(value) || value < 1 || value > 300_000)
            throw new Error('Invalid executor supervisor deadline');
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'lx-'));
    await chmod(directory, 0o700);
    const secret = randomBytes(32).toString('hex');
    const guardianEntry =
        options.guardianEntry ??
        path.join(path.dirname(path.resolve(options.entry)), 'task-executor-guardian.js');
    // The guardian gets no application secrets or plugin environment. Executor
    // initialization and environment travel through its private IPC channel.
    const guardian = spawn(process.execPath, [guardianEntry], {
        env: {},
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let stopRequested = false;
    let removal: Promise<void> | undefined;
    const removeDirectory = (): Promise<void> =>
        (removal ??= rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
            removal = undefined;
            logger.warn('Executor socket directory removal failed', { error: String(error) });
        }));
    let guardianExited = false;
    let teardown: ExecutorStopResult | undefined;
    let resolveTeardown: ((value: ExecutorStopResult) => void) | undefined;
    guardian.once('error', () => {
        guardianExited = true;
        resolveTeardown?.({ stopped: false, escalated: false });
    });
    guardian.once('exit', () => {
        guardianExited = true;
        // The guardian may exit after (or without) its own cleanup.
        if (teardown?.stopped) void removeDirectory();
        resolveTeardown?.(teardown ?? { stopped: false, escalated: false });
    });
    guardian.on('message', (message: unknown) => {
        if (
            record(message) &&
            (message.type === 'executor_exited' || message.type === 'executor_failed')
        ) {
            const info = describeExit(message);
            if (info.abnormal && !stopRequested) {
                logger.warn('Executor exited abnormally', {
                    code: info.code,
                    signal: info.signal,
                    stderrTail: info.tail,
                });
            }
            return;
        }
        if (record(message) && message.type === 'cleanup_refused') {
            logger.warn('Executor guardian refused directory cleanup', {
                reason: String(message.reason).slice(0, 200),
            });
            return;
        }
        if (
            !record(message) ||
            message.type !== 'stopped' ||
            typeof message.stopped !== 'boolean' ||
            typeof message.escalated !== 'boolean'
        )
            return;
        teardown = { stopped: message.stopped, escalated: message.escalated };
        // A late positive receipt (after an earlier unknown one) must still
        // release the socket directory.
        if (teardown.stopped) void removeDirectory();
        resolveTeardown?.(teardown);
    });
    let stopping: Promise<ExecutorStopResult> | undefined;
    const stop = (): Promise<ExecutorStopResult> => {
        // Later positive evidence supersedes an earlier unknown receipt, without
        // sending another signal to a numeric PID/group that may be reused.
        stopRequested = true;
        if (teardown?.stopped) {
            const confirmed = teardown;
            return removeDirectory().then(() => confirmed);
        }
        stopping ??= (async () => {
            const result =
                teardown ??
                (guardianExited
                    ? { stopped: false, escalated: false }
                    : await new Promise<ExecutorStopResult>((resolve) => {
                          const timer = setTimeout(
                              () => {
                                  resolveTeardown = undefined;
                                  resolve({ stopped: false, escalated: true });
                              },
                              stopTimeout + killTimeout + 1000,
                          );
                          resolveTeardown = (value): void => {
                              clearTimeout(timer);
                              resolveTeardown = undefined;
                              resolve(value);
                          };
                          if (!guardian.connected) {
                              resolveTeardown({ stopped: false, escalated: false });
                              return;
                          }
                          guardian.send({ type: 'stop' }, (error) => {
                              if (error) resolveTeardown?.({ stopped: false, escalated: false });
                          });
                      }));
            if (result.stopped) await removeDirectory();
            // Never kill the guardian on timeout: it must retain group ownership
            // until actual teardown. Unknown results block authority transfer.
            return result;
        })();
        return stopping;
    };
    try {
        const ready = await new Promise<{
            pid: number;
            socketPath: string;
            controlSocketPath?: string;
            catalogRevision?: string;
        }>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(
                () => finish(new Error('Executor startup timed out')),
                deadline,
            );
            const finish = (
                error?: Error,
                value?: {
                    pid: number;
                    socketPath: string;
                    controlSocketPath?: string;
                    catalogRevision?: string;
                },
            ): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                guardian.off('message', onMessage);
                guardian.off('error', onError);
                guardian.off('exit', onExit);
                if (error) reject(error);
                else resolve(value!);
            };
            const onError = (): void => finish(new Error('Executor guardian failed to spawn'));
            const onExit = (): void =>
                finish(new Error('Executor guardian exited before readiness'));
            const onMessage = (message: unknown): void => {
                if (!record(message)) return;
                if (message.type === 'startup_rejected' && message.code === 'activation_blocked')
                    return finish(new Error('Executor startup rejected: activation_blocked'));
                if (message.type === 'executor_failed' || message.type === 'executor_exited') {
                    const info = describeExit(message);
                    return finish(
                        new Error(
                            `Executor exited before readiness (${info.text})${
                                info.tail ? `: ${info.tail}` : ''
                            }`,
                        ),
                    );
                }
                if (message.type !== 'ready') return;
                if (
                    typeof message.socketPath !== 'string' ||
                    path.dirname(message.socketPath) !== directory
                )
                    return finish(new Error('Executor advertised an invalid socket'));
                if (
                    typeof message.pid !== 'number' ||
                    !Number.isSafeInteger(message.pid) ||
                    message.pid < 1
                )
                    return finish(new Error('Executor PID unavailable'));
                if (
                    message.controlSocketPath !== undefined &&
                    (typeof message.controlSocketPath !== 'string' ||
                        path.dirname(message.controlSocketPath) !== directory)
                )
                    return finish(new Error('Executor advertised an invalid control socket'));
                const catalogRevision =
                    typeof message.catalogRevision === 'string' &&
                    /^[a-f0-9]{64}$/.test(message.catalogRevision)
                        ? message.catalogRevision
                        : undefined;
                finish(undefined, {
                    pid: message.pid,
                    socketPath: message.socketPath,
                    controlSocketPath: message.controlSocketPath as string | undefined,
                    catalogRevision,
                });
            };
            guardian.on('message', onMessage);
            guardian.once('error', onError);
            guardian.once('exit', onExit);
            guardian.once('spawn', () => {
                guardian.send(
                    {
                        type: 'initialize_guardian',
                        entry: path.resolve(options.entry),
                        env: filterExecutorEnv(options.env),
                        tmpBase: path.resolve(tmpdir()),
                        initialization: {
                            type: 'initialize',
                            directory,
                            secret,
                            authority: options.authority,
                            eligibleTaskIds: options.eligibleTaskIds ?? [],
                        },
                        stopTimeoutMs: stopTimeout,
                        killTimeoutMs: killTimeout,
                    },
                    (error) => {
                        if (error) finish(new Error('Executor initialization failed'));
                    },
                );
            });
        });
        return { ...ready, directory, secret, stop };
    } catch (error) {
        const result = await stop();
        if (!result.stopped)
            throw new Error('Executor startup failed and teardown is unconfirmed', {
                cause: error,
            });
        throw error;
    }
}

function describeExit(message: Record<string, unknown>): {
    abnormal: boolean;
    code: number | null;
    signal: string | null;
    tail: string;
    text: string;
} {
    const code = typeof message.code === 'number' ? message.code : null;
    const signal = typeof message.signal === 'string' ? message.signal.slice(0, 32) : null;
    const tail =
        typeof message.stderrTail === 'string'
            ? Buffer.from(message.stderrTail).subarray(-STDERR_TAIL_BYTES).toString('utf8')
            : '';
    return {
        abnormal: message.type === 'executor_failed' || code !== 0 || signal !== null,
        code,
        signal,
        tail,
        text: `code ${code ?? 'none'}, signal ${signal ?? 'none'}`,
    };
}
