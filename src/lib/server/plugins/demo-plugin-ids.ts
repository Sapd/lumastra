// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Dummy"/"(demo)" reference plugin ids — shipped as SDK examples, always
 * self-register at boot regardless of runtime env (see
 * `src/lib/server/tasks/builtin/index.ts`; their `PLUGIN_DUMMY*_ENABLED`
 * config only gates route/webhook behavior, not registry presence).
 *
 * Admin IA redesign (spec §3.6/§3.7): excluded from production builds at
 * the presentation layer everywhere the registry is listed — Settings →
 * Plugins & features (curated) and Developer → Registry (raw). Gated on
 * `devFeaturesEnabled`, NOT on the "Show developer tools" admin toggle:
 * a production deployment with dev tools switched on for troubleshooting
 * should still never see these.
 */

export const DEMO_FEATURE_IDS = new Set(['dummy']);
export const DEMO_INTEGRATION_IDS = new Set(['dummy-integration']);
/** `dummy-sync` — the tutorial exemplar TASK (see builtin/index.ts's `coreModules`). */
export const DEMO_TASK_IDS = new Set(['dummy-sync']);
