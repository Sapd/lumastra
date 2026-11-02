<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet, SvelteDate } from 'svelte/reactivity';
    import { onMount, untrack } from 'svelte';
    import { page } from '$app/state';
    import {
        adminWorkspaceUrl,
        writeAdminWorkspaceUrl,
    } from '$lib/components/admin/admin-workspace-url';
    import { Icon, ArrowPath, UserPlus, Eye, EyeSlash, Sparkles } from 'svelte-hero-icons';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import { ActionModal, UserTable } from '$lib/components/admin';
    import UserDetailDrawer from '$lib/components/admin/users/UserDetailDrawer.svelte';
    import {
        DRAWER_SECTIONS,
        possibleSuffixDuplicates,
        type DrawerSection,
    } from '$lib/components/admin/users/user-directory';
    import * as adminApi from '$lib/api/admin';
    import * as aiApi from '$lib/api/ai';
    import { triggerJellyfinSyncPull } from '$lib/api/integrations';
    import type { LocalUser } from '$lib/schemas/api-admin-responses';
    import * as m from '$lib/paraglide/messages.js';
    import { estimatePasswordStrength, PASSWORD_MIN_LENGTH } from '$lib/shared/password-strength';
    import { AdminUserEmailSchema } from '$lib/schemas/admin-user.js';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    // Unified user list state. Seeded from the server load() so the first
    // render shows data (no empty-then-populate flash); the client refresh
    // path (Refresh button + post-mutation reloads) takes over after that.
    let userState = $state({
        // One-time seed from the server load. We intentionally capture only the
        // initial value — the list is owned client-side after hydration (Refresh
        // button + in-place mutation updates), not re-derived from `data`.
        users: untrack(() => data.initialUsers) ?? ([] as LocalUser[]),
        loading: false,
        togglingAdmin: new SvelteSet<string>(),
        updatingPrivacy: new SvelteSet<string>(),
        updatingAgeRating: new SvelteSet<string>(),
        refreshingWatchState: new SvelteSet<string>(),
        updatingDisabled: new SvelteSet<string>(),
        deletingUser: new SvelteSet<string>(),
    });

    // Current admin's username for self-row protection
    let currentUsername = $derived(page.data?.user?.username as string | undefined);

    // Create User modal state
    let createUserModalState = $state({
        open: false,
        username: '',
        email: '',
        created: false,
        warnings: [] as string[],
        password: '',
        isAdmin: false,
        submitting: false,
    });

    let suffixDuplicates = $derived(possibleSuffixDuplicates(userState.users));
    let createEmailValid = $derived(
        AdminUserEmailSchema.safeParse(createUserModalState.email).success,
    );
    let nativeLoginWarning = $derived(
        data.nativeLoginEnabled === false ||
            createUserModalState.warnings.includes('native_login_disabled'),
    );
    let createUserStrength = $derived(estimatePasswordStrength(createUserModalState.password));
    let createUserShowPassword = $state(false);
    /** Accounts normally appear on first identity-provider sign-in; say so before a local one is made. */
    let directoryUsesIdp = $derived(
        userState.users.some((u) =>
            (u.identityProviders ?? []).some((p) => p === 'oidc' || p === 'forward_auth'),
        ),
    );

    function generateCreateUserPassword(): void {
        // Unambiguous alphabet (no 0/O, 1/l/I) so it survives being read aloud or retyped.
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_';
        const bytes = crypto.getRandomValues(new Uint32Array(20));
        createUserModalState.password = Array.from(
            bytes,
            (b) => alphabet[b % alphabet.length],
        ).join('');
        createUserShowPassword = true;
    }
    let createUserMeterColor = $derived(
        ['bg-error-500', 'bg-error-500', 'bg-warning-500', 'bg-lime-500', 'bg-success-500'][
            createUserStrength.score
        ],
    );
    let createUserCanConfirm = $derived(
        createUserModalState.created ||
            (createEmailValid &&
                createUserModalState.username.trim().length > 0 &&
                createUserStrength.acceptable &&
                !createUserModalState.submitting),
    );

    // Reset Password modal state
    let resetPasswordModalState = $state({
        open: false,
        targetUser: null as string | null,
        password: '',
        submitting: false,
    });

    let resetPasswordStrength = $derived(
        estimatePasswordStrength(resetPasswordModalState.password),
    );
    let resetPasswordMeterColor = $derived(
        ['bg-error-500', 'bg-error-500', 'bg-warning-500', 'bg-lime-500', 'bg-success-500'][
            resetPasswordStrength.score
        ],
    );
    let resetPasswordCanConfirm = $derived(
        resetPasswordStrength.acceptable && !resetPasswordModalState.submitting,
    );

    // True when the target has no native password yet — the modal then frames
    // the action as provisioning a first password ("Set password") rather than
    // resetting an existing one. The backend grants native login either way.
    let resetTargetHasNativePassword = $derived(
        resetPasswordModalState.targetUser
            ? (userState.users.find((u) => u.username === resetPasswordModalState.targetUser)
                  ?.hasNativePassword ?? false)
            : false,
    );

    // Single global flag — the underlying engine pulls every Jellyfin user
    // in one run, so there's no per-user concurrency to track.
    let resyncingGlobal = $state(false);

    // Feature flag for Quick Connect (requires Jellyfin)
    let quickConnectEnabled = $derived(page.data?.features?.quickConnect === true);
    // Feature flag for Jellyfin background sync (controls the header-level
    // "Trigger global Jellyfin sync" button).
    let jellyfinSyncEnabled = $derived(page.data?.features?.jellyfinSync === true);

    // Quick Connect modal state
    let quickConnectModalState = $state({
        open: false,
        targetUser: null as string | null,
        code: '',
        loading: false,
    });

    // Per-user connections modal state (devices, Jellyfin /j, Subsonic, PATs)

    // Accounts & identities modal state

    // Per-user stream policy modal state

    // Detail drawer — row click / name click opens it. Holds only the target
    // username; the drawer always renders the live row object so mutations
    // made from inside it (admin toggle, privacy, …) reflect immediately.
    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let detailDrawerUsername = $derived(workspaceUrl.searchParams.get('user'));
    let detailDrawerSection = $derived.by((): DrawerSection => {
        const tab = workspaceUrl.searchParams.get('tab');
        return (DRAWER_SECTIONS as readonly string[]).includes(tab ?? '')
            ? (tab as DrawerSection)
            : 'overview';
    });
    let showSyncConfirm = $state(false);
    let roleChange = $state<{
        username: string;
        currentIsAdmin: boolean;
        useGroups?: boolean;
    } | null>(null);

    const detailDrawerUser = $derived(
        detailDrawerUsername
            ? (userState.users.find((u) => u.username === detailDrawerUsername) ?? null)
            : null,
    );

    const openDetailDrawer = (username: string) => {
        const url = new URL(workspaceUrl);
        url.searchParams.set('user', username);
        url.searchParams.delete('tab');
        writeAdminWorkspaceUrl(url, page.state);
    };

    const setDetailDrawerSection = (section: DrawerSection) => {
        const url = new URL(workspaceUrl);
        if (section === 'overview') url.searchParams.delete('tab');
        else url.searchParams.set('tab', section);
        writeAdminWorkspaceUrl(url, page.state, true);
    };

    const closeDetailDrawer = () => {
        const url = new URL(workspaceUrl);
        url.searchParams.delete('user');
        url.searchParams.delete('tab');
        writeAdminWorkspaceUrl(url, page.state, true);
    };

    // ── Destructive-confirm modal state ──────────────────────────────────────
    // Styled ActionModal confirmations replacing raw browser confirm() so the
    // dangerous actions get explicit consequence copy and a consistent UI.
    let clearAiModalState = $state({
        open: false,
        targetUser: null as string | null,
    });

    let disableModalState = $state({
        open: false,
        targetUser: null as string | null,
    });

    let deleteModalState = $state({
        open: false,
        targetUser: null as string | null,
        // Typed-confirm: the operator must re-type the username before the
        // Delete button enables — guards against fat-fingered deletions.
        typed: '',
    });

    const deleteConfirmReady = $derived(
        deleteModalState.targetUser !== null &&
            deleteModalState.typed.trim() === deleteModalState.targetUser,
    );

    const isRecord = (value: unknown): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null;

    // ============================================================
    // Unified user loading
    // ============================================================
    // A reload must not overwrite a newer one, nor undo a role/disable/age
    // change that landed while it was in flight: the newest load wins, and a
    // load that raced a local mutation fetches again instead of writing.
    let loadGeneration = 0;
    let mutationCount = 0;

    const loadUsers = async (): Promise<void> => {
        const generation = ++loadGeneration;
        const mutationsAtStart = mutationCount;
        userState.loading = true;
        try {
            const { data, error } = await adminApi.getLocalUsers();
            if (generation !== loadGeneration) return;
            if (error) {
                toasts.error(error ?? m.admin_users_toast_load_failed());
            } else if (data) {
                if (mutationCount !== mutationsAtStart) {
                    void loadUsers();
                    return;
                }
                userState.users = data.items;
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_load_failed()));
        } finally {
            if (generation === loadGeneration) userState.loading = false;
        }
    };

    onMount(() => {
        // The list is normally seeded server-side. Only fetch on mount if the
        // server seed came back empty (e.g. the load() fetch hiccuped) so we
        // still recover client-side without a redundant request on every visit.
        if (userState.users.length === 0) {
            loadUsers();
        }
    });

    const toggleIsAdmin = async (username: string, currentIsAdmin: boolean) => {
        userState.togglingAdmin.add(username);
        try {
            const { data, error } = await adminApi.setUserIsAdmin(username, !currentIsAdmin);
            if (error) {
                toasts.error(error ?? m.admin_users_toast_admin_update_failed());
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username
                        ? {
                              ...u,
                              isAdmin: data.isAdmin,
                              adminPinned: data.adminPinned,
                          }
                        : u,
                );
                toasts.success(
                    data.isAdmin
                        ? m.admin_users_toast_admin_granted({ username })
                        : m.admin_users_toast_admin_revoked({ username }),
                );
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_admin_update_failed()));
        } finally {
            userState.togglingAdmin.delete(username);
        }
    };

    const unpinAdmin = async (username: string) => {
        userState.togglingAdmin.add(username);
        try {
            const { data, error } = await adminApi.unpinUserAdmin(username);
            if (error) {
                toasts.error(error ?? m.admin_users_toast_admin_unpin_failed());
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username
                        ? {
                              ...u,
                              isAdmin: data.isAdmin,
                              adminPinned: data.adminPinned,
                          }
                        : u,
                );
                toasts.success(m.admin_users_toast_admin_follows_idp({ username }));
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_admin_unpin_failed()));
        } finally {
            userState.togglingAdmin.delete(username);
        }
    };

    const setAllowLiveTv = async (username: string, allowed: boolean): Promise<boolean> => {
        try {
            const { data, error } = await adminApi.setUserAllowLiveTv(username, allowed);
            if (error || !data) {
                toasts.error(m.admin_users_live_tv_save_failed());
                return false;
            }
            mutationCount++;
            userState.users = userState.users.map((u) =>
                u.username === username ? { ...u, ...data } : u,
            );
            return true;
        } catch {
            toasts.error(m.admin_users_live_tv_save_failed());
            return false;
        }
    };

    const setAgeRating = async (username: string, maxAge: number | null): Promise<boolean> => {
        userState.updatingAgeRating.add(username);
        try {
            const { data, error } = await adminApi.setUserAgeRating(username, maxAge);
            if (error) {
                toasts.error(error ?? m.admin_users_toast_age_set_failed());
                return false;
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username
                        ? {
                              ...u,
                              maxAgeRating: data.maxAgeRating,
                              ageRatingPinned: data.ageRatingPinned,
                          }
                        : u,
                );
                const label =
                    data.maxAgeRating === null
                        ? m.admin_users_age_unrestricted()
                        : m.admin_users_age_value({ age: data.maxAgeRating });
                toasts.success(m.admin_users_toast_age_set({ username, label }));
            }
            return true;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_age_set_failed()));
            return false;
        } finally {
            userState.updatingAgeRating.delete(username);
        }
    };

    const unpinAgeRating = async (username: string) => {
        userState.updatingAgeRating.add(username);
        try {
            const { data, error } = await adminApi.unpinUserAgeRating(username);
            if (error) {
                toasts.error(error ?? m.admin_users_toast_age_unpin_failed());
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username
                        ? {
                              ...u,
                              maxAgeRating: data.maxAgeRating,
                              ageRatingPinned: data.ageRatingPinned,
                          }
                        : u,
                );
                toasts.success(m.admin_users_toast_age_follows_idp({ username }));
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_age_unpin_failed()));
        } finally {
            userState.updatingAgeRating.delete(username);
        }
    };

    const togglePrivacy = async (username: string, currentValue: boolean): Promise<boolean> => {
        userState.updatingPrivacy.add(username);

        try {
            const { error } = await adminApi.updatePrivacySettings({
                username,
                hideFromOthers: !currentValue,
            });

            if (!error) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username ? { ...u, hideStreams: !currentValue } : u,
                );
                toasts.success(
                    !currentValue
                        ? m.admin_users_toast_privacy_enabled({ username })
                        : m.admin_users_toast_privacy_disabled({ username }),
                );
                return true;
            }
            toasts.error(m.admin_users_toast_privacy_update_failed_detail({ error }));
            return false;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_privacy_update_failed()));
            return false;
        } finally {
            userState.updatingPrivacy.delete(username);
        }
    };

    const clearUserData = (username: string) => {
        clearAiModalState.targetUser = username;
        clearAiModalState.open = true;
    };

    const closeClearAiModal = () => {
        clearAiModalState.open = false;
        clearAiModalState.targetUser = null;
    };

    const confirmClearUserData = async () => {
        const username = clearAiModalState.targetUser;
        if (!username) return;

        try {
            userState.loading = true;
            const { error, status } = await aiApi.clearUserAiData(username);

            if (!error) {
                toasts.success(m.admin_users_toast_ai_data_cleared({ username }));
                closeClearAiModal();
                await loadUsers();
            } else {
                let errorMessage = error || m.toast_unknown_error();

                if (status === 403) {
                    errorMessage = m.admin_users_error_clear_permission_denied();
                }

                toasts.error(m.admin_users_toast_clear_failed({ username, error: errorMessage }));
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_clear_failed_short({ username })));
        } finally {
            userState.loading = false;
        }
    };

    // ============================================================
    // Create user
    // ============================================================
    const openCreateUserModal = () => {
        createUserModalState.username = '';
        createUserModalState.email = '';
        createUserModalState.created = false;
        createUserModalState.warnings = [];
        createUserModalState.password = '';
        createUserModalState.isAdmin = false;
        createUserModalState.submitting = false;
        createUserShowPassword = false;
        createUserModalState.open = true;
    };

    const closeCreateUserModal = () => {
        createUserModalState.open = false;
        createUserModalState.password = '';
    };

    const submitCreateUser = async () => {
        if (createUserModalState.created) {
            closeCreateUserModal();
            return;
        }
        if (!createUserCanConfirm) return;
        createUserModalState.submitting = true;
        try {
            const { data, error } = await adminApi.createLocalUser({
                username: createUserModalState.username.trim(),
                password: createUserModalState.password,
                isAdmin: createUserModalState.isAdmin,
                email: createUserModalState.email,
            });
            if (error) {
                toasts.error(error ?? m.admin_users_toast_create_failed());
            } else if (data) {
                toasts.success(m.admin_users_toast_created({ username: data.user.username }));
                createUserModalState.warnings = data.warnings ?? [];
                createUserModalState.password = '';
                if (createUserModalState.warnings.includes('native_login_disabled')) {
                    createUserModalState.created = true;
                } else {
                    closeCreateUserModal();
                }
                await loadUsers();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_create_failed()));
        } finally {
            createUserModalState.submitting = false;
        }
    };

    const setEmail = async (username: string, email: string): Promise<boolean> => {
        const target = userState.users.find((u) => u.username === username);
        if (!target?.id) return false;
        try {
            const { data, error } = await adminApi.setLocalUserEmail(target.id, email);
            if (error || !data) {
                toasts.error(error ?? m.admin_users_email_save_failed());
                return false;
            }
            mutationCount++;
            userState.users = userState.users.map((u) =>
                u.username === username ? { ...u, email: data.user.email ?? undefined } : u,
            );
            return true;
        } catch {
            toasts.error(m.admin_users_email_save_failed());
            return false;
        }
    };

    // ============================================================
    // Reset password
    // ============================================================
    const openResetPasswordModal = (username: string) => {
        resetPasswordModalState.targetUser = username;
        resetPasswordModalState.password = '';
        resetPasswordModalState.submitting = false;
        resetPasswordModalState.open = true;
    };

    const closeResetPasswordModal = () => {
        resetPasswordModalState.open = false;
        resetPasswordModalState.targetUser = null;
        resetPasswordModalState.password = '';
    };

    const submitResetPassword = async () => {
        if (!resetPasswordModalState.targetUser || !resetPasswordCanConfirm) return;
        resetPasswordModalState.submitting = true;
        try {
            const { data, error } = await adminApi.setUserPassword(
                resetPasswordModalState.targetUser,
                resetPasswordModalState.password,
            );
            if (error) {
                toasts.error(error ?? m.admin_users_toast_reset_failed());
            } else if (data) {
                // The account now has a native login: "Set password", the
                // no-login badge and the last-method unlink warning depend on it.
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === data.username ? { ...u, hasNativePassword: true } : u,
                );
                toasts.success(m.admin_users_toast_password_reset({ username: data.username }));
                closeResetPasswordModal();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_reset_failed()));
        } finally {
            resetPasswordModalState.submitting = false;
        }
    };

    // ============================================================
    // Disable / enable user
    // ============================================================
    const setDisabled = (username: string, currentDisabled: boolean) => {
        // Re-enabling is non-destructive — apply immediately. Disabling signs
        // the user out and locks them out, so route it through the confirm modal.
        if (currentDisabled) {
            void performSetDisabled(username, false);
            return;
        }
        disableModalState.targetUser = username;
        disableModalState.open = true;
    };

    const closeDisableModal = () => {
        disableModalState.open = false;
        disableModalState.targetUser = null;
    };

    const performSetDisabled = async (
        username: string,
        nextDisabled: boolean,
    ): Promise<boolean> => {
        userState.updatingDisabled.add(username);
        try {
            const { data, error } = await adminApi.setUserDisabled(username, nextDisabled);
            if (error) {
                toasts.error(error ?? m.admin_users_toast_account_update_failed());
                return false;
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.map((u) =>
                    u.username === username ? { ...u, disabled: data.disabled } : u,
                );
                toasts.success(
                    data.disabled
                        ? m.admin_users_toast_disabled({ username })
                        : m.admin_users_toast_enabled({ username }),
                );
            }
            return true;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_account_update_failed()));
            return false;
        } finally {
            userState.updatingDisabled.delete(username);
        }
    };

    const confirmDisable = async () => {
        const username = disableModalState.targetUser;
        if (!username) return;
        // Keep the modal open on failure (e.g. 409 last active admin) so the
        // error is read in context, not after the dialog vanished.
        if (await performSetDisabled(username, true)) closeDisableModal();
    };

    // ============================================================
    // Delete user
    // ============================================================
    const deleteUser = (username: string) => {
        deleteModalState.targetUser = username;
        deleteModalState.typed = '';
        deleteModalState.open = true;
    };

    const closeDeleteModal = () => {
        deleteModalState.open = false;
        deleteModalState.targetUser = null;
        deleteModalState.typed = '';
    };

    const confirmDeleteUser = async () => {
        const username = deleteModalState.targetUser;
        // Guard again at submit time — the button is also disabled until the
        // typed username matches, but never trust the UI alone.
        if (!username || deleteModalState.typed.trim() !== username) return;
        userState.deletingUser.add(username);
        try {
            const { data, error } = await adminApi.deleteLocalUser(
                username,
                deleteModalState.typed.trim(),
            );
            if (error) {
                toasts.error(error ?? m.admin_users_toast_delete_failed());
            } else if (data) {
                mutationCount++;

                userState.users = userState.users.filter((u) => u.username !== username);
                // The drawer was showing this user; left open, ?user= would point
                // at a deleted account and render the stray "not found" box.
                if (detailDrawerUsername === username) closeDetailDrawer();
                // Surface the GDPR erasure confirmation artifact (per-table counts).
                const erasure = data.erasure;
                if (erasure) {
                    toasts.success(
                        m.admin_users_toast_deleted_erasure({
                            username,
                            erased: erasure.totalDeleted,
                            anonymized: erasure.totalAnonymized,
                        }),
                    );
                } else {
                    toasts.success(m.admin_users_toast_deleted({ username }));
                }
                closeDeleteModal();
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_delete_failed()));
        } finally {
            userState.deletingUser.delete(username);
        }
    };

    // Admin-triggered **global** Jellyfin re-sync. The underlying engine
    // pulls watch state for every Jellyfin user in a single run — the
    // label and the toast message make that scope honest. Admin bypasses
    // the global throttle server-side, so this can be invoked
    // back-to-back if needed.
    const resyncJellyfinGlobal = async () => {
        if (resyncingGlobal) return;
        resyncingGlobal = true;
        try {
            const { data, error, status } = await triggerJellyfinSyncPull();
            if (!error && data) {
                // Sync started asynchronously — the run ID is available in data.runId.
                // No synced/pushed count available at trigger time (async job).
                toasts.success(m.users_directory_sync_started());
                return;
            }
            if (status === 503) {
                toasts.error(m.admin_toast_jellyfin_sync_is_not_configured());
                return;
            }
            if (status === 409) {
                // 409 Conflict = a sync run is already in progress.
                toasts.error(m.admin_users_toast_sync_rate_limited({ minutes: 1 }));
                return;
            }
            toasts.error(error ?? m.admin_users_toast_resync_failed());
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_resync_failed()));
        } finally {
            resyncingGlobal = false;
        }
    };

    // Per-user "Refresh Watch State" — clears the user's pull-log
    // cursor so the next watch-sync cycle does a full re-fetch from
    // Jellyfin. Use when their Lumastra state has drifted from the
    // source of truth (e.g. unmarks in Jellyfin that happened after
    // the cursor advanced past them).
    const refreshUserWatchState = async (username: string) => {
        if (userState.refreshingWatchState.has(username)) return;
        userState.refreshingWatchState.add(username);
        try {
            const { data, error } = await adminApi.refreshUserWatchState(username);
            if (error) {
                toasts.error(error);
                return;
            }
            toasts.success(data?.message ?? m.admin_users_toast_cursor_cleared());
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_refresh_watch_failed()));
        } finally {
            userState.refreshingWatchState.delete(username);
        }
    };

    // Quick Connect functions
    const openQuickConnectModal = (username: string) => {
        quickConnectModalState.targetUser = username;
        quickConnectModalState.code = '';
        quickConnectModalState.open = true;
    };

    const closeQuickConnectModal = () => {
        quickConnectModalState.open = false;
        quickConnectModalState.targetUser = null;
        quickConnectModalState.code = '';
    };

    const submitQuickConnect = async () => {
        if (!quickConnectModalState.targetUser || !quickConnectModalState.code.trim()) {
            toasts.error(m.admin_toast_please_enter_a_quick_connect_code());
            return;
        }

        try {
            quickConnectModalState.loading = true;
            const { data, error } = await adminApi.authorizeQuickConnect({
                code: quickConnectModalState.code.trim(),
                username: quickConnectModalState.targetUser,
            });

            if (!error && data) {
                if (data.success) {
                    toasts.success(
                        m.admin_users_toast_quick_connect_authorized({
                            username: data.username || quickConnectModalState.targetUser,
                        }),
                    );
                    closeQuickConnectModal();
                } else {
                    toasts.error(
                        data.message ||
                            m.admin_users_toast_quick_connect_failed_user({
                                username: quickConnectModalState.targetUser,
                            }),
                    );
                }
            } else {
                toasts.error(
                    m.admin_users_toast_quick_connect_failed_detail({ error: error ?? '' }),
                );
            }
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_users_toast_quick_connect_authorize_failed()));
        } finally {
            quickConnectModalState.loading = false;
        }
    };

    const handleQuickConnectKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Enter' && !quickConnectModalState.loading) {
            submitQuickConnect();
        } else if (event.key === 'Escape') {
            closeQuickConnectModal();
        }
    };

    const formatDate = (dateStr: string | null | undefined): string => {
        if (!dateStr) return m.route_admin_api_tokens_never();
        const date = new SvelteDate(dateStr);
        const now = new SvelteDate();
        const diffMs = now.getTime() - date.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return m.admin_users_just_now();
        if (diffMins < 60) return m.time_minutes_ago_short({ count: diffMins });
        if (diffHours < 24) return m.time_hours_ago_short({ count: diffHours });
        if (diffDays < 7) return m.time_days_ago_short({ count: diffDays });
        return date.toLocaleDateString();
    };
