// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The list of commercial modules, as data.
 *
 * ## Why this is not in `$lib/server/licensing/entitlements.ts`
 *
 * Because the admin UI needs it. `MODULE_LABELS` on
 * `/admin/system/instance` was typed `Record<string, string>` and silently
 * missed `push` — the FIFTH registry in this codebase to forget a newly added
 * module, after the entitlement set, the proprietary verifier's known-module
 * set, and the two GDPR registries. Every one of those was a `string`-keyed
 * structure, and every one of them was fixed the same way: make the compiler
 * reject an incomplete list.
 *
 * A Svelte component cannot import from `$lib/server/**`, so the type had to
 * live somewhere client-safe before that fix was even expressible. This file
 * is that place: pure data, no imports, no runtime behaviour.
 * `$lib/server/licensing/entitlements.ts` re-exports `LicenseModule` from
 * here, so every existing import path keeps working.
 *
 * @module shared/license-modules
 */

/**
 * Every commercial module. Absence of a module ⇒ not licensed (free behaviour
 * applies).
 *
 * Resolved decision (2026-06-22):
 *   Community (free/AGPL): ALL AGPL-core features remain fully open.
 *   Pro: ai_assistant + branding_removal + jellyfin stream-cap removed.
 *   Enterprise: assessment + showcase + sso_enterprise.
 */
export const LICENSE_MODULES = [
    'jellyfin_compat', // /j API stream cap removed (freemium lever)
    'ai_assistant', // proprietary AI assistant
    'branding_removal', // white-label / hide "Lumastra" branding
    'assessment', // training assessment / certification module
    'showcase', // showcase kiosk preset
    'sso_enterprise', // enterprise SSO / seat management
    // 'push' gates a REMOTE service (the relay holds Apple's signing key and does
    // the entitlement check), not a local code path. That is why the entire push
    // subsystem ships AGPL in core while /j and the AI assistant had to move into
    // proprietary/: a local `if` can be deleted by an operator with source, a
    // remote refusal cannot. See the spec's licensing section.
    'push', // APNs delivery via the Lumastra-operated relay
] as const;

/** Optional commercial modules a license may unlock. */
export type LicenseModule = (typeof LICENSE_MODULES)[number];

/**
 * Operator-facing label per module, for the licence panel on
 * `/admin/system/instance`.
 *
 * ## Why this is here and not in the component
 *
 * Because `npm run typecheck` runs tsgo, and **tsgo does not check `.svelte`
 * files**. A `Record<LicenseModule, string>` written inside the component
 * reads as exhaustive but is enforced by nothing CI runs — `svelte-check`
 * would catch it and `svelte-check` is not in the typecheck path (it also
 * OOMs on this repo). Declared here, in a plain `.ts` module, the missing key
 * is a hard build failure, which is the entire point of the change: this was
 * the fifth registry to silently drop a newly added module and the fix has to
 * make the sixth impossible rather than merely fixed.
 *
 * English literals rather than Paraglide keys: these are proper nouns for
 * commercial SKUs, they appear on an admin-only screen, and the surrounding
 * licence panel is already untranslated.
 */
export const LICENSE_MODULE_LABELS: Record<LicenseModule, string> = {
    jellyfin_compat: '/j API (stream cap removed)',
    ai_assistant: 'AI Assistant',
    branding_removal: 'Branding / White-label removal',
    assessment: 'Assessment & Certification',
    showcase: 'Showcase preset',
    sso_enterprise: 'SSO / Seat management',
    push: 'Push Notifications (iOS)',
};

/**
 * Enterprise-tier modules — `LicenseRef-Lumastra-Enterprise` per LICENSING.md
 * §3.2, distinct from the Pro-tier modules (`jellyfin_compat`, `ai_assistant`,
 * `branding_removal`, `push`) the open-core admin UI otherwise offers.
 *
 * The licence panel on `/admin/system/instance` uses this to badge these
 * specifically as "Enterprise" rather than an unexplained dash when
 * unlicensed, so an open-core operator understands why they are unavailable
 * rather than reading it as a bug.
 */
export const ENTERPRISE_LICENSE_MODULES: ReadonlySet<LicenseModule> = new Set<LicenseModule>([
    'assessment',
    'showcase',
    'sso_enterprise',
]);
