// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Development user override utility
// Only works in development mode for testing different user contexts
// SECURITY: In production, always uses authenticated user from headers

import { dev } from '$app/environment';
import { config } from './config.js';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('DevUser');

// SECURITY: Use SvelteKit's build-time `dev` flag (from $app/environment) rather
// than process.env.NODE_ENV. The build-time flag is statically false in production
// builds regardless of how NODE_ENV is set at runtime, preventing this bypass
// from being accidentally enabled in a production container.
const isDevelopment = dev;

export function getEffectiveUser(request: Request, authenticatedUser: string | null): string {
    // SECURITY: Only allow dev overrides in explicit development mode
    // If NODE_ENV is unset, missing, or anything other than 'development', use authenticated user only
    if (!isDevelopment) {
        return authenticatedUser || 'anonymous';
    }

    // DEVELOPMENT ONLY: Allow user switching via cookies for testing
    const cookies = request.headers.get('cookie');

    if (cookies) {
        const devUserMatch = cookies.match(/devUser=([^;]+)/);
        if (devUserMatch) {
            const devUser = decodeURIComponent(devUserMatch[1]);
            logger.debug('Dev user override', {
                from: authenticatedUser,
                to: devUser,
            });
            return devUser;
        }
    }

    // Fallback to authenticated user in development too
    return authenticatedUser || config.DEFAULT_USER;
}
