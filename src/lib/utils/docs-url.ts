// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one deliberate seam between the admin UI and the published docs at
 * lumastra.org. Every app→docs link goes through `docsUrl()` so the whole app
 * tags its referrals identically (`?ref=app&v=<version>`) and so the origin
 * lives in exactly one place if it ever moves.
 *
 * Two rules this module exists to enforce:
 *
 * 1. **A doc link may deepen an answer, never be the answer.** Self-hosted
 *    installs are frequently offline; the "what do I do about it" sentence
 *    must already be on the screen before one of these links is added next to
 *    it. Treat a UI where the link is the only explanation as a bug.
 * 2. **Never emit a bare lumastra.org URL inside a message string.** Two
 *    server modules still do that in prose (`system-metrics.ts`,
 *    `transcode-failure-classifier.ts`); those links are untagged, unclickable
 *    and invisible to this module. Don't grow that pattern — render a real
 *    anchor built here instead.
 *
 * Version source: `version` from `$app/environment` is SvelteKit's build-time
 * version string, baked into both the server and client bundles, so it needs
 * no page data, no store and no component context — which is what lets this
 * stay a plain `docsUrl(path)` function callable from module scope. It is
 * `config.kit.version.name` from `svelte.config.js`, i.e. `APP_VERSION` with a
 * `-<buildTimestamp>` suffix appended to bust the client's version-poll cache;
 * that suffix is a build artifact rather than a release identity, so it is
 * stripped here to leave the same string `config.APP_VERSION` reports.
 */

import { version } from '$app/environment';

/** Public docs site. Origin only — paths are passed to `docsUrl()`. */
export const DOCS_ORIGIN = 'https://lumastra.org';

const APP_VERSION = version.replace(/-\d+$/, '');

/** The task-system debugging guide. */
export const TASK_TROUBLESHOOTING_PATH = 'guides/task-troubleshooting/';

/**
 * Anchors into the troubleshooting guide, by symptom.
 *
 * The slugs double-hyphen because the published headings read
 * "Recipe 1 — Stuck items panel shows entries": the em-dash is dropped and the
 * spaces on either side of it each become a hyphen. They are verified against
 * the live page — do not "tidy" a double hyphen into a single one.
 */
export const TASK_TROUBLESHOOTING = {
    stuckItems: `${TASK_TROUBLESHOOTING_PATH}#recipe-1--stuck-items-panel-shows-entries`,
    queueNotDraining: `${TASK_TROUBLESHOOTING_PATH}#recipe-2--queue-not-draining`,
    runStuckActive: `${TASK_TROUBLESHOOTING_PATH}#recipe-3--run-stuck-in-active-with-stale-heartbeat`,
    pendingPileUp: `${TASK_TROUBLESHOOTING_PATH}#recipe-4--pending-pile-up-orphans-vs-legitimate-backlog`,
    workerNotPickingUp: `${TASK_TROUBLESHOOTING_PATH}#recipe-5--worker-not-picking-up-jobs`,
    stageRowWedged: `${TASK_TROUBLESHOOTING_PATH}#recipe-8--stage-row-stuck-at-running-wedged`,
    itemSkipsStage: `${TASK_TROUBLESHOOTING_PATH}#recipe-9--item-never-goes-through-a-stage`,
} as const;

/**
 * Absolute URL to a page on the docs site.
 *
 * `path` is site-relative and may carry a `#fragment` (and, rarely, a query of
 * its own). The tracking params are inserted before the fragment, since a
 * fragment must be last for the browser to scroll to it.
 *
 * @example docsUrl(TASK_TROUBLESHOOTING.stuckItems)
 * // https://lumastra.org/guides/task-troubleshooting/?ref=app&v=1.2.3#recipe-1--stuck-items-panel-shows-entries
 */
export function docsUrl(path: string): string {
    const relative = path.replace(/^\/+/, '');
    const hashAt = relative.indexOf('#');
    const fragment = hashAt === -1 ? '' : relative.slice(hashAt);
    const beforeFragment = hashAt === -1 ? relative : relative.slice(0, hashAt);
    const separator = beforeFragment.includes('?') ? '&' : '?';
    return `${DOCS_ORIGIN}/${beforeFragment}${separator}ref=app&v=${encodeURIComponent(APP_VERSION)}${fragment}`;
}
