// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The provider lists /Auth/Providers and /Auth/PasswordResetProviders answer.
 * Names and ids are Jellyfin's defaults (`Name`, and the provider's .NET type
 * name as `Id`); the ids must match what `serializeUser` reports in
 * `Policy.AuthenticationProviderId` / `PasswordResetProviderId`, because admin
 * screens select the user's provider from this list by id.
 */

import type { JellyfinNameIdPair } from './types';

export const AUTH_PROVIDERS: readonly JellyfinNameIdPair[] = [
    {
        Name: 'Default',
        Id: 'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
    },
];

export const PASSWORD_RESET_PROVIDERS: readonly JellyfinNameIdPair[] = [
    {
        Name: 'Default Password Reset Provider',
        Id: 'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
    },
];
