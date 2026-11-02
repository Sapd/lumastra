// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from '@sveltejs/kit';
import { mount } from '$lib/server/api/mount.js';
import { auditDeviceApprovalFailure } from '$lib/server/oauth/device-approval-audit.js';
import { def } from '$lib/server/api/defs/oauth/device/approve.js';

// authz: mounted — mount(def) enforces media:write; the def requires a full user OAuth bearer.
// V1-only hand mount: the browser's CSRF-protected approval stays separate.
const mounted = mount(def, { surface: 'v1' });
function noStore(handler: RequestHandler): RequestHandler {
    return async (event) => {
        const response = await handler(event);
        response.headers.set('Cache-Control', 'no-store');
        await auditDeviceApprovalFailure(event, response);
        return response;
    };
}
export const GET = noStore(mounted.GET!);
export const POST = noStore(mounted.POST!);
