// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
    return new Response(null, { status: 404 });
};
