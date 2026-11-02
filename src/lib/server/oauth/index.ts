// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OAuth 2.0 Device Authorization Grant Module
// Re-exports all OAuth-related services and utilities

export {
    generateAccessToken,
    verifyAccessToken,
    extractBearerToken,
    isDeviceAuthEnabled,
    type AccessTokenPayload,
    type ValidatedTokenPayload,
} from './jwt';

export {
    DeviceCodeService,
    getDeviceCodeService,
    normalizeUserCode,
    redactUserCode,
    type DeviceCodeRequest,
    type DeviceCodeResponse,
    type DeviceCodeRecord,
    type DeviceCodeStatus,
} from './device-code.service';

export {
    getDeviceGrantCapabilities,
    type DeviceGrantCapabilities,
} from './device-grant-capabilities';

export { getRegisteredDeviceRedirect } from './device-client-redirects';

export {
    DeviceSessionRevokedError,
    RefreshTokenService,
    getRefreshTokenService,
    type RefreshTokenRecord,
    type CreateRefreshTokenParams,
} from './refresh-token.service';

export {
    JellyfinPermissionsService,
    getJellyfinPermissionsService,
    type JellyfinUserPermissions,
    type PermissionCheckResult,
} from './jellyfin-permissions.service';

export {
    JellyfinTokenService,
    getJellyfinTokenService,
    type JellyfinDeviceToken,
    type CreateJellyfinTokenParams,
} from './jellyfin-token.service';

export {
    PatService,
    getPatService,
    flushPatUsage,
    type PatRecord,
    type ValidatedPat,
    type CreatePatParams,
    type PatListItem,
} from './pat.service';

export {
    ServiceTokenService,
    getServiceTokenService,
    type ServiceTokenRecord,
    type ValidatedServiceToken,
    type CreateServiceTokenParams,
    type ServiceTokenListItem,
} from './service-token.service';

export { PatUsageBatcher } from './pat-usage-batcher.js';
