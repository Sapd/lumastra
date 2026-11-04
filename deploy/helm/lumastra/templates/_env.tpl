{{- /*
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Non-secret env for web/worker. Built as a dict so later sources win and the output
is sorted (deterministic). Rendered into the <release>-env ConfigMap; its hash rolls the pods.
*/ -}}
{{- define "lumastra.envData" -}}
{{- $v := .Values -}}
{{- $e := dict -}}
{{- $_ := set $e "NODE_ENV" "production" -}}
{{- $_ := set $e "PORT" "3000" -}}
{{- $_ := set $e "BASE_PATH" "/config" -}}
{{- $_ := set $e "TZ" $v.app.timezone -}}
{{- $_ := set $e "LOG_LEVEL" $v.app.logLevel -}}
{{- $_ := set $e "BODY_SIZE_LIMIT" $v.app.bodySizeLimit -}}
{{- $_ := set $e "FFMPEG_TRANSCODE_DIR" $v.persistence.transcode.mountPath -}}
{{- $_ := set $e "FFMPEG_AUTO_DOWNLOAD" (toString $v.ffmpeg.autoDownload) -}}
{{- $_ := set $e "PLUGINS_EXTERNAL_DIR" "/app/plugins" -}}
{{- $_ := set $e "METADATA_STORAGE_LOCATION" $v.app.metadataStorageLocation -}}
{{- with $v.app.origin }}{{ $_ := set $e "ORIGIN" . }}{{ end -}}
{{- with $v.app.protocolHeader }}{{ $_ := set $e "PROTOCOL_HEADER" . }}{{ end -}}
{{- /* Client address only (never identity): the router pods' addresses are a pod CIDR the chart
       cannot know, and TRUSTED_PROXY_IPS would also hand that CIDR forward-auth identity trust. */ -}}
{{- $cip := $v.app.clientIpProxyIps -}}
{{- if and (eq (toString $cip) "<nil>") $v.router.enabled }}{{ $cip = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10" }}{{ end -}}
{{- if and $cip (ne (toString $cip) "<nil>") }}{{ $_ := set $e "CLIENT_IP_PROXY_IPS" (toString $cip) }}{{ end -}}
{{- if $v.app.lowRamMode }}{{ $_ := set $e "LUMASTRA_LOW_RAM_MODE" "true" }}{{ end -}}
{{- /* auth */ -}}
{{- /* null = not rendered: the app default / Admin UI value applies (README: Authentication) */ -}}
{{- /* native login unset + no SSO configured: the app's preflight refuses to boot without a
       sign-in method, so render true (= the compose quick start). With forward-auth/OIDC it stays
       unset (app default false; /setup or the Admin UI can still turn it on). */ -}}
{{- $native := $v.auth.native.enabled -}}
{{- if and (eq (toString $native) "<nil>") (not $v.auth.forwardAuth.enabled) (not $v.auth.oidc.enabled) }}{{ $native = true }}{{ end -}}
{{- include "lumastra.setBool" (list $e "AUTH_NATIVE_LOGIN_ENABLED" $native) -}}
{{- with $v.auth.adminGroups }}{{ $_ := set $e "ADMIN_GROUPS" . }}{{ end -}}
{{- with $v.auth.watchPermissionGroups }}{{ $_ := set $e "WATCH_PERMISSION_GROUPS" . }}{{ end -}}
{{- include "lumastra.setBool" (list $e "FEATURE_DEVICE_AUTH" $v.auth.deviceAuth) -}}
{{- include "lumastra.setBool" (list $e "FEATURE_USER_PATS" $v.auth.userPats) -}}
{{- $fa := $v.auth.forwardAuth -}}
{{- if $fa.enabled -}}
{{- /* The app reads identity headers only with FORWARD_AUTH_ENABLED (opt-in since 2026-10). */ -}}
{{- $_ := set $e "FORWARD_AUTH_ENABLED" "true" -}}
{{- $_ := set $e "USERHEADER" $fa.userHeader -}}
{{- $_ := set $e "GROUPHEADER" $fa.groupHeader -}}
{{- with $fa.nameHeader }}{{ $_ := set $e "NAMEHEADER" . }}{{ end -}}
{{- with $fa.trustedProxyIps }}{{ $_ := set $e "TRUSTED_PROXY_IPS" . }}{{ end -}}
{{- include "lumastra.setBool" (list $e "FORWARD_AUTH_GROUPS_ALWAYS_SENT" $fa.groupsAlwaysSent) -}}
{{- end -}}
{{- $o := $v.auth.oidc -}}
{{- if $o.enabled -}}
{{- $_ := set $e "AUTH_OIDC_ENABLED" "true" -}}
{{- $_ := set $e "AUTH_OIDC_ISSUER" (required "auth.oidc.issuer is required when OIDC is enabled" $o.issuer) -}}
{{- $_ := set $e "AUTH_OIDC_CLIENT_ID" (required "auth.oidc.clientId is required when OIDC is enabled" $o.clientId) -}}
{{- with $o.scopes }}{{ $_ := set $e "AUTH_OIDC_SCOPES" . }}{{ end -}}
{{- with $o.groupsClaim }}{{ $_ := set $e "AUTH_OIDC_GROUPS_CLAIM" . }}{{ end -}}
{{- with $o.providerName }}{{ $_ := set $e "AUTH_OIDC_PROVIDER_NAME" . }}{{ end -}}
{{- with $o.redirectUri }}{{ $_ := set $e "AUTH_OIDC_REDIRECT_URI" . }}{{ end -}}
{{- end -}}
{{- /* GPU */ -}}
{{- $_ := set $e "GPU_ACCELERATION" $v.gpu.acceleration -}}
{{- range $k, $val := $v.gpu.env }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- /* sidecars */ -}}
{{- if $v.proxy.enabled }}{{ $_ := set $e "STREAM_PROXY_URL" (printf "http://%s:3000" (include "lumastra.component" (list . "proxy"))) }}{{ end -}}
{{- if $v.sonic.enabled }}{{ $_ := set $e "SONIC_EMBEDDER_URL" (printf "http://%s:8000" (include "lumastra.component" (list . "sonic"))) }}{{ end -}}
{{- /* integrations: server-side URL and browser-facing URL are separate values */ -}}
{{- $ivars := include "lumastra.integrationVars" . | fromYaml -}}
{{- range $name, $i := (default dict $v.integrations) }}
{{- $names := get $ivars $name -}}
{{- if $names }}
{{- with $i.url }}{{ $_ := set $e (index $names 0) (toString .) }}{{ end -}}
{{- if and $i.publicUrl (index $names 1) }}{{ $_ := set $e (index $names 1) (toString $i.publicUrl) }}{{ end -}}
{{- end }}
{{- end -}}
{{- /* free-form groups, last wins */ -}}
{{- range $k, $val := $v.app.publicUrls }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- range $k, $val := $v.features }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- range $k, $val := $v.concurrency }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- range $k, $val := $v.app.env }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- range $k := keys $e | sortAlpha }}
{{ $k }}: {{ get $e $k | quote }}
{{- end }}
{{- end -}}

{{- /* list dict KEY value: set KEY to "true"/"false" unless value is null (unset). */ -}}
{{- define "lumastra.setBool" -}}
{{- $val := index . 2 -}}
{{- if ne (toString $val) "<nil>" }}
{{- if not (kindIs "bool" $val) }}{{ fail (printf "%s: expected true, false or null, got %v" (index . 1) $val) }}{{ end }}
{{- $_ := set (index . 0) (index . 1) (toString $val) }}
{{- end }}
{{- end -}}
