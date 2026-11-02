// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV API domain module
 *
 * Typed functions for LiveTV source management (admin).
 */

import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import {
    LiveTvSourcesListResponseSchema,
    LiveTvSourceResponseSchema,
    ImportTriggerResponseSchema,
    RefreshResultSchema,
    RefreshTriggerResponseSchema,
    SetupSummarySchema,
    SetupResultSchema,
    ProxyStatusResponseSchema,
    LayoutImportResponseSchema,
    SourceDeletedResponseSchema,
    ProxyCancelledResponseSchema,
    ProxyReconnectedResponseSchema,
    type LiveTvSourcesListResponse,
    type LiveTvSourceResponse,
    type CreateLiveTvSource,
    type UpdateLiveTvSource,
    type RefreshResult,
    type SetupSummary,
    type SetupPreferencesInput,
    type SetupResultResponse,
    type ProxyStatusResponse,
    type ChannelLayout,
    type LayoutImportResponse,
    type SourceDeletedResponse,
    type ProxyCancelledResponse,
    type ProxyReconnectedResponse,
} from '$lib/schemas/livetv.js';
import type { ApiResult } from './types.js';

// =========================================================================
// Sources
// =========================================================================

// Credential validation plus two sequential guarded feed probes can exceed the
// normal request budget. Do not abandon a setup request while it is still saving.
const SOURCE_SETUP_TIMEOUT_MS = 150_000;

export function getLiveTvSources(): Promise<ApiResult<LiveTvSourcesListResponse>> {
    return apiGet('/api/admin/livetv/sources', LiveTvSourcesListResponseSchema);
}

export function createLiveTvSource(
    data: CreateLiveTvSource,
): Promise<ApiResult<LiveTvSourceResponse>> {
    return apiPost('/api/admin/livetv/sources', LiveTvSourceResponseSchema, data, {
        timeout: SOURCE_SETUP_TIMEOUT_MS,
    });
}

export function updateLiveTvSource(
    sourceId: string,
    data: UpdateLiveTvSource,
): Promise<ApiResult<LiveTvSourceResponse>> {
    return apiPut(`/api/admin/livetv/sources/${sourceId}`, LiveTvSourceResponseSchema, data, {
        timeout: SOURCE_SETUP_TIMEOUT_MS,
    });
}

export function deleteLiveTvSource(sourceId: string): Promise<ApiResult<SourceDeletedResponse>> {
    return apiDelete(`/api/admin/livetv/sources/${sourceId}`, SourceDeletedResponseSchema);
}

export function triggerLiveTvImport(
    sourceId: string,
): Promise<ApiResult<{ taskIds: { m3u: string; epg?: string } }>> {
    return apiPost(`/api/admin/livetv/sources/${sourceId}/import`, ImportTriggerResponseSchema, {});
}

// =========================================================================
// Xtream Credential Validation
// =========================================================================

const ValidateXtreamResponseSchema = z.object({
    valid: z.boolean(),
    reason: z.string().optional(),
    serverInfo: z
        .object({
            serverName: z.string().optional(),
            expiresAt: z.string().optional(),
            maxConnections: z.number().optional(),
        })
        .optional(),
});

// =========================================================================
// Guided Setup
// =========================================================================

export function getSetupSummary(sourceId: string): Promise<ApiResult<SetupSummary>> {
    return apiGet(`/api/admin/livetv/sources/${sourceId}/setup`, SetupSummarySchema);
}

export function applySetupPreferences(
    sourceId: string,
    preferences: SetupPreferencesInput,
): Promise<ApiResult<SetupResultResponse>> {
    return apiPost(`/api/admin/livetv/sources/${sourceId}/setup`, SetupResultSchema, preferences);
}

// =========================================================================
// Refresh
// =========================================================================

export function triggerRefresh(sourceId: string): Promise<ApiResult<{ taskId: string }>> {
    return apiPost(
        `/api/admin/livetv/sources/${sourceId}/refresh`,
        RefreshTriggerResponseSchema,
        {},
    );
}

export function getRefreshResult(sourceId: string): Promise<
    ApiResult<{
        lastRefreshAt?: string;
        lastRefreshStatus?: string;
        lastRefreshSummary?: RefreshResult;
    }>
> {
    return apiGet(
        `/api/admin/livetv/sources/${sourceId}/refresh`,
        z.object({
            lastRefreshAt: z.string().optional(),
            lastRefreshStatus: z.string().optional(),
            lastRefreshSummary: RefreshResultSchema.optional(),
        }),
    );
}

// =========================================================================
// HDHomeRun Device Validation
// =========================================================================

const ValidateHdHomeRunResponseSchema = z.object({
    valid: z.boolean(),
    reason: z.string().optional(),
    deviceInfo: z
        .object({
            friendlyName: z.string().optional(),
            modelNumber: z.string().optional(),
            deviceId: z.string().optional(),
            tunerCount: z.number().optional(),
        })
        .optional(),
});

export function validateHdHomeRunApi(data: { deviceIp: string }): Promise<
    ApiResult<{
        valid: boolean;
        reason?: string;
        deviceInfo?: {
            friendlyName?: string;
            modelNumber?: string;
            deviceId?: string;
            tunerCount?: number;
        };
    }>
> {
    return apiPost(
        '/api/admin/livetv/sources/validate-hdhomerun',
        ValidateHdHomeRunResponseSchema,
        data,
    );
}

export function validateXtreamCredentialsApi(data: {
    serverUrl: string;
    username: string;
    password: string;
}): Promise<
    ApiResult<{
        valid: boolean;
        reason?: string;
        serverInfo?: {
            serverName?: string;
            expiresAt?: string;
            maxConnections?: number;
        };
    }>
> {
    return apiPost('/api/admin/livetv/sources/validate-xtream', ValidateXtreamResponseSchema, data);
}

// =========================================================================
// Proxy Dashboard (Story 5.4)
// =========================================================================

export function getProxyStatus(): Promise<ApiResult<ProxyStatusResponse>> {
    return apiGet('/api/admin/livetv/proxy/status', ProxyStatusResponseSchema);
}

export function killProxyConnection(
    channelId: string,
    viewerId?: string,
): Promise<ApiResult<ProxyCancelledResponse>> {
    // Canonical path is "cancel" (the legacy "kill" route is retired).
    return apiPost('/api/admin/livetv/proxy/cancel', ProxyCancelledResponseSchema, {
        channelId,
        viewerId,
    });
}

export function reconnectProxy(channelId: string): Promise<ApiResult<ProxyReconnectedResponse>> {
    return apiPost('/api/admin/livetv/proxy/reconnect', ProxyReconnectedResponseSchema, {
        channelId,
    });
}

/**
 * Re-apply a previously exported channel layout (ordering, categories, visibility,
 * renames) to the current provider's channels by fuzzy name matching.
 */
export function importLiveTvLayout(
    layout: ChannelLayout,
): Promise<ApiResult<LayoutImportResponse>> {
    return apiPost('/api/admin/livetv/layout/import', LayoutImportResponseSchema, layout);
}
