// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Human label for an admin-audit action id such as `pat.create` or
 * `plugin.external.install`. The feed used to title-case the raw id, which read
 * as "Pat · create" — neither the section an operator knows ("API tokens") nor
 * a sentence.
 *
 * Shape: `<section> · <verb>` with any middle segments as a qualifier, e.g.
 * `plugin.external.install` → "Plugins · installed (external)". Unknown
 * namespaces and verbs fall back to the humanised id, so a new action never
 * renders blank.
 */
import * as m from '$lib/paraglide/messages.js';

const NAMESPACE_LABELS: Record<string, () => string> = {
    user: m.admin_audit_group_users,
    task: m.admin_audit_group_tasks,
    queue: m.admin_audit_group_queue,
    run: m.admin_audit_group_runs,
    secret: m.admin_audit_group_secrets,
    cache: m.admin_audit_group_cache,
    pat: m.admin_audit_group_pats,
    service_token: m.admin_audit_group_service_tokens,
    plugin: m.admin_audit_group_plugins,
    settings: m.admin_audit_group_settings,
    licensing: m.admin_audit_group_licensing,
    navigation: m.admin_audit_group_navigation,
    library_group: m.admin_audit_group_libraries,
    play_session: m.admin_audit_group_play_sessions,
};

const VERB_LABELS: Record<string, () => string> = {
    create: m.admin_audit_verb_create,
    add: m.admin_audit_verb_add,
    delete: m.admin_audit_verb_delete,
    del: m.admin_audit_verb_delete,
    remove: m.admin_audit_verb_remove,
    revoke: m.admin_audit_verb_revoke,
    save: m.admin_audit_verb_save,
    update: m.admin_audit_verb_update,
    run: m.admin_audit_verb_run,
    pause: m.admin_audit_verb_pause,
    resume: m.admin_audit_verb_resume,
    cancel: m.admin_audit_verb_cancel,
    self_cancel: m.admin_audit_verb_self_cancel,
    kill: m.admin_audit_verb_kill,
    enable: m.admin_audit_verb_enable,
    disable: m.admin_audit_verb_disable,
    install: m.admin_audit_verb_install,
    uninstall: m.admin_audit_verb_uninstall,
    reload: m.admin_audit_verb_reload,
    sync: m.admin_audit_verb_sync,
    rotate: m.admin_audit_verb_rotate,
    clear: m.admin_audit_verb_clear,
    reset_password: m.admin_audit_verb_reset_password,
    gdpr_export: m.admin_audit_verb_gdpr_export,
};

function humanize(segment: string): string {
    return segment.replaceAll('_', ' ');
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatAuditAction(action: string): string {
    const segments = action.split('.').filter(Boolean);
    if (segments.length === 0) return action;
    const [namespace, ...rest] = segments;
    const section = NAMESPACE_LABELS[namespace]?.() ?? capitalize(humanize(namespace));
    if (rest.length === 0) return section;
    const verbId = rest[rest.length - 1];
    const verb = VERB_LABELS[verbId]?.() ?? humanize(verbId);
    const qualifier = rest.slice(0, -1).map(humanize).join(' ');
    return qualifier ? `${section} · ${verb} (${qualifier})` : `${section} · ${verb}`;
}
