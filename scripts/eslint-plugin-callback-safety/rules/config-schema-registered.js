// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: config-schema-registered
 *
 * Enforces that every config key accessed via getString/getBool/getNumber/
 * getFloat/getArray/getConfig in config.ts is registered in schema.ts.
 *
 * This prevents silent drift where a new config key is wired up in config.ts
 * but never appears in the admin settings UI because it has no schema entry.
 *
 * To add a new config key:
 * 1. Add the getter call in src/lib/server/config.ts
 * 2. Add a SettingDefinition entry in src/lib/config/schema.ts
 *
 * If the key is infrastructure-only (never shown in admin UI), add it to
 * ENV_ONLY_KEYS below.
 */

const fs = require('fs');
const path = require('path');

// Keys that are intentionally infrastructure-only and have no admin UI entry.
const ENV_ONLY_KEYS = new Set([
    'BASE_PATH',
    'CACHE_URL',
    'DATABASE_URL',
    // Download-rendition infrastructure knobs. The cache DIRECTORY is a
    // container path an operator sets alongside the volume mount, not something
    // to retype in a web form (a wrong value here silently strands artifacts on
    // the wrong filesystem). STALE_SECONDS is the cross-replica takeover
    // threshold — an internal correctness bound tied to ffmpeg's progress
    // cadence, not a preference. The knobs that ARE operator decisions
    // (FEATURE_DOWNLOAD_RENDITIONS, cache size cap, encode concurrency) are
    // registered in schema.ts and appear in admin settings.
    'DOWNLOAD_RENDITION_CACHE_DIR',
    'DOWNLOAD_RENDITION_STALE_SECONDS',
    // Multi-file external-plugin bundle caps — non-secret resource knobs read
    // LIVE from process.env (NOT part of the trust gate; they only bound
    // size/count, never grant trust). Kept ENV-only (not ConfigService-schema
    // registered) so a late env change takes effect deterministically and they
    // are never snapshotted at ConfigService init. Callers: config.ts
    // PLUGIN_INSTALL_MAX_* getters → bundle-limits.ts bundleLimitsFromConfig().
    'PLUGIN_INSTALL_MAX_EXTRACTED_BYTES',
    'PLUGIN_INSTALL_MAX_ENTRIES',
    'PLUGIN_INSTALL_MAX_FILE_BYTES',
    // Pipeline event outbox is turn-on-only and not normally user-toggled;
    // see config.ts docstring. Flipping OFF needs runbook acknowledgement
    // (manual stage_state row reset), so it lives outside the admin UI.
    'FEATURE_PIPELINE_EVENT_OUTBOX',
    // Wave 8.5 Phase 1 flag — per-task BullMQ queues. Infrastructure-only;
    // operators flip via env after preprod soak per the design doc rollout
    // plan. No need for admin UI exposure (it's a one-way migration).
    'FEATURE_PER_TASK_QUEUES',
    // Shared queue connection (Wave 8.5+ connection consolidation). Infrastructure-only;
    // operators flip via env after preprod validation; no admin UI knob,
    // same as FEATURE_PER_TASK_QUEUES.
    'FEATURE_SHARED_QUEUE_CONNECTION',
    // Plugin worker-thread isolation — infrastructure flag + tuning knobs.
    // Operators flip via env after the preprod soak per the rollout plan; no admin
    // UI knob, same as FEATURE_PER_TASK_QUEUES.
    'FEATURE_PLUGIN_WORKER_ISOLATION',
    'LUMASTRA_ISOLATION_DB_POOL_MAX',
    'LUMASTRA_ISOLATION_TERMINATE_GRACE_MS',
    'LUMASTRA_ISOLATION_ENTRY_PATH',
    // Isolation worker V8 resourceLimits (host-OOM guard) — infra tuning knobs,
    // same family as the other LUMASTRA_ISOLATION_* keys; no admin UI.
    'LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB',
    'LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB',
    'LUMASTRA_ISOLATION_WORKER_STACK_MB',
    'HOSTNAME',
    'INSTANCE_ID',
    'JWT_SECRET',
    'NODE_ENV',
    'PIPELINE_COVERAGE_AUTHORITATIVE_STAGES',
    'PORT',
    'STREAM_PROXY_MODE',
    // Per-node identity flag set by the dedicated-worker entrypoint
    // (start-worker.sh). Must come from each container's own env, never from the
    // cluster-shared stored config — same rationale as STREAM_PROXY_MODE. Affects
    // node-role labeling only (deriveNodeRole → 'worker' vs 'general').
    'DEDICATED_WORKER',
    // Pipeline event-outbox dispatcher throughput tuning — infrastructure-only
    // knobs (drain interval / batch size / per-drain budget). Operators tune via
    // env for an import-heavy install; not a user-facing setting.
    'LUMASTRA_OUTBOX_DRAIN_INTERVAL_MS',
    'LUMASTRA_OUTBOX_DRAIN_BATCH_SIZE',
    'LUMASTRA_OUTBOX_DRAIN_BUDGET_MS',
    'LUMASTRA_OUTBOX_DRAIN_CONCURRENCY',
    // Sonic-embedder sidecar URL + worker paths / tuning — set per-deployment, not user-facing.
    // SONIC_EMBEDDER_URL selects the HTTP sidecar vs subprocess path; the rest are
    // path-like knobs that control where Python/scripts live in the container.
    // SONIC_ANALYZE_URL is the /analyze sidecar base URL (defaults to SONIC_EMBEDDER_URL);
    // infrastructure-only, never user-facing — the engine selector MUSIC_ANALYSIS_ENGINE
    // is the schema-registered, admin-facing knob.
    'SONIC_EMBEDDER_URL',
    'SONIC_ANALYZE_URL',
    // Sidecar concurrency cap — infrastructure tuning knob, not user-facing (see
    // config.ts docstring). Callers: essentia-analysis.service.ts sidecar semaphore.
    'MUSIC_ANALYSIS_SIDECAR_CONCURRENCY',
    'SONIC_EMBEDDER_PYTHON',
    'SONIC_EMBEDDER_SCRIPT',
    'SONIC_EMBEDDER_TEXT_SCRIPT',
    'SONIC_MAP_PROJECTION_SCRIPT',
    'SONIC_CLUSTER_SCRIPT',
    'SONIC_CLUSTER_K',
    'SONIC_EMBEDDER_BATCH_SIZE',
    // In-app upload configuration — deployment-scoped limits set per-environment
    // in Docker/env; not surfaced in the admin UI settings page.
    'MAX_VIDEO_UPLOAD_GB',
    'MAX_RESOURCE_UPLOAD_MB',
    'MAX_SUBTITLE_UPLOAD_MB',
    'MAX_CHAPTER_UPLOAD_MB',
    'UPLOAD_CHUNK_SIZE_MB',
    'UPLOAD_STAGING_DIR',
    'LIBRARY_ALLOWED_ROOTS',
]);

