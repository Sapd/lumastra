// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standalone multi-user access control — Zod schemas (single source of truth).
 *
 * Backs the in-app identity & access layer (access_groups + group→capability map +
 * user_access_groups membership). Drives the `/admin/access` UI and the
 * `/api/admin/access/*` routes. Types are inferred via `z.infer<>` — never
 * hand-write a parallel interface.
 */

import { z } from 'zod';

/**
 * Capability vocabulary — mirrors `UserPermissions`. Boolean caps grant a flag;
 * `max_age_rating` and `livetv_priority` are parameterized via `value`.
 */
export const AccessCapabilitySchema = z
    .enum([
        'admin',
        'watch',
        'livetv',
        'requests',
        'moderator',
        'livetv_high_priority',
        'max_age_rating',
        'arr_manager',
    ])
    .describe('In-app capability flag granted by an access group');
export type AccessCapability = z.infer<typeof AccessCapabilitySchema>;

/**
 * Maximum age rating an admin can set on a `max_age_rating` capability. Mirrors
 * the highest meaningful certification age; anything higher is functionally
 * "unrestricted" so we cap input to a sane ceiling rather than accept arbitrary
 * integers.
 */
export const MAX_AGE_RATING_CEILING = 21;

/**
 * The ONLY parameterized capability is `max_age_rating` (numeric 0..ceiling).
 * Every other capability is a pure boolean flag — a `value` on those is silently
 * ignored downstream, so reject it at the boundary to stop an admin believing
 * they configured something that does nothing (e.g. a `livetv_priority`-style
 * typo). `max_age_rating` MUST carry a valid integer value.
 */
export const AccessGroupCapabilitySchema = z
    .object({
        capability: AccessCapabilitySchema,
        value: z
            .string()
            .nullable()
            .optional()
            .describe(
                'Parameterized value: numeric 0..21 for max_age_rating; rejected on boolean caps',
            ),
    })
    .superRefine((cap, ctx) => {
        if (cap.capability === 'max_age_rating') {
            if (cap.value === undefined || cap.value === null || cap.value.trim() === '') {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['value'],
                    message: 'max_age_rating requires a numeric value',
                });
                return;
            }
            const n = Number(cap.value);
            if (!Number.isInteger(n) || n < 0 || n > MAX_AGE_RATING_CEILING) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['value'],
                    message: `max_age_rating value must be an integer between 0 and ${MAX_AGE_RATING_CEILING}`,
                });
            }
        } else if (cap.value !== undefined && cap.value !== null) {
            // Boolean caps must not carry a value (it is ignored downstream).
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['value'],
                message: `capability '${cap.capability}' is a boolean flag and does not accept a value`,
            });
        }
    });
export type AccessGroupCapability = z.infer<typeof AccessGroupCapabilitySchema>;

export const AccessGroupSchema = z.object({
    id: z.string().guid().describe('Access group UUID'),
    name: z.string().describe('Unique case-insensitive group name (effective group name)'),
    displayName: z.string().describe('Human-readable label'),
    description: z.string().nullable().optional().describe('Optional description'),
    isSystem: z.boolean().describe('System groups cannot be renamed or deleted'),
    memberCount: z.number().int().nonnegative().describe('Number of assigned users'),
    capabilities: z.array(AccessGroupCapabilitySchema).describe('Capabilities granted by group'),
    createdAt: z.string().describe('ISO timestamp'),
    updatedAt: z.string().describe('ISO timestamp'),
});
export type AccessGroup = z.infer<typeof AccessGroupSchema>;

export const AccessGroupsListResponseSchema = z.object({
    groups: z.array(AccessGroupSchema),
});
export type AccessGroupsListResponse = z.infer<typeof AccessGroupsListResponseSchema>;

export const AccessGroupResponseSchema = z.object({
    group: AccessGroupSchema,
});
export type AccessGroupResponse = z.infer<typeof AccessGroupResponseSchema>;

export const CreateAccessGroupBodySchema = z.object({
    name: z.string().trim().min(1).max(64).describe('Unique case-insensitive group name'),
    displayName: z.string().trim().min(1).max(128).optional().describe('Human-readable label'),
    description: z.string().trim().max(512).nullable().optional(),
    capabilities: z
        .array(AccessGroupCapabilitySchema)
        .optional()
        .describe('Initial capabilities; defaults to none'),
});
export type CreateAccessGroupBody = z.infer<typeof CreateAccessGroupBodySchema>;

export const UpdateAccessGroupBodySchema = z.object({
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(512).nullable().optional(),
    capabilities: z
        .array(AccessGroupCapabilitySchema)
        .optional()
        .describe('Full replacement set of capabilities when present'),
});
export type UpdateAccessGroupBody = z.infer<typeof UpdateAccessGroupBodySchema>;

export const AccessGroupMemberSchema = z.object({
    userId: z.string().guid(),
    username: z.string(),
    displayName: z.string().nullable().optional(),
    assignedAt: z.string().describe('ISO timestamp'),
    assignedBy: z.string().guid().nullable().optional(),
});
export type AccessGroupMember = z.infer<typeof AccessGroupMemberSchema>;

export const AccessGroupMembersResponseSchema = z.object({
    members: z.array(AccessGroupMemberSchema),
});
export type AccessGroupMembersResponse = z.infer<typeof AccessGroupMembersResponseSchema>;

export const AddAccessGroupMemberBodySchema = z.object({
    userId: z.string().guid().describe('users.id of the user to add'),
});
export type AddAccessGroupMemberBody = z.infer<typeof AddAccessGroupMemberBodySchema>;

export const RemoveAccessGroupMemberBodySchema = z.object({
    userId: z.string().guid().describe('users.id of the user to remove'),
});
export type RemoveAccessGroupMemberBody = z.infer<typeof RemoveAccessGroupMemberBodySchema>;
