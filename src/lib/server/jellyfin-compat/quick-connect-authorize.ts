// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Approve a pending Quick Connect code for a user: the step the web app's
 * "Quick Connect" dialog performs (`/api/jellyfin-connect/quick-connect/
 * authorize`) and that a signed-in Jellyfin app performs through
 * `POST /QuickConnect/Authorize`. The device that showed the code then
 * completes `/Users/AuthenticateWithQuickConnect` and gets its own session.
 *
 * The approving user's identity is stored on the pending request; the session
 * minted from it is re-checked against the account (disabled/deleted) by
 * createSession, as for every Quick Connect login.
 */

import { validateSession } from './auth';
import type { RequestEvent } from '@sveltejs/kit';
import { cacheGet } from '$lib/server/cache/valkey';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { QC_CODE_PREFIX, QC_SECRET_PREFIX } from './quick-connect-utils';
import { updateQuickConnectRequest } from './quick-connect-store';
import type { QuickConnectData } from './quick-connect-utils';

export interface QuickConnectApprover {
    userId: string;
    username: string;
    isAdmin: boolean;
    groups: string[];
    displayName: string | null;
}

export type QuickConnectAuthorizeResult = 'ok' | 'not_found' | 'already_authorized';

/**
 * Rate-limit key for approving a code, shared by the web app's approve endpoint
 * and `POST /j/QuickConnect/Authorize`: one per-user budget (security review
 * C13), so neither a second route nor a rotating client address buys more
 * guesses at the 6-digit code.
 */
export function quickConnectAuthorizeRateLimitKey(event: RequestEvent): string {
    return `qc:authorize:${event.locals.user?.username ?? getClientIpStrict(event)}`;
}

/** Codes are the 6 digits /QuickConnect/Initiate hands out. */
export function isQuickConnectCode(code: string): boolean {
    return /^\d{6}$/.test(code);
}

export async function authorizeQuickConnectCode(
    code: string,
    approver: QuickConnectApprover,
    approvedBySessionToken?: string,
): Promise<QuickConnectAuthorizeResult> {
    if (!isQuickConnectCode(code)) return 'not_found';
    if (approvedBySessionToken) {
        const session = await validateSession(approvedBySessionToken);
        if (!session || session.userId !== approver.userId || session.origin === 'quick_connect')
            return 'not_found';
    }
    const secret = await cacheGet(QC_CODE_PREFIX + code);
    if (!secret) return 'not_found';
    const raw = await cacheGet(QC_SECRET_PREFIX + secret);
    if (!raw) return 'not_found';

    let data: QuickConnectData;
    try {
        data = JSON.parse(raw) as QuickConnectData;
    } catch {
        return 'not_found';
    }
    if (data.code !== code) return 'not_found';
    if (data.authenticated) return 'already_authorized';

    const updated: QuickConnectData = {
        ...data,
        approvedBySessionToken,
        authenticated: true,
        userId: approver.userId,
        username: approver.username,
        isAdmin: approver.isAdmin,
        groups: approver.groups,
        displayName: approver.displayName,
    };
    if (!(await updateQuickConnectRequest(code, secret, raw, JSON.stringify(updated)))) {
        return 'not_found';
    }
    return 'ok';
}