</script>

<svelte:head><title>{m.admin_user_management()} · Admin</title></svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/users']}
        title={m.admin_user_management()}
        description={m.users_directory_description()}>
        {#if jellyfinSyncEnabled}
            <!--
                Global (not per-user) Jellyfin sync trigger — the engine pulls
                watch state for every Jellyfin user in a single run, so the
                scope is explicit in the label. A plain button: it used to sit
                alone inside a "Directory actions" <details> menu that ignored
                Esc and outside clicks.
            -->
            <button
                class="btn btn-surface"
                onclick={() => {
                    showSyncConfirm = true;
                }}
                disabled={resyncingGlobal}
                title={m.admin_users_sync_button_tooltip()}>
                <Icon src={ArrowPath} class="w-4 h-4 {resyncingGlobal ? 'animate-spin' : ''}" />
                {resyncingGlobal
                    ? m.admin_users_syncing_all()
                    : m.admin_users_trigger_global_sync()}
            </button>
        {/if}
        <button class="btn btn-primary" onclick={openCreateUserModal}>
            <Icon src={UserPlus} class="w-4 h-4" />
            {m.admin_users_create_user()}
        </button>
        <button class="btn btn-surface" onclick={loadUsers} disabled={userState.loading}>
            <Icon src={ArrowPath} class="w-4 h-4" />{m.common_refresh()}</button>
    </AdminPageHeader>

    {#if suffixDuplicates.length}
        <div
            role="status"
            class="mb-4 rounded-lg border border-warning-500/40 p-4 text-sm text-warning-200">
            <p>{m.admin_users_suffix_duplicate_hint()}</p>
            <ul class="mt-2 list-inside list-disc">
                {#each suffixDuplicates as pair (pair.duplicate)}
                    <li>{m.admin_users_suffix_duplicate_pair(pair)}</li>
                {/each}
            </ul>
        </div>
    {/if}
    <UserTable
        users={userState.users}
        loading={userState.loading}
        {currentUsername}
        {formatDate}
        onOpenDetails={openDetailDrawer}
        onToggleAdmin={(username, currentIsAdmin) => {
            roleChange = { username, currentIsAdmin };
        }}
        onSetDisabled={setDisabled}
        busyUsers={new Set([...userState.togglingAdmin, ...userState.updatingDisabled])} />
</div>

<!-- User Detail Drawer -->
{#if detailDrawerUser}
    {#key detailDrawerUser.username}
        <UserDetailDrawer
            user={detailDrawerUser}
            section={detailDrawerSection}
            onSectionChange={setDetailDrawerSection}
            {currentUsername}
            {quickConnectEnabled}
            togglingAdmin={userState.togglingAdmin}
            updatingPrivacy={userState.updatingPrivacy}
            updatingAgeRating={userState.updatingAgeRating}
            updatingDisabled={userState.updatingDisabled}
            deletingUser={userState.deletingUser}
            unratedTitles={data.unratedTitles}
            unratedContentVisible={data.unratedContentVisible}
            {formatDate}
            onToggleAdmin={(username, currentIsAdmin) => {
                roleChange = { username, currentIsAdmin };
            }}
            onUnpinAdmin={(username) => {
                roleChange = {
                    username,
                    currentIsAdmin: detailDrawerUser.isAdmin,
                    useGroups: true,
                };
            }}
            onSetEmail={setEmail}
            onSetAgeRating={setAgeRating}
            onSetAllowLiveTv={setAllowLiveTv}
            onUnpinAgeRating={unpinAgeRating}
            onTogglePrivacy={togglePrivacy}
            onClearUserData={clearUserData}
            {jellyfinSyncEnabled}
            onOpenQuickConnect={openQuickConnectModal}
            onRefreshWatchState={jellyfinSyncEnabled ? refreshUserWatchState : undefined}
            onResetPassword={openResetPasswordModal}
            onSetDisabled={setDisabled}
            onDeleteUser={deleteUser}
            onClose={closeDetailDrawer} />
    {/key}
{:else if detailDrawerUsername && !userState.loading}
    <div class="rounded-lg border border-surface-700 p-4 text-sm text-surface-300" role="status">
        {m.users_directory_not_found()}
        <button class="btn btn-surface mt-3" onclick={closeDetailDrawer}
            >{m.admin_users_drawer_close()}</button>
    </div>
{/if}

<!-- Quick Connect Modal -->
{#if quickConnectModalState.open}
    <ActionModal
        title={m.admin_users_action_quick_connect()}
        confirmText={quickConnectModalState.loading
            ? m.admin_users_authorizing()
            : m.admin_users_authorize()}
        disabled={quickConnectModalState.loading || !quickConnectModalState.code.trim()}
        onclose={closeQuickConnectModal}
        onconfirm={submitQuickConnect}>
        <p class="text-surface-300 mb-4">
            {m.admin_users_quick_connect_enter_for()}
            <span class="font-semibold text-white">{quickConnectModalState.targetUser}</span>
        </p>

        <p class="text-muted mb-4">
            {m.admin_users_quick_connect_instructions()}
        </p>

        <input
            type="text"
            class="w-full bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent font-mono text-lg tracking-wider"
            placeholder={m.admin_placeholder_enter_code()}
            bind:value={quickConnectModalState.code}
            onkeydown={handleQuickConnectKeydown}
            disabled={quickConnectModalState.loading} />
    </ActionModal>
{/if}

<!-- Create User Modal -->
{#if createUserModalState.open}
    <ActionModal
        title={m.admin_users_create_user()}
        confirmText={createUserModalState.created
            ? m.admin_users_created_done()
            : createUserModalState.submitting
              ? m.setup_btn_creating()
              : m.playlist_create()}
        confirmColor="blue"
        disabled={!createUserCanConfirm}
        onclose={closeCreateUserModal}
        onconfirm={submitCreateUser}>
        <div class="space-y-4">
            {#if nativeLoginWarning}
                <p
                    role="status"
                    class="rounded-lg border border-warning-500/40 p-3 text-sm text-warning-200">
                    {m.admin_users_native_login_disabled()}
                </p>
            {/if}
            {#if createUserModalState.created}
                <p role="status">
                    {m.admin_users_toast_created({ username: createUserModalState.username })}
                </p>
            {:else}
                {#if directoryUsesIdp}
                    <p
                        class="rounded-lg border border-surface-600 bg-surface-700/40 p-3 text-sm text-surface-300">
                        {m.admin_users_create_sso_hint()}
                    </p>
                {/if}
                <label class="block">
                    <span class="text-sm text-surface-300">{m.setup_label_username()}</span>
                    <input
                        type="text"
                        class="w-full bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent mt-1"
                        placeholder={m.admin_users_username_placeholder()}
                        bind:value={createUserModalState.username}
                        disabled={createUserModalState.submitting} />
                </label>

                <label class="block">
                    <span class="text-sm text-surface-300">{m.admin_users_email_label()}</span>
                    <input
                        type="email"
                        autocomplete="off"
                        class="mt-1 w-full rounded-lg border border-surface-600 bg-surface-700 px-4 py-3 text-white"
                        bind:value={createUserModalState.email}
                        disabled={createUserModalState.submitting}
                        aria-invalid={!createEmailValid}
                        aria-describedby="create-email-hint" />
                </label>
                <p id="create-email-hint" class="text-xs text-surface-400">
                    {m.admin_users_email_hint()}
                </p>
                {#if !createEmailValid}<p role="alert" class="text-sm text-red-300">
                        {m.admin_users_email_invalid()}
                    </p>{/if}
                <label class="block">
                    <span class="flex items-center justify-between text-sm text-surface-300"
                        >{m.setup_label_password()}
                        <button
                            type="button"
                            class="inline-flex items-center gap-1 text-xs text-primary-300 hover:text-primary-200"
                            onclick={generateCreateUserPassword}
                            disabled={createUserModalState.submitting}
                            ><Icon
                                src={Sparkles}
                                class="h-3.5 w-3.5" />{m.admin_users_generate_password()}</button
                        ></span>
                    <span class="relative mt-1 block">
                        <input
                            type={createUserShowPassword ? 'text' : 'password'}
                            class="w-full bg-surface-700 border border-surface-600 rounded-lg py-3 pl-4 pr-11 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                            autocomplete="new-password"
                            bind:value={createUserModalState.password}
                            disabled={createUserModalState.submitting} />
                        <button
                            type="button"
                            class="absolute inset-y-0 right-0 flex items-center px-3 text-surface-400 hover:text-white"
                            aria-label={createUserShowPassword
                                ? m.admin_users_hide_password()
                                : m.admin_users_show_password()}
                            title={createUserShowPassword
                                ? m.admin_users_hide_password()
                                : m.admin_users_show_password()}
                            onclick={() => (createUserShowPassword = !createUserShowPassword)}
                            ><Icon
                                src={createUserShowPassword ? EyeSlash : Eye}
                                class="h-4 w-4" /></button>
                    </span>
                    {#if createUserModalState.password.length > 0}
                        <div class="mt-2">
                            <div class="flex gap-1" aria-hidden="true">
                                {#each [0, 1, 2, 3] as seg (seg)}
                                    <div
                                        class="h-1.5 flex-1 rounded-full {createUserStrength.score >
                                        seg
                                            ? createUserMeterColor
                                            : 'bg-surface-600'}">
                                    </div>
                                {/each}
                            </div>
                            <p class="mt-1 text-xs text-surface-400">
                                {m.admin_users_password_strength()}
                                <span class="capitalize">{createUserStrength.label}</span
                                >{#if createUserStrength.warnings.length}
                                    — {createUserStrength.warnings[0]}{/if}
                            </p>
                        </div>
                    {:else}
                        <p class="mt-1 text-xs text-surface-500">
                            {m.admin_users_password_hint({ min: PASSWORD_MIN_LENGTH })}
                        </p>
                    {/if}
                </label>

                <label class="flex items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        class="checkbox"
                        bind:checked={createUserModalState.isAdmin}
                        disabled={createUserModalState.submitting} />
                    <span class="text-sm text-surface-300">{m.admin_users_administrator()}</span>
                </label>
            {/if}
        </div>
    </ActionModal>
{/if}

<!-- Reset / Set Password Modal -->
{#if resetPasswordModalState.open}
    <ActionModal
        title={resetTargetHasNativePassword
            ? m.admin_users_reset_password_title({
                  username: resetPasswordModalState.targetUser ?? '',
              })
            : m.admin_users_set_password_title({
                  username: resetPasswordModalState.targetUser ?? '',
              })}
        confirmText={resetPasswordModalState.submitting
            ? m.setup_btn_saving()
            : resetTargetHasNativePassword
              ? m.admin_users_reset_password()
              : m.admin_users_set_password()}
        confirmColor="blue"
        disabled={!resetPasswordCanConfirm}
        onclose={closeResetPasswordModal}
        onconfirm={submitResetPassword}>
        <p class="text-surface-400 text-sm mb-2">
            {resetTargetHasNativePassword
                ? m.admin_users_reset_password_desc_prefix()
                : m.admin_users_set_password_desc_prefix()}
            <span class="font-semibold text-white">{resetPasswordModalState.targetUser}</span>.
            {resetTargetHasNativePassword
                ? m.admin_users_reset_password_desc_suffix()
                : m.admin_users_set_password_desc_suffix()}
        </p>

        <label class="block">
            <span class="text-sm text-surface-300">{m.admin_users_new_password()}</span>
            <input
                type="password"
                class="w-full bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-purple-500 focus:border-transparent mt-1"
                autocomplete="new-password"
                bind:value={resetPasswordModalState.password}
                disabled={resetPasswordModalState.submitting} />
            {#if resetPasswordModalState.password.length > 0}
                <div class="mt-2">
                    <div class="flex gap-1" aria-hidden="true">
                        {#each [0, 1, 2, 3] as seg (seg)}
                            <div
                                class="h-1.5 flex-1 rounded-full {resetPasswordStrength.score > seg
                                    ? resetPasswordMeterColor
                                    : 'bg-surface-600'}">
                            </div>
                        {/each}
                    </div>
                    <p class="mt-1 text-xs text-surface-400">
                        {m.admin_users_password_strength()}
                        <span class="capitalize">{resetPasswordStrength.label}</span
                        >{#if resetPasswordStrength.warnings.length}
                            — {resetPasswordStrength.warnings[0]}{/if}
                    </p>
                </div>
            {:else}
                <p class="mt-1 text-xs text-surface-500">
                    {m.admin_users_password_hint({ min: PASSWORD_MIN_LENGTH })}
                </p>
            {/if}
        </label>
    </ActionModal>
{/if}

<!-- Clear AI Data Confirm Modal -->
{#if clearAiModalState.open && clearAiModalState.targetUser}
    <ActionModal
        title={m.admin_users_clear_ai_title({ username: clearAiModalState.targetUser })}
        confirmText={m.admin_users_clear_ai_confirm()}
        confirmColor="red"
        onclose={closeClearAiModal}
        onconfirm={confirmClearUserData}>
        <p class="text-surface-300 text-sm">
            {m.admin_users_clear_ai_body({ username: clearAiModalState.targetUser })}
        </p>
    </ActionModal>
{/if}

<!-- Disable Account Confirm Modal -->
{#if disableModalState.open && disableModalState.targetUser}
    <ActionModal
        title={m.admin_users_disable_title({ username: disableModalState.targetUser })}
        confirmText={m.admin_users_disable_confirm()}
        confirmColor="red"
        onclose={closeDisableModal}
        onconfirm={confirmDisable}>
        <p class="text-surface-300 text-sm">
            {m.admin_users_disable_body({ username: disableModalState.targetUser })}
        </p>
    </ActionModal>
{/if}

<!-- Delete User Confirm Modal (typed-confirm) -->
{#if deleteModalState.open && deleteModalState.targetUser}
    <ActionModal
        title={m.admin_users_delete_title({ username: deleteModalState.targetUser })}
        confirmText={m.admin_users_delete_confirm()}
        confirmColor="red"
        disabled={!deleteConfirmReady}
        onclose={closeDeleteModal}
        onconfirm={confirmDeleteUser}>
        <p class="text-surface-300 text-sm mb-3">
            {m.admin_users_delete_body({ username: deleteModalState.targetUser })}
        </p>
        <label class="block">
            <span class="text-sm text-surface-300">{m.admin_users_delete_type_prompt()}</span>
            <input
                type="text"
                class="w-full bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-white placeholder-surface-400 focus:outline-hidden focus:ring-2 focus:ring-error-500 focus:border-transparent mt-1 font-mono"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                placeholder={deleteModalState.targetUser}
                bind:value={deleteModalState.typed} />
        </label>
    </ActionModal>
{/if}

{#if roleChange}
    <ActionModal
        title={m.users_directory_role_confirm()}
        confirmText={roleChange.useGroups
            ? m.users_directory_return_idp()
            : roleChange.currentIsAdmin
              ? m.users_directory_revoke()
              : m.users_directory_grant()}
        confirmColor={roleChange.currentIsAdmin ? 'red' : 'blue'}
        disabled={userState.togglingAdmin.has(roleChange.username)}
        onclose={() => {
            roleChange = null;
        }}
        onconfirm={async () => {
            if (!roleChange) return;
            if (roleChange.useGroups) await unpinAdmin(roleChange.username);
            else await toggleIsAdmin(roleChange.username, roleChange.currentIsAdmin);
            roleChange = null;
        }}>
        <p class="text-surface-300">
            {roleChange.useGroups
                ? m.users_directory_idp_confirm({ username: roleChange.username })
                : m.users_directory_role_hint({ username: roleChange.username })}
        </p>
    </ActionModal>
{/if}

{#if showSyncConfirm}
    <ActionModal
        title={m.users_directory_sync_title()}
        confirmText={m.users_directory_sync_start()}
        disabled={resyncingGlobal}
        onclose={() => {
            showSyncConfirm = false;
        }}
        onconfirm={async () => {
            await resyncJellyfinGlobal();
            showSyncConfirm = false;
        }}>
        <p class="text-surface-300">{m.users_directory_sync_hint()}</p>
    </ActionModal>
{/if}
