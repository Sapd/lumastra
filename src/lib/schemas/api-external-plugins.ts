// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Declared capability metadata — cooperative, NOT a sandbox. Unknown keys pass through. */
export const ExternalPluginCapabilitiesSchema = z
    .object({
        allowedDomains: z.array(z.string()).optional(),
        database: z.boolean().optional(),
    })
    .passthrough();
export type ExternalPluginCapabilities = z.infer<typeof ExternalPluginCapabilitiesSchema>;

export const ExternalPluginSigningKeySourceSchema = z.enum(['official', 'operator', 'unknown']);

export const ExternalPluginListItemSchema = z.object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    kind: z.string().optional(),
    /**
     * How this plugin got here.
     *
     * `registry` — installed through the signed flow, has an `external_plugins`
     * row, and supports enable/disable/uninstall.
     * `drop-in` — a directory placed on disk with no row. READ-ONLY: the
     * lifecycle endpoints look a row up and 404 without one, so the UI must
     * withhold those controls rather than offer failure.
     * `bundled` — shipped inside the image ($PLUGINS_BUNDLED_DIR): first-party,
     * current with the image, also read-only (no row).
     *
     * Optional for back-compat; absent reads as `registry`.
     */
    source: z.enum(['registry', 'drop-in', 'bundled']).optional(),
    /**
     * Bundled only: a same-named copy also sits in the plugins volume. The
     * loader ignores it (the bundled copy wins); it is safe to delete.
     */
    shadowedCopy: z.boolean().optional(),
    enabled: z.boolean(),
    status: z.enum(['installed', 'uninstalled']),
    loaded: z.boolean(),
    error: z.string().optional(),
    restartRequired: z.boolean(),
    capabilities: ExternalPluginCapabilitiesSchema.optional(),
    /**
     * Contract ABI the plugin was built against. Absent for a registry-less
     * drop-in; a row installed before the column existed reports 1.
     */
    sdkAbi: z.number().int().positive().optional(),
    /**
     * Signed catalog metadata the publisher declared. Absent when the manifest
     * carried none — the UI must say "not declared" rather than showing a
     * blank that reads like an empty value the publisher chose.
     */
    manifestMetadata: z
        .object({
            publisher: z.string().optional(),
            description: z.string().optional(),
            license: z.string().optional(),
            sourceUrl: z.string().optional(),
            minAppVersion: z.string().optional(),
            releasedAt: z.string().optional(),
            capabilities: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
    signingKeyId: z.string().optional(),
    signingKeySource: ExternalPluginSigningKeySourceSchema.optional(),
    isBundle: z.boolean(),
    bundleInvalid: z.boolean(),
    installedAt: z.string(),
    updatedAt: z.string(),
});
export type ExternalPluginListItem = z.infer<typeof ExternalPluginListItemSchema>;

// NOTE: Do NOT add an `ExternalPluginListResultSchema` here. There is no internal
// GET list route (spec §3.3 defers it), and the page load (Task 8) returns its
// fields loose, not wrapped. The ONLY `ExternalPluginListResult` shape in this
// work is the manager's interface `{ items, trustedKeysConfigured }` (Task 3 /
// spec §3.1). Spec §3.6 names exactly 7 schemas — a `{plugins,…}` wrapper here
// would be dead code AND a same-named/different-shape collision with the
// manager type. If the deferred GET twin is ever built, add it there as
// `ExternalPluginAdminListResponseSchema` with the `{items, trustedKeysConfigured}`
// shape so only one `ExternalPluginListResult` exists.

// ── lifecycle / install result schemas (client-side validation, Task 7) ──

const InstallDescriptor = z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional(),
    kind: z.string().optional(),
    enabled: z.boolean().optional(),
    status: z.enum(['installed', 'uninstalled']).optional(),
    loaded: z.boolean().optional(),
    error: z.string().optional(),
    restartRequired: z.boolean().optional(),
    signingKeyId: z.string().optional(),
    signingKeySource: z.enum(['official', 'operator']).optional(),
});
/** installer returns InstallResultBody OR { error } — union covers both. */
export const ExternalPluginInstallResultSchema = z.union([
    InstallDescriptor,
    z.object({ error: z.string() }),
]);
export type ExternalPluginInstallResult = z.infer<typeof ExternalPluginInstallResultSchema>;

/**
 * Dry-run install result (`POST /api/admin/plugins/external/preview`).
 *
 * Every field here is the HOST's verdict, not the manifest's claim — most
 * importantly `signingKeyId`, which is the trusted key that cryptographically
 * matched. A preview that echoed the manifest back would be worse than no
 * preview: it would look like verification while confirming nothing.
 */
export const ExternalPluginPreviewSchema = z.union([
    z.object({
        name: z.string(),
        version: z.string(),
        kinds: z.array(z.string()),
        sdkAbi: z.number(),
        signingKeyId: z.string(),
        signingKeySource: z.enum(['official', 'operator']),
        metadata: z.record(z.string(), z.unknown()).nullable(),
        mode: z.string(),
        /** Present only when this would replace an existing install. */
        installedVersion: z.string().optional(),
        /** Why installing WOULD fail. Null means it would proceed. */
        blockedReason: z.string().nullable(),
    }),
    z.object({ error: z.string() }),
]);
export type ExternalPluginPreview = z.infer<typeof ExternalPluginPreviewSchema>;

export const ExternalPluginEnableResultSchema = z.object({
    id: z.string(),
    enabled: z.literal(true),
    loaded: z.boolean(),
    error: z.string().optional(),
    restartRequired: z.boolean(),
});
export type ExternalPluginEnableResult = z.infer<typeof ExternalPluginEnableResultSchema>;

export const ExternalPluginDisableResultSchema = z.object({
    id: z.string(),
    enabled: z.literal(false),
    restartRequired: z.literal(true),
});
export type ExternalPluginDisableResult = z.infer<typeof ExternalPluginDisableResultSchema>;

export const ExternalPluginReloadResultSchema = z.object({
    id: z.string(),
    reloaded: z.boolean(),
    version: z.string().optional(), // present ONLY on the hot-load branch
    restartRequired: z.boolean(),
});
export type ExternalPluginReloadResult = z.infer<typeof ExternalPluginReloadResultSchema>;

export const ExternalPluginUninstallResultSchema = z.object({
    id: z.string(),
    uninstalled: z.literal(true),
    restartRequired: z.literal(true),
    warning: z.string().optional(), // present ONLY on the soft-500 dir-removal failure
});
export type ExternalPluginUninstallResult = z.infer<typeof ExternalPluginUninstallResultSchema>;
