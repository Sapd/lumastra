// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// scripts/openapi/accepted-drift.ts
//
// ACCEPTED-DRIFT ALLOWLIST for the OpenAPI drift checker.
//
// PURPOSE
// -------
// `generate-public.ts`'s `chooseSlot()` KEEPS the hand-authored `_openapi.ts`
// value (rather than sourcing the slot from the runtime def) whenever letting the
// def win would LOSE a documented contract detail (a key, a required flag, or a
// per-key enum/min/max/format/…). Each such case emits a "KEPT … reconcile in
// cleanup phase" note. Most of those notes are NOT real drift to fix: the def is
// intentionally a lenient/partial mount-gate (shared POST+DELETE body slot,
// coerce-number path params, clamp-by-design image params, lenient partial-update
// PUT, or a discriminated union the superset detector cannot compare against a
// plain union) and the HANDLER re-validates. Reporting them every run as
// "reconcile in cleanup phase" drowns out genuinely-new drift.
//
// Each row below was individually adjudicated by the E1 KEPT-Endpoint Decision
// Table (internal, 2026-07-23) — grounded against the
// def's handler code, the query modules/DB it feeds, and the tvOS client contract.
// A row here means: "this KEPT note is a PERMANENT, verified false-alarm; print it
// as ACCEPTED-DRIFT and keep it OUT of the pending-reconcile tally." A row is
// keyed by {method, path, slot} (slot = which request slot drifts: body/query/
// params). `verdict` is the E1 decision-table row number; `reason` is the short
// justification from that verdict.
//
// This allowlist is REPORT-ONLY. It changes NOTHING about spec generation — the
// KEPT slot still keeps `_openapi.ts` verbatim, so `docs/api/api-v1.yaml` stays
// byte-identical. It only reclassifies how the checker REPORTS these rows.
//
// A KEPT row NOT listed here still reports loudly (that is the whole point — new
// drift must stand out). If a listed row ever stops drifting (or never matched),
// the checker flags it as a STALE allowlist entry so this file can be pruned.

/** Request slot that drifted, matching `chooseSlot`'s slot name. */
export type DriftSlot = 'query' | 'body' | 'params';

export interface AcceptedDriftEntry {
    /** HTTP method (uppercase), e.g. 'DELETE'. */
    method: string;
    /** OpenAPI path with `{param}` templating, e.g. '/api/v1/devices'. */
    path: string;
    /** Which request slot the KEPT note is about. */
    slot: DriftSlot;
    /** E1 decision-table row number. */
    verdict: number;
    /** Short justification (why keeping `_openapi.ts` is correct/permanent). */
    reason: string;
}

/**
 * The 19 E1-adjudicated permanent KEPT rows. EXACTLY the current authoritative
 * KEPT set (`npm run openapi:check`) as of 2026-07-23. Do not hand-add rows:
 * every entry must correspond to a live KEPT note AND an E1 verdict.
 */
export const ACCEPTED_DRIFT: readonly AcceptedDriftEntry[] = [
    {
        method: 'POST',
        path: '/api/v1/devices/{id}/heartbeat',
        slot: 'body',
        verdict: 5,
        reason: 'Gate deliberately accepts any string; the handler coerces a non-enum deviceType to `unknown` before the DB. Doc advertises the canonical vocabulary.',
    },
    {
        method: 'GET',
        path: '/api/v1/media/{id}/images/{role}',
        slot: 'query',
        verdict: 22,
        reason: 'Handler ignores the query and clamps width/quality from the URL by design (parseImageQuality); nothing unclamped reaches processing or the cache. Doc advertises the canonical bounds.',
    },
    {
        method: 'GET',
        path: '/api/v1/people/{id}/images/{role}',
        slot: 'query',
        verdict: 26,
        reason: 'Same clamp-by-design as media images — out-of-range quality is ignored before processing.',
    },
    {
        method: 'POST',
        path: '/api/v1/playlists/{id}/invite',
        slot: 'params',
        verdict: 27,
        reason: 'Param gate is z.coerce.number().int().positive() — stricter in practice than the doc string minLength:1 (empty coerces to 0 → rejected); the detector cannot compare coerce-number vs string-minLength.',
    },
    {
        method: 'GET',
        path: '/api/v1/playlists/{id}/playback-context',
        slot: 'params',
        verdict: 33,
        reason: 'Coerce-number param gate stricter than the doc string minLength:1 (see verdict #27).',
    },
    {
        method: 'GET',
        path: '/api/v1/playlists/{id}/progress',
        slot: 'params',
        verdict: 34,
        reason: 'Coerce-number param gate stricter than the doc string minLength:1 (see verdict #27).',
    },
    {
        method: 'PATCH',
        path: '/api/v1/me/playback-preferences',
        slot: 'body',
        verdict: 45,
        reason: 'Gate PlaybackPrefsBodyLenient is deliberately loose so the doc schema’s "at least one field" refine cannot 422 a valid sparse partial-update PATCH; the handler re-validates + normalizes post-mount. (E1 FIX-BOTH: the doc converges later; the KEPT drift is expected until then.)',
    },
    {
        method: 'POST',
        path: '/api/v1/watchlist',
        slot: 'body',
        verdict: 48,
        reason: 'Shared POST/DELETE body slot; the handler enforces title-for-POST itself and normalizes the legacy `tv` alias + `media_type` key. Doc stays canonical ["movie","series"].',
    },
    {
        method: 'DELETE',
        path: '/api/v1/watchlist',
        slot: 'body',
        verdict: 49,
        reason: 'Same shared POST/DELETE body slot as verdict #48.',
    },
    {
        method: 'PUT',
        path: '/api/v1/webhooks/{id}',
        slot: 'body',
        verdict: 50,
        reason: 'Gate WebhookUpdateSchema.partial() is a lenient superset shared with DELETE’s empty body; the PUT handler re-validates against the strict full-replace schema and 422s missing url/eventFilter.',
    },
];

/** Stable lookup key for a {method, path, slot} triple. */
export function driftKey(method: string, path: string, slot: DriftSlot): string {
    return `${method.toUpperCase()} ${path} :: ${slot}`;
}

const ACCEPTED_DRIFT_BY_KEY: ReadonlyMap<string, AcceptedDriftEntry> = new Map(
    ACCEPTED_DRIFT.map((entry) => [driftKey(entry.method, entry.path, entry.slot), entry]),
);

/**
 * Return the allowlist entry for a KEPT row, or `undefined` if the row is NOT
 * allowlisted (and must therefore report loudly as pending-reconcile drift).
 */
export function lookupAcceptedDrift(
    method: string,
    path: string,
    slot: DriftSlot,
): AcceptedDriftEntry | undefined {
    return ACCEPTED_DRIFT_BY_KEY.get(driftKey(method, path, slot));
}
