// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * System → Instance (admin IA redesign, spec §3.4): `/admin/instance-profile`
 * and `/admin/licensing` merged into one page — both describe "what is this
 * install" (use-case profile, version/edition, license). Load/actions are a
 * straight merge of the two former routes' `+page.server.ts` files; field
 * names didn't collide so no namespacing was needed.
 */

import { denyUnlessAdmin } from '$lib/server/admin/admin-action-gate.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '@sveltejs/kit';
import { config, hasEmbeddingProvider } from '$lib/server/config.js';
import { isSonicEngineConfigured } from '$lib/server/services/sonic-embedding.service.js';
import { get as getConfigValue } from '$lib/server/config/config.service.js';
import { readInstanceProfileState } from '$lib/server/config/instance-profile-state.js';
import { pendingProfileUpdates, schemaBaseline } from '$lib/config/use-case-presets';
import { getDb } from '$lib/server/database/index.js';
import { getInstallUuid } from '$lib/server/database/queries/install-identity.queries.js';
import { auditLog, auditActorFromLocals } from '$lib/server/utils/audit-log.js';
import { Logger } from '$lib/server/utils/logger.js';
import { USE_CASE_PRESETS } from '$lib/config/use-case-presets';
import { bustAttentionCache } from '$lib/server/services/attention/attention-cache.js';
import {
    evaluateStoredUpdate,
    markSecurityReviewed,
    readUpdateState,
    unmarkSecurityReviewed,
} from '$lib/server/services/lumastra-update/check.js';
import { RELEASES_PAGE_URL } from '$lib/server/services/lumastra-update/github-releases.js';
import type { Actions, PageServerLoad } from './$types';

const logger = Logger.for('AdminInstance');

interface UpdateCheckView {
    checkedAt: string | null;
    lastErrorAt: string | null;
    comparable: boolean;
    latest: { version: string; url: string; publishedAt: string | null } | null;
    securityFixedIn: string | null;
    securityReviewed: string | null;
    failingSince: string | null;
}

// Canonical project repository — the AGPL §13 source offer (mirrors AboutModal).
const REPO_URL = 'https://github.com/Sapd/lumastra';

// The third-party attribution notices for the copyleft components bundled into /
// fetched by the image (Essentia AGPL, jellyfin-ffmpeg GPL, fpcalc, libvips, …).
// The same file is shipped in the image at the working directory (see Dockerfile).
// Read once and memoize — it never changes at runtime.
let cachedNotices: string | null | undefined;
async function loadThirdPartyNotices(): Promise<string | null> {
    if (cachedNotices !== undefined) return cachedNotices;
    try {
        cachedNotices = await readFile(join(process.cwd(), 'THIRD-PARTY-NOTICES.md'), 'utf8');
    } catch (error) {
        logger.warn('THIRD-PARTY-NOTICES.md not found on disk', error as Error);
        cachedNotices = null;
    }
    return cachedNotices;
}

