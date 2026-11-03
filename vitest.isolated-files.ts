/**
 * Unit test files that run in their own process (Vitest `isolate: true`), in the
 * `unit-isolated` project. Everything else runs in the `unit` project with
 * `isolate: false` (workers are reused across files; vitest.shared-setup.ts
 * resets module and process state between files). A file belongs here only
 * for a reason below. Do not list files that merely fail after a polluter: fix
 * or list the polluter.
 */

/**
 * Process time zone. These switch `process.env.TZ`; Node/V8 cache the zone and its
 * DST tables per process, and flipping it in a reused worker made `new Date(...)`
 * DST arithmetic wrong (a spring-forward test got hour 2 instead of 3).
 */
const CHANGES_PROCESS_TIME_ZONE = [
    'src/lib/server/tasks/triggers.test.ts',
    'src/lib/shared/episode-availability.test.ts',
];

/**
 * Files that call `vi.resetModules()` and rebuild their own module graph. In a
 * reused worker, a dynamic import that is still in flight (from an earlier test of
 * the same file, or the last file) can land a module in the rebuilt graph with the
 * wrong env or mocks. Seen in oauth/rate-limit-strict-ip.test.ts (client-ip built
 * with an empty TRUSTED_PROXY_IPS although the test had stubbed it) and
 * watcher-native-status.test.ts (an env stub that was not undone); both failed in
 * roughly 1 of 10 full shared runs, and in none of 3 isolated runs. Isolating the
 * whole category is cheaper than finding which of them is next: ~110 of 2,860
 * files, a few seconds of extra process starts.
 */
