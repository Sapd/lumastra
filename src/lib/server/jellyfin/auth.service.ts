// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Authentication Service
 * Handles Quick Connect authentication and token validation
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type { JellyfinAuthOptions } from '$lib/server/jellyfin/auth-headers.js';
import { JellyfinBaseClient } from './base-client.js';
import { config } from '../config.js';

type QuickConnectInitiateResponse = {
    Code?: string;
    Secret?: string;
};

type QuickConnectAuthResponse = {
    AccessToken?: string;
    User?: { Id: string; Name: string };
    ServerId?: string;
};

type JellyfinUserResponse = {
    Id?: string;
    Name?: string;
};

const getAxiosStatus = (error: unknown): number | undefined => {
    if (!error || typeof error !== 'object') return undefined;
    const response = (error as { response?: { status?: unknown } }).response;
    return typeof response?.status === 'number' ? response.status : undefined;
};

export class JellyfinAuthService extends JellyfinBaseClient {
    constructor() {
        super('JellyfinAuth');
    }

    async quickConnect(code: string, userId: string): Promise<number> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured for quick connect');
            return 1;
        }
        try {
            this.logger.debug('Attempting quick connect', {
                codeLength: code.length,
                userId,
            });

            // Ensure code is a string and trim whitespace
            const cleanCode = String(code).trim();

            // Try the correct Jellyfin API format - code as query parameter
            const response = await this.api!.axiosInstance.post(
                joinUpstreamUrl(
                    this.api!.basePath,
                    `/QuickConnect/Authorize?code=${encodeURIComponent(cleanCode)}&userId=${encodeURIComponent(userId)}`,
                ),
                {}, // Empty body
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );
            this.logger.info('Quick connect successful', {
                status: response.status,
            });
            return 0;
        } catch (error) {
            const axiosError = error as {
                message?: string;
                response?: {
                    status?: number;
                    statusText?: string;
                    data?: unknown;
                };
            };
            this.logger.error('Failed quick connect', undefined, {
                message: axiosError.message,
                status: axiosError.response?.status,
                statusText: axiosError.response?.statusText,
                data: axiosError.response?.data,
            });
            return 1;
        }
    }

    /**
     * Initiate a Quick Connect session
     * Returns a code that users can enter in Jellyfin, and a secret for polling
     */
    async initiateQuickConnect(): Promise<{
        Code: string;
        Secret: string;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.post<QuickConnectInitiateResponse>(
                joinUpstreamUrl(this.api!.basePath, `/QuickConnect/Initiate`),
                null,
                {
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            if (response.data?.Code && response.data?.Secret) {
                return {
                    Code: response.data.Code,
                    Secret: response.data.Secret,
                };
            }

            this.logger.error('Quick Connect initiate returned unexpected data', undefined, {
                data: response.data,
            });
            return null;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to initiate Quick Connect', undefined, {
                message: err.message,
            });
            return null;
        }
    }

    /**
     * Authorize a Quick Connect code for a specific user (admin operation)
     * This uses the admin API key to approve the code on behalf of the user
     */
    async authorizeQuickConnect(code: string, userId: string): Promise<boolean> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return false;
        }

        try {
            // The authorize endpoint needs to be called as the user who will receive the token
            // We use the admin token but specify the userId
            const response = await this.api!.axiosInstance.post(
                joinUpstreamUrl(this.api!.basePath, `/QuickConnect/Authorize`),
                null,
                {
                    params: {
                        Code: code,
                        UserId: userId,
                    },
                    headers: buildJellyfinAuthHeaders({ token: this.api!.accessToken }),
                },
            );

            // 200 OK means success
            return response.status === 200;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to authorize Quick Connect', undefined, {
                message: err.message,
            });
            return false;
        }
    }

    /**
     * Connect using a Quick Connect secret to get an access token
     * Call this after the code has been authorized
     */
    async connectQuickConnect(secret: string): Promise<{
        AccessToken: string;
        User?: { Id: string; Name: string };
        ServerId?: string;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.post<QuickConnectAuthResponse>(
                joinUpstreamUrl(this.api!.basePath, `/Users/AuthenticateWithQuickConnect`),
                { Secret: secret },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        ...buildJellyfinAuthHeaders({
                            deviceId: `${config.APP_NAME.toLowerCase()}-quickconnect`,
                            token: null,
                        }),
                    },
                },
            );

            if (response.data?.AccessToken) {
                return {
                    AccessToken: response.data.AccessToken,
                    User: response.data.User,
                    ServerId: response.data.ServerId,
                };
            }

            this.logger.error('Quick Connect auth returned unexpected data', undefined, {
                data: response.data,
            });
            return null;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to connect with Quick Connect', undefined, {
                message: err.message,
            });
            return null;
        }
    }

    /**
     * Connect using Quick Connect with custom device name and ID
     * Used for device authorization flow where each device gets its own token
     * The device name will appear in Jellyfin's active sessions
     */
    async connectQuickConnectWithDevice(
        secret: string,
        deviceName: string,
        deviceId: string,
    ): Promise<{
        AccessToken: string;
        User?: { Id: string; Name: string };
        ServerId?: string;
    } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.post<QuickConnectAuthResponse>(
                joinUpstreamUrl(this.api!.basePath, `/Users/AuthenticateWithQuickConnect`),
                { Secret: secret },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        ...buildJellyfinAuthHeaders({
                            deviceName,
                            deviceId,
                            token: null,
                        }),
                    },
                },
            );

            if (response.data?.AccessToken) {
                this.logger.info('Quick Connect with device succeeded', {
                    deviceName,
                    deviceId: deviceId.substring(0, 8) + '...',
                });
                return {
                    AccessToken: response.data.AccessToken,
                    User: response.data.User,
                    ServerId: response.data.ServerId,
                };
            }

            this.logger.error('Quick Connect with device returned unexpected data', undefined, {
                data: response.data,
            });
            return null;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to connect with Quick Connect device', undefined, {
                message: err.message,
            });
            return null;
        }
    }

    /**
     * Validate a Jellyfin access token by calling the /Users/Me endpoint
     * Returns the user info if valid, null if invalid/expired
     */
    async validateAccessToken(
        accessToken: string,
        device?: Pick<JellyfinAuthOptions, 'deviceName' | 'deviceId'>,
    ): Promise<{ Id: string; Name: string } | null> {
        if (!this.isConfigured()) {
            this.logger.warn('Jellyfin not configured');
            return null;
        }

        try {
            const response = await this.api!.axiosInstance.get<JellyfinUserResponse>(
                joinUpstreamUrl(this.api!.basePath, `/Users/Me`),
                {
                    headers: buildJellyfinAuthHeaders({ ...device, token: accessToken }),
                },
            );

            if (response.data?.Id && response.data?.Name) {
                return {
                    Id: response.data.Id,
                    Name: response.data.Name,
                };
            }

            return null;
        } catch (error) {
            // 401 means token is invalid/expired - this is expected
            if (getAxiosStatus(error) === 401) {
                this.logger.debug('Jellyfin token validation failed: token invalid or expired');
                return null;
            }
            // Other errors might be network issues - log but return null
            this.logger.warn('Jellyfin token validation error', {
                error: String(error),
            });
            return null;
        }
    }
}

export const jellyfinAuthService = new JellyfinAuthService();
