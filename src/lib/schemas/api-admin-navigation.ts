// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';

/** Max stored group-name length. Long enough for any real Authentik group. */
export const NAV_GROUP_MAX_LENGTH = 128;

export const AddNavGroupBodySchema = z
    .object({
        group: z
            .string()
            .min(1)
            .max(NAV_GROUP_MAX_LENGTH)
            .describe('Group name to add to the navigation permission list'),
    })
    .meta({
        id: 'AddNavGroupBody',
        description: 'Request body for adding a navigation permission group',
    });

export type AddNavGroupBody = z.infer<typeof AddNavGroupBodySchema>;

/** Bare object — no success wrapper. Errors use application/problem+json. */
export const AddNavGroupResponseSchema = z
    .object({
        availableGroups: z
            .array(z.string())
            .describe('Full merged list of selectable permission groups after the add'),
        persisted: z
            .boolean()
            .describe('False when config storage is read-only and the change is in-memory only'),
    })
    .meta({
        id: 'AddNavGroupResponse',
        description: 'Response after adding a navigation permission group',
    });

export type AddNavGroupResponse = z.infer<typeof AddNavGroupResponseSchema>;

// ============================================================================
// Homepage reset-widgets
// ============================================================================

/** POST /api/admin/homepage/reset-widgets → bare { resetCount } */
export const HomepageResetWidgetsResponseSchema = z
    .object({
        resetCount: z.number().int().describe('Number of per-user widget-order rows deleted'),
    })
    .meta({
        id: 'HomepageResetWidgetsResponse',
        description: "Response after resetting all users' homepage widget orders to admin defaults",
    });

export type HomepageResetWidgetsResponse = z.infer<typeof HomepageResetWidgetsResponseSchema>;

// ============================================================================
// Instance profile
// ============================================================================

const InstanceProfileDiffEntrySchema = z.object({
    key: z.string(),
    from: z.unknown(),
    to: z.unknown(),
    /** The current value was changed since the last apply; applying replaces it. */
    overridesChange: z.literal(true).optional(),
    /** The profile sets this key now but did not when it was last applied (a later release). */
    newInProfile: z.literal(true).optional(),
    /** An environment variable owns this key: applying will not change it. */
    envLocked: z.literal(true).optional(),
});

/**
 * POST /api/admin/instance-profile → bare object.
 * Live run: { applied, primaryMode, landingPath }
 * Dry-run:  { preview: true, diff, primaryMode, landingPath, libraryTypes }
 */
export const InstanceProfileResponseSchema = z
    .object({
        /** Present and true on dry-run responses. */
        preview: z.literal(true).optional(),
        /** Config diff entries (dry-run only). */
        diff: z.array(InstanceProfileDiffEntrySchema).optional(),
        /** The resolved primary mode (a PrimaryMode value). */
        primaryMode: z.string(),
        /** The resolved landing path for this profile. */
        landingPath: z.string(),
        /** Library types activated (dry-run only). */
        libraryTypes: z.array(z.string()).optional(),
        /** The config keys actually written (live run only). */
        applied: z.record(z.string(), z.unknown()).optional(),
        /** Keys the profile wanted to change that an environment variable owns (live run). */
        envLocked: z.array(z.string()).optional(),
        /** Written keys that replaced a value changed since the last apply (live run). */
        overridden: z.array(z.string()).optional(),
        /** Library types that could not be activated (live run). */
        libraryTypesNotActivated: z.array(z.string()).optional(),
        /** Revision of the profile this apply recorded; send it as expectedRevision next time (live run). */
        revision: z.string().optional(),
    })
    .meta({
        id: 'InstanceProfileResponse',
        description: 'Response after applying or previewing an instance profile',
    });

export type InstanceProfileResponse = z.infer<typeof InstanceProfileResponseSchema>;
export type InstanceProfileDiffEntry = z.infer<typeof InstanceProfileDiffEntrySchema>;