const REBUILDS_ITS_OWN_MODULE_GRAPH = [
    'plugins/mal-watch-sync/pull-reverse-mapping.test.js',
    'plugins/trakt-watch-sync/auth-failed.test.ts',
    'plugins/trakt-watch-sync/index.test.ts',
    'plugins/trakt-watch-sync/push-idempotent.test.js',
    'plugins/trakt-watch-sync/redirect-guard.test.ts',
    'plugins/trakt-watch-sync/refresh-failures.test.ts',
    'src/lib/api/contract-reporter.test.ts',
    'src/lib/auth/clear-user-client-state.test.ts',
    'src/lib/client-diagnostics/web-reporter.test.ts',
    'src/lib/server/ai/voyage.test.ts',
    'src/lib/server/api/conformance-counter.test.ts',
    'src/lib/server/api/defs/admin/ops/system-metrics-ffmpeg.test.ts',
    'src/lib/server/api/defs/audit-actor-username.test.ts',
    'src/lib/server/auth/cookie-transport.test.ts',
    'src/lib/server/auth/livetv-policy.regression.test.ts',
    'src/lib/server/auth/locals-admin.warn.test.ts',
    'src/lib/server/cache/user-admin-cache.test.ts',
    'src/lib/server/cache/valkey-endpoints.test.ts',
    'src/lib/server/cache/valkey-get-failure-log.test.ts',
    'src/lib/server/cache/valkey-ha-fail-closed.test.ts',
    'src/lib/server/cache/valkey-hsetnx.test.ts',
    'src/lib/server/cache/valkey-sadd-bounded.test.ts',
    'src/lib/server/cache/valkey-url-log.test.ts',
    'src/lib/server/cache/valkey-zadd-bounded.test.ts',
    'src/lib/server/config.ai-key-placeholders.test.ts',
    'src/lib/server/config.device-auth-default.test.ts',
    'src/lib/server/config.embedding-provider.test.ts',
    'src/lib/server/config.holiday-default.test.ts',
    'src/lib/server/config.isolation-worker.test.ts',
    'src/lib/server/config.jellyfin-compat-flag.test.ts',
    'src/lib/server/config.oidc-login-available.test.ts',
    'src/lib/server/config.preview-max-per-user.test.ts',
    'src/lib/server/config.resource-class-defaults.test.ts',
    'src/lib/server/config.test.ts',
    'src/lib/server/config/config.service.master-key-backup.test.ts',
    'src/lib/server/crypto/master-key-backup-legacy.test.ts',
    'src/lib/server/crypto/master-key.test.ts',
    'src/lib/server/database/connection.test.ts',
    'src/lib/server/database/queries/audio-clusters.queries.test.ts',
    'src/lib/server/database/queries/music-quick-picks.queries.test.ts',
    'src/lib/server/embedding-provider-consumers.test.ts',
    'src/lib/server/enterprise/showcase/hls/showcase-transcode-cap.test.ts',
    'src/lib/server/jellyseerr.test.ts',
    'src/lib/server/oauth/streaming-session-ip-repro.test.ts',
    'src/lib/server/plugins/external/example-feature-plugin/index.test.ts',
    'src/lib/server/plugins/runtime/loader-hot-reload.test.ts',
    'src/lib/server/proprietary/licensing/init.test.ts',
    'src/lib/server/services/activity-feed.service.test.ts',
    'src/lib/server/services/attention/adapters.test.ts',
    'src/lib/server/services/audiobookshelf-direct-sessions.service.test.ts',
    'src/lib/server/services/essentia-analysis.service.test.ts',
    'src/lib/server/services/ffmpeg-transcode.service.audio-only-seek.test.ts',
    'src/lib/server/services/ffmpeg-transcode.service.cap-abort.test.ts',
    'src/lib/server/services/ffmpeg-transcode.service.copy-grid-seam.test.ts',
    'src/lib/server/services/ffmpeg-transcode.service.gop-seam.test.ts',
    'src/lib/server/services/ffmpeg-transcode.service.test.ts',
    'src/lib/server/services/initial-scan-status.service.test.ts',
    'src/lib/server/services/livetv/upstream-proxy.e2e.test.ts',
    'src/lib/server/services/livetv/xtream-client.test.ts',
    'src/lib/server/services/media-segments.service.test.ts',
    'src/lib/server/services/metadata-matching.service.test.ts',
    'src/lib/server/services/metadata-storage.service.test.ts',
    'src/lib/server/services/music-analysis-sidecar.service.sidecar.test.ts',
    'src/lib/server/services/notification-events.subscribe-gate.test.ts',
    'src/lib/server/services/playability.service.test.ts',
    'src/lib/server/services/security-self-check/config-rules.proxy-master-key-seam.test.ts',
    'src/lib/server/services/sonic-embedding.service.sidecar.test.ts',
    'src/lib/server/services/sonic-embedding.service.test.ts',
    'src/lib/server/services/transcoding/input-guard.test.ts',
    'src/lib/server/services/trickplay-generator.hwaccel-budget.test.ts',
    'src/lib/server/services/trickplay-storage.service.test.ts',
    'src/lib/server/tasks/builtin/native/__tests__/never-owned-media-gc.test.ts',
    'src/lib/server/tasks/builtin/native/__tests__/sonic-embedding-backfill-schedule.test.ts',
    'src/lib/server/tasks/builtin/native/__tests__/unavailable-media-retention.test.ts',
    'src/lib/server/tasks/builtin/native/integrations/jellyseerr.test.ts',
    'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-leadership.test.ts',
    'src/lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-native-status.test.ts',
    'src/lib/server/tasks/builtin/native/sonic-clustering.sidecar.test.ts',
    'src/lib/server/tasks/builtin/native/sonic-cpu-threads.test.ts',
    'src/lib/server/tasks/builtin/native/sonic-map-projection.sidecar.test.ts',
    'src/lib/server/tasks/context-primitives.test.ts',
    'src/lib/server/tasks/orchestrator-singleton.test.ts',
    'src/lib/server/tasks/orchestrator.test.ts',
    'src/lib/server/utils/client-ip.test.ts',
    'src/lib/services/sse/watch-state-sse.test.ts',
    'src/lib/stores/admin-show-advanced.store.test.ts',
    'src/lib/stores/modal-registry.store.test.ts',
    'src/lib/stores/notification-inbox.test.ts',
    'src/lib/stores/request-notifications-dismissal-keys.test.ts',
    'src/lib/stores/request-notifications-expiry.test.ts',
    'src/lib/stores/run-sse-bus.test.ts',
    'src/lib/stores/server-capabilities.store.test.ts',
    'src/lib/stores/user-events.test.ts',
    'src/routes/\\(proprietary\\)/j/Users/AuthenticateWithQuickConnect/body-cap.test.ts',
    'src/routes/api-docs/server.test.ts',
    'src/routes/api/health/__tests__/health.test.ts',
    'src/routes/api/v1/queues/queues.test.ts',
    'src/routes/api/v1/runs/history/runs-history.test.ts',
    'src/routes/api/v1/runs/runs.test.ts',
    'src/routes/api/v1/scheduler/scheduler.test.ts',
    'src/routes/api/v1/tasks/tasks.test.ts',
    'src/routes/auth/oidc/login/server.test.ts',
    'src/routes/oauth/rate-limit-strict-ip.test.ts',
    'src/task-runtime/index.test.ts',
    'src/task-runtime/lifecycle.test.ts',
    'src/task-runtime/web-lifecycle.test.ts',
];

// Entries are globs: escape ( ) [ ] that are part of a real path.
export const ISOLATED_UNIT_FILES: readonly string[] = [
    ...CHANGES_PROCESS_TIME_ZONE,
    ...REBUILDS_ITS_OWN_MODULE_GRAPH,
];