export const load: PageServerLoad = async () => {
    // Install identity. Best-effort — it must never break this page.
    let installUuid: string | null = null;
    const sql = getDb();
    if (sql) {
        try {
            installUuid = await getInstallUuid(sql);
        } catch (error) {
            logger.warn('Could not resolve install UUID for instance page', error as Error);
        }
    }

    // What the daily update check last saw, compared with this build. Read
    // here rather than from the attention item so the page can also say
    // "up to date" and when it last asked.
    let updateCheck: UpdateCheckView | null = null;
    if (sql && config.UPDATE_CHECK_ENABLED) {
        try {
            const state = await readUpdateState(sql);
            const evaluation = evaluateStoredUpdate(state, {
                version: config.buildInfo.version,
                buildTime: config.buildInfo.buildTime,
            });
            updateCheck = {
                checkedAt: state.checkedAt,
                lastErrorAt: state.lastErrorAt,
                comparable: evaluation.comparable,
                latest: evaluation.latest,
                securityFixedIn: evaluation.securityFixedIn?.version ?? null,
                securityReviewed: evaluation.securityReviewed?.version ?? null,
                failingSince: state.failingSince,
            };
        } catch (error) {
            logger.warn('Could not read the update check state', error as Error);
        }
    }

    // The profile as POST /api/admin/instance-profile will see it: the
    // revision its form must send back, and what re-applying it today would
    // change because a release or a newly available capability moved what
    // the presets set.
    const profile = readInstanceProfileState();
    const profileCaps = {
        hasEmbeddings: hasEmbeddingProvider(),
        hasSonicEmbedder: isSonicEngineConfigured(),
    };
    const profileUpdates = pendingProfileUpdates(profile.applied, profileCaps, (key) => {
        const value = getConfigValue(key);
        return value === undefined || value === null ? schemaBaseline(key) : value;
    });

    return {
        // Instance profile (ex /admin/instance-profile)
        // Known ids only: one unknown id (hand-edited settings.json, a removed
        // preset) seeded into the tiles made every Preview and Apply a 422.
        selected: profile.useCases,
        landingPath: config.INSTANCE_LANDING_PATH,
        profileRevision: profile.revision,
        profileUpdates,
        capabilities: {
            // This page renders the instance use-case preset preview, while the
            // /api/admin/instance-profile endpoint applies the chosen preset.
            // Both compute capabilities.hasEmbeddings and must agree — unifying
            // on hasEmbeddingProvider() keeps the preview in sync with what
            // actually gets applied (a bare EMBEDDING_BASE_URL with no key is
            // not enough to embed).
            hasEmbeddings: hasEmbeddingProvider(),
            // Same answer the sonic stage's install gate uses: a sidecar URL, or
            // a working subprocess fallback (interpreter, embed.py, torch+msclap).
            hasSonicEmbedder: isSonicEngineConfigured(),
        },
        presets: Object.values(USE_CASE_PRESETS).map((p) => ({
            id: p.id,
            label: p.label,
            landingPath: p.landingPath,
        })),
        // Version and update check (ex /admin/licensing)
        appVersion: config.APP_VERSION,
        updateCheckEnabled: config.UPDATE_CHECK_ENABLED,
        updateCheck,
        releasesUrl: RELEASES_PAGE_URL,
        buildInfo: config.buildInfo,
        installUuid,
        // Off = no call to lumastra.org (the push relay token is not requested).
        licenseServerContactEnabled: config.LICENSE_SERVER_CONTACT_ENABLED,
        repoUrl: REPO_URL,
        licensingUrl: `${REPO_URL}/blob/HEAD/LICENSING.md`,
        noticesUrl: `${REPO_URL}/blob/HEAD/THIRD-PARTY-NOTICES.md`,
        thirdPartyNotices: await loadThirdPartyNotices(),
    };
};

/**
 * Shared body of the two review actions. Called only after `denyUnlessAdmin`.
 * Errors come back as `updateReviewError: true`; the page shows a localized
 * message.
 */
async function changeSecurityReview(
    request: Request,
    locals: App.Locals,
    mode: 'review' | 'unreview',
) {
    const sql = getDb();
    if (!sql) return fail(503, { updateReviewError: true });
    let version: ReturnType<FormData['get']>;
    try {
        version = (await request.formData()).get('version');
    } catch {
        return fail(400, { updateReviewError: true });
    }
    if (typeof version !== 'string' || version.length === 0 || version.length > 100) {
        return fail(400, { updateReviewError: true });
    }
    try {
        if (mode === 'review') {
            if (!(await markSecurityReviewed(sql, version))) {
                return fail(400, { updateReviewError: true });
            }
        } else {
            await unmarkSecurityReviewed(sql, version);
        }
    } catch (error) {
        logger.error('Failed to change a security release review', error as Error);
        return fail(500, { updateReviewError: true });
    }
    auditLog(
        mode === 'review' ? 'update-check.security-reviewed' : 'update-check.security-unreviewed',
        'lumastra-update',
        auditActorFromLocals(locals),
        { version, running: config.buildInfo.version },
    );
    // Best effort: the decision is saved; the notice follows within a derive cycle.
    try {
        await bustAttentionCache();
    } catch (error) {
        logger.warn('Could not refresh the attention cache', error as Error);
    }
    return { securityReviewChanged: version };
}

export const actions: Actions = {
    // "This security fix does not apply to us / we mitigated it": turns the
    // red, undismissable notice for THAT release (and older pending ones) into
    // the normal one. Admin only, audited, and only for a version the stored
    // list flags as a security release; a later security release is red again.
    // `unreviewSecurity` takes it back.
    reviewSecurity: async ({ request, locals }) => {
        const denied = denyUnlessAdmin(locals);
        if (denied) return denied;
        return changeSecurityReview(request, locals, 'review');
    },
    unreviewSecurity: async ({ request, locals }) => {
        const denied = denyUnlessAdmin(locals);
        if (denied) return denied;
        return changeSecurityReview(request, locals, 'unreview');
    },
};