// Config getter function names and which argument index holds the key.
// getString('KEY', default) → key at index 0
// getConfig('section', 'KEY', default) → key at index 1
const GETTER_KEY_ARG = {
    getString: 0,
    getBool: 0,
    getNumber: 0,
    getFloat: 0,
    getArray: 0,
    getConfig: 1,
};

function loadSchemaKeys(configFilePath) {
    const schemaPath = path.resolve(path.dirname(configFilePath), '../../lib/config/schema.ts');
    let src;
    try {
        src = fs.readFileSync(schemaPath, 'utf8');
    } catch {
        // If schema.ts cannot be read, skip validation (e.g. during init)
        return null;
    }
    const keys = new Set();
    const re = /\bkey:\s*['"]([A-Z][A-Z0-9_]*)['"],/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        keys.add(m[1]);
    }
    return keys;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require every config.ts getter key to be registered in schema.ts',
            category: 'Best Practices',
            recommended: true,
        },
        schema: [],
        messages: {
            unregistered:
                "Config key '{{key}}' is not registered in src/lib/config/schema.ts. " +
                'Add a SettingDefinition entry so it appears in the admin UI, ' +
                "or add it to ENV_ONLY_KEYS in the lint rule if it's infrastructure-only.",
        },
    },
    create(context) {
        // Only run this rule on config.ts
        const filename = context.filename ?? context.getFilename?.() ?? '';
        if (!filename.endsWith('server/config.ts')) {
            return {};
        }

        const schemaKeys = loadSchemaKeys(filename);
        if (schemaKeys === null) {
            // Could not load schema — skip silently
            return {};
        }

        return {
            CallExpression(node) {
                const callee = node.callee;

                // Match bare function calls: getString('KEY', ...) or
                // member calls: helpers.getString('KEY', ...)
                let fnName = null;
                if (callee.type === 'Identifier') {
                    fnName = callee.name;
                } else if (
                    callee.type === 'MemberExpression' &&
                    callee.property.type === 'Identifier'
                ) {
                    fnName = callee.property.name;
                }

                if (!fnName || !(fnName in GETTER_KEY_ARG)) return;

                const argIndex = GETTER_KEY_ARG[fnName];
                const keyArg = node.arguments[argIndex];
                if (!keyArg || keyArg.type !== 'Literal') return;

                const key = String(keyArg.value);
                if (!key || !/^[A-Z][A-Z0-9_]*$/.test(key)) return;

                if (ENV_ONLY_KEYS.has(key) || schemaKeys.has(key)) return;

                context.report({
                    node: keyArg,
                    messageId: 'unregistered',
                    data: { key },
                });
            },
        };
    },
};
