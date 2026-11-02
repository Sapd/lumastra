// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import * as m from '$lib/paraglide/messages.js';

/** Empty string explicitly clears an email; absent leaves it unchanged. */
export const AdminUserEmailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .superRefine((email, ctx) => {
        if (email && (email.length > 254 || !z.email().safeParse(email).success)) {
            ctx.addIssue({ code: 'custom', message: m.admin_users_email_invalid() });
        }
    });

export const AdminUserEmailResponseSchema = z.object({
    user: z.object({ email: z.string().nullable().optional() }),
});
