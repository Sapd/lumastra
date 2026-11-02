// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';

// Return empty array — don't expose usernames publicly.
// Clients will show a manual username entry field instead of a user picker.
export const GET: RequestHandler = async () => {
    return json([]);
};
