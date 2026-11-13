// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/preferences — admin-only: persist the small set of curated
 * defaults offered on the first-run setup wizard's final step (instance name,
 * hardware transcoding, generation/privacy toggles).
 *
 * Writes through the same config service the admin Settings page uses. Strictly
 * whitelisted: only the keys below are accepted, and only fields present in the
 * body are written, so omitted toggles keep their current/default value.
 */

import { config } from '$lib/server/config.js';
import { normalizeLanguageTag } from '$lib/shared/metadata-language.js';
import * as m from '$lib/paraglide/messages.js';
import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { SETUP_PREFERENCE_KEYS } from '$lib/config/setup-preferences.js';
import { WIZARD_PREFERENCE_OVERLAP_KEYS } from '$lib/config/use-case-presets.js';
import { saveConfig, isEnvOverridden } from '$lib/server/config/config.service.js';
import { defaultActivitySharing } from '$lib/server/config/activity-sharing.js';
import { getDb } from '$lib/server/database/connection.js';
import { applyActivitySharingDefault } from '$lib/server/database/queries/activity-sharing.queries.js';
import { auditActor, auditLog } from '$lib/server/utils/audit-log.js';
import { isRecord, toBooleanOr, toStringOr } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/setup/preferences';

const GPU_VALUES = new Set(['none', 'nvenc', 'qsv', 'vaapi']);
const METADATA_VALUES = new Set(['central', 'alongside', 'alongside-prefer']);
const APP_NAME_MAX = 50;

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async (event) => {
        const { request } = event;
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body))
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);

        const updates: Record<string, unknown> = {};
        let languageError = false;

        // Instance name (string, 1–50 chars; ignored when blank so we never
        // overwrite the default with an empty value).
        if ('appName' in body) {
            const name = toStringOr(body.appName, '').trim();
            if (name) {
                if (name.length > APP_NAME_MAX) {
                    return ApiResponses.badRequest(
                        `Instance name must be ${APP_NAME_MAX} characters or fewer`,
                        undefined,
                        ENDPOINT,
                    );
                }
                updates[SETUP_PREFERENCE_KEYS.appName] = name;
            }
        }

        // Hardware transcoding (select; restricted to the values onboarding can
        // recommend, plus 'none' for the off state).
        if ('gpuAcceleration' in body) {
            const accel = toStringOr(body.gpuAcceleration, '').trim();
            if (!GPU_VALUES.has(accel)) {
                return ApiResponses.badRequest(
                    'Invalid GPU acceleration value',
                    undefined,
                    ENDPOINT,
                );
            }
            updates[SETUP_PREFERENCE_KEYS.gpuAcceleration] = accel;
        }

        // Generated-metadata storage location (select).
        if ('metadataStorageLocation' in body) {
            const loc = toStringOr(body.metadataStorageLocation, '').trim();
            if (!METADATA_VALUES.has(loc)) {
                return ApiResponses.badRequest(
                    'Invalid metadata storage location',
                    undefined,
                    ENDPOINT,
                );
            }
            updates[SETUP_PREFERENCE_KEYS.metadataStorageLocation] = loc;
        }

        // Primary TMDB metadata language (BCP-47 tag, e.g. 'en-US'). Ignored when
        // blank so we never overwrite the TMDB_LANGUAGE default with an empty
        // value — the wizard prefills this from the operator's UI locale, but a
        // deliberately-cleared field should leave the effective configuration in place.
        if ('tmdbLanguage' in body && !isEnvOverridden('TMDB_LANGUAGE')) {
            const raw = body.tmdbLanguage;
            if (
                raw != null &&
                (typeof raw !== 'string' || raw.trim()) &&
                (typeof raw !== 'string' || raw.trim() !== config.TMDB_LANGUAGE.trim())
            ) {
                const lang = typeof raw === 'string' ? normalizeLanguageTag(raw) : null;
                if (lang) updates.TMDB_LANGUAGE = lang;
                else languageError = true;
            }
        }

        // Additional metadata languages (comma-separated BCP-47 tags) — same
        // shape the admin Settings page's ArrayInput submits. Format/maxItems
        // validation (languageTags rule, max 3) lives in `validateSettingValue`
        // (src/lib/config/schema.ts) and is enforced by `saveConfig` below —
        // deliberately NOT duplicated here. Ignored when blank so an untouched
        // field doesn't write an empty array over an existing value.
        if ('metadataAdditionalLanguages' in body) {
            const langs = toStringOr(body.metadataAdditionalLanguages, '').trim();
            if (langs) {
                updates.METADATA_ADDITIONAL_LANGUAGES = langs;
            }
        }

        // Boolean toggles.
        if ('trickplayEnabled' in body) {
            updates[SETUP_PREFERENCE_KEYS.trickplayEnabled] = toBooleanOr(
                body.trickplayEnabled,
                false,
            );
        }
        if ('autoLyrics' in body) {
            updates[SETUP_PREFERENCE_KEYS.autoLyrics] = toBooleanOr(body.autoLyrics, true);
        }
        if ('introAnalyzer' in body) {
            updates[SETUP_PREFERENCE_KEYS.introAnalyzer] = toBooleanOr(body.introAnalyzer, true);
        }
        if ('gravatar' in body) {
            updates[SETUP_PREFERENCE_KEYS.gravatar] = toBooleanOr(body.gravatar, false);
        }
        if ('unratedContentVisible' in body) {
            updates[SETUP_PREFERENCE_KEYS.unratedContentVisible] = toBooleanOr(
                body.unratedContentVisible,
                false,
            );
        }
        if ('defaultActivitySharing' in body) {
            if (typeof body.defaultActivitySharing !== 'boolean') {
                return ApiResponses.badRequest(
                    'Invalid activity sharing default',
                    undefined,
                    ENDPOINT,
                );
            }
            updates[SETUP_PREFERENCE_KEYS.defaultActivitySharing] = body.defaultActivitySharing;
        }
        if ('shareActivityBetweenUsers' in body) {
            // The one setup preference that decides what users can see about EACH
            // OTHER, so it is disclosed at first run rather than left to discovery.
            // A fresh install has no groups, so `auto` resolves to the household
            // audience — everyone. `groups` with no group named is the dark state,
            // which is what "off" has to mean here.
            //
            // Fallback is `auto`, matching the schema default: a malformed value
            // must not silently change what the operator saw described on the
            // wizard. Turning this off does NOT touch anyone's own sharing
            // switches; it narrows the audience, and each user still controls
            // their own visibility under Settings → Privacy.
            const shareOn = toBooleanOr(body.shareActivityBetweenUsers, true);
            updates[SETUP_PREFERENCE_KEYS.shareActivityBetweenUsers] = shareOn ? 'auto' : 'groups';

            // ...and Active Streams, which this toggle did NOT cover until now.
            //
            // The toggle is labelled with what users can see about each other,
            // but it only ever wrote SOCIAL_DEFAULT_AUDIENCE — so an operator
            // who turned it OFF still shipped an install where every user sees
            // every other user's live stream, with title and progress, via
            // FEATURE_SESSIONS_PUBLIC (default true). social-sharing.md calls
            // that "the single most consequential privacy switch on the
            // instance"; leaving it outside the one control that names the
            // question made the disclosure untrue rather than merely partial.
            //
            // **Only written on the OFF path, and the asymmetry is deliberate.**
            //
            // Making it symmetric would mean an operator who deliberately set
            // FEATURE_SESSIONS_PUBLIC=false on the Playback settings page gets
            // it silently flipped back ON by re-running setup for some unrelated
            // reason. Between two silent failures — under-sharing (streams stay
            // hidden when the operator expected them back) and over-sharing
            // (streams become public when the operator never asked) — only the
            // first is safe, so the toggle turns this OFF but never ON.
            //
            // The cost is real and must stay visible in the copy: after an
            // OFF → ON cycle across two setup runs, sharing reads as on while
            // live streams stay hidden. `setup_pref_share_activity_desc` states
            // that turning it back on does NOT restore them, and points at the
            // Playback page. If that sentence is ever "simplified" away, this
            // becomes a silent trap — the flag is one-way from here.
            if (!shareOn) {
                updates.FEATURE_SESSIONS_PUBLIC = false;
            }
        }
        if ('showUnavailableMedia' in body) {
            // Fallback mirrors the SHOW_UNAVAILABLE_MEDIA default (false) — a
            // malformed value must not opt the install into the storefront.
            updates[SETUP_PREFERENCE_KEYS.showUnavailableMedia] = toBooleanOr(
                body.showUnavailableMedia,
                false,
            );
        }
        if ('jellyfinCompat' in body) {
            // Fallback mirrors the real FEATURE_JELLYFIN_COMPAT default (true) — a
            // malformed/non-boolean value must not silently disable the /j surface.
            updates[SETUP_PREFERENCE_KEYS.jellyfinCompat] = toBooleanOr(body.jellyfinCompat, true);
        }
        if ('subsonicCompat' in body) {
            // Fallback mirrors the real FEATURE_SUBSONIC_COMPAT default (false) —
            // the wizard only ever sends this key when the operator explicitly
            // toggled it, so a malformed value should not silently enable it.
            updates[SETUP_PREFERENCE_KEYS.subsonicCompat] = toBooleanOr(body.subsonicCompat, false);
        }
        if ('publicApi' in body) {
            // Public API (/api/v1 token surface + OAuth device flow) — what the
            // native iPhone/iPad/Apple TV apps sign in through. Fallback mirrors
            // the FEATURE_DEVICE_AUTH default (true): a malformed value must not
            // silently lock the native apps out of a fresh install. Symmetric
            // (unlike shareActivityBetweenUsers' one-way write): the toggle is
            // hydrated from the effective value, so re-running setup untouched
            // writes back what is already in force.
            updates[SETUP_PREFERENCE_KEYS.publicApi] = toBooleanOr(body.publicApi, true);
        }
        if (typeof body.licenseServerContact === 'boolean') {
            // The push relay token request to lumastra.org. Only a real boolean
            // is written: this is a privacy opt-out, so a malformed value must
            // neither turn it back on nor off — it keeps what is in force.
            // Symmetric: the wizard hydrates the toggle from the effective
            // value on every run, like publicApi.
            updates[SETUP_PREFERENCE_KEYS.licenseServerContact] = body.licenseServerContact;
        }
        // OIDC back-channel logout cascade — only offered in the wizard when OIDC is
        // already enabled. Harmless to accept regardless: it's a no-op unless a
        // back-channel logout arrives, which requires OIDC.
        if ('backchannelLogoutCascade' in body) {
            updates[SETUP_PREFERENCE_KEYS.backchannelLogoutCascade] = toBooleanOr(
                body.backchannelLogoutCascade,
                false,
            );
        }

        if (Object.keys(updates).length === 0) {
            if (languageError)
                return ApiResponses.badRequest(m.setup_metadata_lang_error(), undefined, ENDPOINT);
            return json({ saved: false });
        }

        // The keys the use-case projection also sets are the operator's
        // explicit answer here: keep them in settings.json even when they equal
        // today's default, as the projection does, so a later release changing
        // that default cannot undo the answer (or the profile's pin before it).
        const pinKeys: string[] = WIZARD_PREFERENCE_OVERLAP_KEYS.filter((k) => k in updates);
        // The contact answer is kept even when it is the default (on): a stored
        // answer is what lets a new install make its first call to lumastra.org
        // (relay-token-enrol.ts waits for it).
        if (SETUP_PREFERENCE_KEYS.licenseServerContact in updates) {
            pinKeys.push(SETUP_PREFERENCE_KEYS.licenseServerContact);
        }
        if (pinKeys.length > 0) await saveConfig(updates, { pinKeys });
        else await saveConfig(updates);

        if (SETUP_PREFERENCE_KEYS.defaultActivitySharing in updates) {
            // The owner is created before this step. Apply the effective saved
            // default to never-set accounts, preserving all explicit choices.
            const sql = getDb();
            if (!sql) return ApiResponses.serviceUnavailable('Database', undefined, ENDPOINT);
            const sharing = defaultActivitySharing();
            const changedCount = await applyActivitySharingDefault(sql, sharing);
            auditLog('users.apply_activity_sharing_default', 'users', auditActor(event), {
                sharing,
                changedCount,
                source: 'setup',
            });
        }
        // A bad language is reported, but it must not discard the valid toggles
        // from the same request. The operator can correct just that field.
        if (languageError)
            return ApiResponses.badRequest(
                `${m.setup_metadata_other_prefs_saved()} ${m.setup_metadata_lang_error()}`,
                undefined,
                ENDPOINT,
            );
        return json({ saved: true, keys: Object.keys(updates) });
    }),
);
