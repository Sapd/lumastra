{{- /*
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
*/ -}}

{{- define "lumastra.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lumastra.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- /* "lumastra.component" (list $ "web") → <fullname>-web */ -}}
{{- define "lumastra.component" -}}
{{- printf "%s-%s" (include "lumastra.fullname" (index . 0)) (index . 1) -}}
{{- end -}}

{{- define "lumastra.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "lumastra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: lumastra
{{- end -}}

{{- /* (list $ "web") */ -}}
{{- define "lumastra.selectorLabels" -}}
{{- $ := index . 0 -}}
app.kubernetes.io/name: {{ include "lumastra.name" $ }}
app.kubernetes.io/instance: {{ $.Release.Name }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- /* (list $ "web") → labels + component */ -}}
{{- define "lumastra.componentLabels" -}}
{{ include "lumastra.labels" (index . 0) }}
app.kubernetes.io/component: {{ index . 1 }}
{{- end -}}

{{- /* Only web pods serve the application over HTTP. */ -}}
{{- define "lumastra.httpComponent" -}}
web
{{- end -}}

{{- /* (list $ imageValues defaultImageValues) → registry/repository[:tag|@digest] */ -}}
{{- define "lumastra.image" -}}
{{- $ := index . 0 -}}
{{- $img := index . 1 -}}
{{- $def := dict -}}
{{- if gt (len .) 2 }}{{ $def = index . 2 }}{{ end -}}
{{- $registry := coalesce $.Values.global.imageRegistry $img.registry $def.registry -}}
{{- $repo := coalesce $img.repository $def.repository -}}
{{- $digest := $img.digest -}}
{{- $tag := $img.tag -}}
{{- if and (not $img.repository) (not $digest) (not $tag) -}}
{{- $digest = $def.digest -}}
{{- $tag = $def.tag -}}
{{- end -}}
{{- $ref := ternary $repo (printf "%s/%s" $registry $repo) (empty $registry) -}}
{{- if $digest -}}
{{- printf "%s@%s" $ref $digest -}}
{{- else -}}
{{- printf "%s:%s" $ref (toString (default $.Chart.AppVersion $tag)) -}}
{{- end -}}
{{- end -}}

{{- /*
(list imageValues defaultImageValues?) → pull policy. Explicit wins; else Always for a moving tag
(stable/latest/main) without a digest — a cached `stable` would otherwise never be refreshed.
*/ -}}
{{- define "lumastra.pullPolicy" -}}
{{- $img := index . 0 -}}
{{- $def := dict -}}
{{- if gt (len .) 1 }}{{ $def = index . 1 }}{{ end -}}
{{- if $img.pullPolicy -}}
{{- $img.pullPolicy -}}
{{- else -}}
{{- $digest := $img.digest -}}
{{- $tag := $img.tag -}}
{{- if and (not $img.repository) (not $digest) (not $tag) -}}
{{- $digest = $def.digest -}}
{{- $tag = $def.tag -}}
{{- end -}}
{{- if and (not $digest) (has (toString $tag) (list "stable" "latest" "main" "")) -}}Always{{- else -}}IfNotPresent{{- end -}}
{{- end -}}
{{- end -}}

{{- define "lumastra.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "lumastra.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "lumastra.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ if kindIs "string" . }}{{ . }}{{ else }}{{ .name }}{{ end }}
{{- end }}
{{- end }}
{{- end -}}

{{- /*
Scheduling for a component: (list $ componentValues). Component nodeSelector merges over the
global one, tolerations concatenate, affinity: component wins over global.
*/ -}}
{{- define "lumastra.scheduling" -}}
{{- $ := index . 0 -}}
{{- $c := index . 1 -}}
{{- $ns := merge (deepCopy (default dict $c.nodeSelector)) (deepCopy (default dict $.Values.global.nodeSelector)) -}}
{{- with $ns }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- $tol := concat (default list $.Values.global.tolerations) (default list $c.tolerations) -}}
{{- with $tol }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with (default $.Values.global.affinity $c.affinity) }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $c.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $c.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- end -}}

{{- /* Pod annotations: (list $ componentValues) */ -}}
{{- define "lumastra.podAnnotations" -}}
{{- $ := index . 0 -}}
{{- $c := index . 1 -}}
{{- $a := merge (deepCopy (default dict $c.podAnnotations)) (deepCopy (default dict $.Values.global.podAnnotations)) -}}
{{- with $a }}{{ toYaml . }}{{ end -}}
{{- end -}}

{{- define "lumastra.podLabels" -}}
{{- $ := index . 0 -}}
{{- $c := index . 1 -}}
{{- $l := merge (deepCopy (default dict $c.podLabels)) (deepCopy (default dict $.Values.global.podLabels)) -}}
{{- with $l }}{{ toYaml . }}{{ end -}}
{{- end -}}

{{- /* PVC metadata annotations for chart-created PVCs. */ -}}
{{- define "lumastra.pvcAnnotations" -}}
{{- $a := deepCopy (default dict .Values.persistence.dataAnnotations) -}}
{{- if .Values.persistence.keepOnUninstall -}}
{{- $_ := set $a "helm.sh/resource-policy" "keep" -}}
{{- end -}}
{{- with $a }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- /* (list $ name persistenceValues) → a PVC document */ -}}
{{- /*
persistence.appCache.enabled: true, false or "auto" (the default). auto leaves a per-pod
emptyDir; shared caches need an explicit shared volume. Renders "true" or "".
*/ -}}
{{- define "lumastra.appCacheEnabled" -}}
{{- $e := toString .Values.persistence.appCache.enabled -}}
{{- if not (has $e (list "true" "false" "auto")) -}}
{{- fail "persistence.appCache.enabled must be true, false or auto" -}}
{{- end -}}
{{- if eq $e "true" }}true{{ end -}}
{{- end -}}

{{- define "lumastra.pvc" -}}
{{- $ := index . 0 -}}
{{- $name := index . 1 -}}
{{- $p := index . 2 -}}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $name }}
  labels:
    {{- include "lumastra.labels" $ | nindent 4 }}
  {{- include "lumastra.pvcAnnotations" $ | nindent 2 }}
spec:
  accessModes:
    {{- toYaml (default (list "ReadWriteMany") $p.accessModes) | nindent 4 }}
  {{- with $p.storageClassName }}
  storageClassName: {{ if eq . "-" }}""{{ else }}{{ . }}{{ end }}
  {{- end }}
  resources:
    requests:
      storage: {{ $p.size }}
{{- end -}}

{{- define "lumastra.cnpgName" -}}
{{- default (printf "%s-postgres" (include "lumastra.fullname" .)) .Values.database.cnpg.name -}}
{{- end -}}

{{- /* Secret name for a {secret,key} style ref, falling back to secrets.existingSecret. */ -}}
{{- define "lumastra.defaultSecret" -}}
{{- .Values.secrets.existingSecret -}}
{{- end -}}

{{- /* Valkey Service names. */ -}}
{{- define "lumastra.valkeyCacheHost" -}}
{{ include "lumastra.component" (list . "valkey-cache") }}
{{- end -}}
{{- define "lumastra.valkeyTasksHost" -}}
{{ include "lumastra.component" (list . "valkey-tasks") }}
{{- end -}}

{{- /*
Env entries that carry Valkey URLs (bundled: built from the password Secret at pod start, so the
password cannot be URL-encoded here: it must be URL-safe, e.g. hex). Args: root, withCache, withTasks.
valkey.auth.taskPasswordKey empty = the tasks instance shares the cache password (passwordKey).
*/ -}}
{{- define "lumastra.valkeyEnv" -}}
{{- $ := index . 0 -}}
{{- $withCache := index . 1 -}}
{{- $withTasks := index . 2 -}}
{{- if eq $.Values.valkey.mode "bundled" }}
{{- $secret := required "valkey.auth.existingSecret (or secrets.existingSecret) is required for bundled Valkey" (default $.Values.secrets.existingSecret $.Values.valkey.auth.existingSecret) }}
{{- $split := ne (default $.Values.valkey.auth.passwordKey $.Values.valkey.auth.taskPasswordKey) $.Values.valkey.auth.passwordKey }}
{{- if or $withCache (and $withTasks (not $split)) }}
- name: VALKEY_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $.Values.valkey.auth.passwordKey }}
{{- end }}
{{- if and $withTasks $split }}
- name: VALKEY_TASK_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $.Values.valkey.auth.taskPasswordKey }}
{{- end }}
{{- if $withCache }}
- name: CACHE_URL
  value: {{ printf "redis://default:$(VALKEY_PASSWORD)@%s:6379/0" (include "lumastra.valkeyCacheHost" $) | quote }}
{{- end }}
{{- if $withTasks }}
- name: TASK_CACHE_URL
  value: {{ printf "redis://default:$(%s)@%s:6379/0" (ternary "VALKEY_TASK_PASSWORD" "VALKEY_PASSWORD" $split) (include "lumastra.valkeyTasksHost" $) | quote }}
{{- end }}
{{- else }}
{{- $sec := required "valkey.external.existingSecret (or secrets.existingSecret) is required for external Valkey" (default $.Values.secrets.existingSecret $.Values.valkey.external.existingSecret) }}
{{- if $withCache }}
- name: CACHE_URL
  valueFrom:
    secretKeyRef: { name: {{ $sec }}, key: {{ $.Values.valkey.external.cacheUrlKey }} }
{{- end }}
{{- if $withTasks }}
- name: TASK_CACHE_URL
  valueFrom:
    secretKeyRef: { name: {{ $sec }}, key: {{ required "valkey.external.taskCacheUrlKey is required: tasks need a separate noeviction Valkey" $.Values.valkey.external.taskCacheUrlKey }} }
{{- end }}
{{- end }}
{{- end -}}

{{- /* DATABASE_URL env entry for the app. */ -}}
{{- define "lumastra.databaseEnv" -}}
{{- if eq .Values.database.mode "cnpg" }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ default (printf "%s-app" (include "lumastra.cnpgName" .)) .Values.database.cnpg.appSecret }}
      key: {{ .Values.database.cnpg.appSecretUriKey }}
{{- else if eq .Values.database.mode "external" }}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ required "database.external.existingSecret (or secrets.existingSecret) is required" (default .Values.secrets.existingSecret .Values.database.external.existingSecret) }}
      key: {{ .Values.database.external.urlKey }}
{{- else }}
{{- fail "database.mode must be external or cnpg" }}
{{- end }}
{{- end -}}

{{- /* STREAM_PROXY_SECRET env entry (proxy enabled only). */ -}}
{{- define "lumastra.proxySecretEnv" -}}
{{- if .Values.proxy.enabled }}
- name: STREAM_PROXY_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ required "proxy.secret.name (or secrets.existingSecret) is required when proxy.enabled" (default .Values.secrets.existingSecret .Values.proxy.secret.name) }}
      key: {{ .Values.proxy.secret.key }}
{{- end }}
{{- end -}}

{{- /* secrets.env → secretKeyRef entries (sorted, deterministic). */ -}}
{{- define "lumastra.secretEnv" -}}
{{- $ := . -}}
{{- range $name := keys .Values.secrets.env | sortAlpha }}
{{- $v := get $.Values.secrets.env $name }}
{{- $secret := $.Values.secrets.existingSecret }}
{{- $key := "" }}
{{- $optional := false }}
{{- if kindIs "string" $v }}{{ $key = $v }}{{ else if kindIs "map" $v }}{{ $secret = default $secret $v.secret }}{{ $key = default $name $v.key }}{{ $optional = default false $v.optional }}{{ end }}
{{- if not $secret }}
{{- fail (printf "secrets.env.%s: no Secret to read it from — set secrets.existingSecret or give the entry {secret, key}" $name) }}
{{- end }}
{{- if $key }}
- name: {{ $name }}
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: {{ $key }}
      {{- if $optional }}
      optional: true
      {{- end }}
{{- end }}
{{- end }}
{{- end -}}

{{- /* Pod identity + placement via the Downward API (no ServiceAccount token, no RBAC).
INSTANCE_ID = pod name (stable per StatefulSet ordinal). The K8S_* vars are display-only: the
cluster heartbeat publishes them so /admin/system/health?tab=cluster shows which node a pod runs
on and its CPU/memory requests next to the cgroup usage. requests.* read 0 when unset. */ -}}
{{- define "lumastra.podIdentityEnv" -}}
- name: INSTANCE_ID
  valueFrom:
    fieldRef: { fieldPath: metadata.name }
- name: K8S_NODE_NAME
  valueFrom:
    fieldRef: { fieldPath: spec.nodeName }
- name: K8S_POD_IP
  valueFrom:
    fieldRef: { fieldPath: status.podIP }
- name: K8S_NAMESPACE
  valueFrom:
    fieldRef: { fieldPath: metadata.namespace }
- name: K8S_CPU_REQUEST_MILLICORES
  valueFrom:
    resourceFieldRef: { resource: requests.cpu, divisor: 1m }
- name: K8S_MEMORY_REQUEST_BYTES
  valueFrom:
    resourceFieldRef: { resource: requests.memory, divisor: "1" }
{{- end -}}

{{- /* Free-form env map → list, sorted. */ -}}
{{- define "lumastra.envMap" -}}
{{- range $k := keys . | sortAlpha }}
- name: {{ $k }}
  value: {{ get $ $k | toString | quote }}
{{- end }}
{{- end -}}

{{- /* Is a component one of gpu.components? (list $ "web") */ -}}
{{- define "lumastra.gpuFor" -}}
{{- $ := index . 0 -}}
{{- if and (ne $.Values.gpu.mode "none") (has (index . 1) $.Values.gpu.components) -}}true{{- end -}}
{{- end -}}

{{- /* Library readOnly for a component: explicit value, else !alongside*. (list $ lib "web") */ -}}
{{- define "lumastra.libraryReadOnly" -}}
{{- $ := index . 0 -}}
{{- $lib := index . 1 -}}
{{- $comp := index . 2 -}}
{{- $default := not (hasPrefix "alongside" $.Values.app.metadataStorageLocation) -}}
{{- $ro := $default -}}
{{- if kindIs "bool" $lib.readOnly -}}
{{- $ro = $lib.readOnly -}}
{{- else if kindIs "map" $lib.readOnly -}}
{{- if hasKey $lib.readOnly $comp -}}{{ $ro = get $lib.readOnly $comp }}{{- end -}}
{{- end -}}
{{- ternary "true" "false" $ro -}}
{{- end -}}

{{- /* Volume source for a library entry. */ -}}
{{- define "lumastra.librarySource" -}}
{{- $n := 0 -}}
{{- if .hostPath }}{{ $n = add1 $n }}{{ end -}}
{{- if .existingClaim }}{{ $n = add1 $n }}{{ end -}}
{{- if .nfs }}{{ $n = add1 $n }}{{ end -}}
{{- if ne (int $n) 1 }}{{ fail (printf "library %q needs exactly one of hostPath, existingClaim, nfs" .name) }}{{ end -}}
{{- if .hostPath }}
hostPath:
  path: {{ .hostPath }}
  type: Directory
{{- else if .existingClaim }}
persistentVolumeClaim:
  claimName: {{ .existingClaim }}
{{- else }}
nfs:
  server: {{ .nfs.server }}
  path: {{ .nfs.path }}
{{- end }}
{{- end -}}

{{- /*
Replicas of a single-instance component: 0 (stopped) or 1. list <value path for the message> <value>.
A second worker would run every background task twice; a second sonic/Valkey/proxy pod would be an
independent instance with its own state.
*/ -}}
{{- define "lumastra.singleReplicas" -}}
{{- $n := index . 1 -}}
{{- /* toString: 0.5 or "2" must not truncate to 0/1 */ -}}
{{- if not (has (toString $n) (list "0" "1")) }}
{{- fail (printf "%s must be 0 or 1 (got %v): this component runs as a single instance" (index . 0) $n) }}
{{- end -}}
{{- int $n -}}
{{- end -}}

{{- /* Render-time validation of combinations that would deploy but not work. */ -}}
{{- define "lumastra.validate" -}}
{{- $v := .Values -}}
{{- if $v.valkey.single }}
{{- fail "valkey.single was removed: use separate cache and noeviction task Valkeys" }}
{{- end }}
{{- if ne $v.mode "split" }}
{{- fail "mode must be split: allInOne was removed; run web pods plus one dedicated worker" }}
{{- end }}
{{- if hasKey $v "allInOne" }}
{{- fail "allInOne values were removed; configure web and worker separately" }}
{{- end }}
{{- $fa := $v.auth.forwardAuth -}}
{{- if $fa.enabled }}
{{- if not $fa.trustedProxyIps }}
{{- fail "auth.forwardAuth.trustedProxyIps is required: the app ignores identity headers from any other peer (set the router pods' CIDR, i.e. your pod network)" }}
{{- end }}
{{- if and $v.networkPolicy.enabled (not $v.router.enabled) (not $v.networkPolicy.ingressFrom) (not $fa.allowWithoutNetworkPolicy) }}
{{- fail "auth.forwardAuth without the router needs networkPolicy.ingressFrom restricted to the authenticating proxy — an empty list lets every pod reach web:3000 and send identity headers" }}
{{- end }}
{{- end }}
{{- if lt (int $v.web.replicas) 0 }}
{{- fail "web.replicas must be >= 0" }}
{{- end }}
{{- $names := dict -}}
{{- range $v.libraries }}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]{0,52}[a-z0-9])?$" (toString .name)) }}
{{- fail (printf "libraries: name %q must be a lowercase DNS label (a-z, 0-9, '-', at most 54 characters)" (toString .name)) }}
{{- end }}
{{- if hasKey $names .name }}
{{- fail (printf "libraries: name %q is used twice" .name) }}
{{- end }}
{{- $_ := set $names .name true }}
{{- end }}
{{- include "lumastra.validateSignIn" (list . $v.web "web") }}
{{- include "lumastra.validateSignIn" (list . $v.worker "worker") }}
{{- end -}}

{{- /*
Fail when a pod would refuse to boot for lack of a sign-in method: (list $ componentValues name).
Mirrors the app's startup preflight (config-doctor checkForwardAuth, run by
scripts/startup-migration.ts). The app refuses when NODE_ENV=production, LUMASTRA_SKIP_PREFLIGHT
is not true, TRUSTED_PROXY_IPS is empty, LUMASTRA_TRUST_ANY_PROXY is not true, native login is
off, and OIDC lacks any of enabled/issuer/client id. Native and OIDC also read settings.json,
which the chart cannot see: auth.oidc.configuredInAdminUi skips the check. A value the chart
cannot read (a Secret, valueFrom, extraEnvFrom) counts as "might enable sign-in", so the chart
never rejects a config the app would accept.
*/ -}}
{{- define "lumastra.validateSignIn" -}}
{{- $ := index . 0 -}}
{{- $c := index . 1 -}}
{{- $v := $.Values -}}
{{- if and (not $v.auth.oidc.configuredInAdminUi) (not $c.extraEnvFrom) }}
{{- $e := include "lumastra.envData" $ | fromYaml -}}
{{- range $k, $val := (default dict $c.env) }}{{ $_ := set $e $k (toString $val) }}{{ end -}}
{{- $opaque := dict -}}
{{- range $k, $unused := (default dict $v.secrets.env) }}{{ $_ := set $opaque $k true }}{{ end -}}
{{- range (default list $c.extraEnv) }}
{{- if hasKey . "valueFrom" }}{{ $_ := set $opaque .name true }}{{ else }}{{ $_ := set $e .name (toString (default "" .value)) }}{{ end -}}
{{- end }}
{{- $truthy := list "1" "true" "yes" "on" -}}
{{- $ok := false -}}
{{- range $k := list "NODE_ENV" "LUMASTRA_SKIP_PREFLIGHT" "TRUSTED_PROXY_IPS" "LUMASTRA_TRUST_ANY_PROXY" "AUTH_NATIVE_LOGIN_ENABLED" "AUTH_OIDC_ENABLED" "AUTH_OIDC_ISSUER" "AUTH_OIDC_CLIENT_ID" }}
{{- if hasKey $opaque $k }}{{ $_ := set $e $k "<opaque>" }}{{ end -}}
{{- end }}
{{- $get := dict -}}
{{- range $k, $val := $e }}{{ $_ := set $get $k (trim (toString $val)) }}{{ end -}}
{{- if ne (get $get "NODE_ENV") "production" }}{{ $ok = true }}{{ end -}}
{{- if has (lower (get $get "LUMASTRA_SKIP_PREFLIGHT")) (list "true" "<opaque>") }}{{ $ok = true }}{{ end -}}
{{- if get $get "TRUSTED_PROXY_IPS" }}{{ $ok = true }}{{ end -}}
{{- if has (lower (get $get "LUMASTRA_TRUST_ANY_PROXY")) (list "true" "<opaque>") }}{{ $ok = true }}{{ end -}}
{{- if has (lower (get $get "AUTH_NATIVE_LOGIN_ENABLED")) (append $truthy "<opaque>") }}{{ $ok = true }}{{ end -}}
{{- if and (has (lower (get $get "AUTH_OIDC_ENABLED")) (append $truthy "<opaque>")) (get $get "AUTH_OIDC_ISSUER") (get $get "AUTH_OIDC_CLIENT_ID") }}{{ $ok = true }}{{ end -}}
{{- if not $ok }}
{{- fail (printf "%s: no sign-in method. Built-in login is off and neither OIDC (auth.oidc) nor forward-auth (auth.forwardAuth) is configured, so the app refuses to start. Set auth.native.enabled to true or null, or configure OIDC or forward-auth. If OIDC is configured only in the Admin UI (/config/settings.json of a migrated install), set auth.oidc.configuredInAdminUi: true." (index . 2)) }}
{{- end }}
{{- end }}
{{- end -}}

{{- /* integrations.<name> → [url env, public url env, api key env]. */ -}}
{{- define "lumastra.integrationVars" -}}
audiobookshelf: [AUDIOURL, PUBLIC_AUDIOBOOKURL, AUDIOAPIKEY]
kavita: [KAVITAURL, PUBLIC_KAVITAURL, KAVITAAPIKEY]
jellyfin: [JELLYFINURL, PUBLIC_JELLYFINURL, JELLYFINAPIKEY]
seerr: [SEERRURL, PUBLIC_REQUESTURL, SEERRAPIKEY]
sonarr: [SONARRURL, "", SONARRAPIKEY]
radarr: [RADARRURL, "", RADARRAPIKEY]
{{- end -}}

{{- /* Integration API keys → secretKeyRef env (sorted). */ -}}
{{- define "lumastra.integrationSecretEnv" -}}
{{- $ := . -}}
{{- $vars := include "lumastra.integrationVars" . | fromYaml -}}
{{- range $name := keys (default dict $.Values.integrations) | sortAlpha }}
{{- $i := get $.Values.integrations $name -}}
{{- if not (hasKey $vars $name) }}{{ fail (printf "integrations.%s is not a known integration (%s)" $name (keys $vars | sortAlpha | join ", ")) }}{{ end -}}
{{- $k := default dict $i.apiKey -}}
{{- if $k.key }}
{{- $envName := index (get $vars $name) 2 }}
{{- if hasKey (default dict $.Values.secrets.env) $envName }}{{ fail (printf "%s is set both in secrets.env and integrations.%s.apiKey — keep one" $envName $name) }}{{ end }}
- name: {{ $envName }}
  valueFrom:
    secretKeyRef:
      name: {{ required (printf "integrations.%s.apiKey.secret (or secrets.existingSecret) is required" $name) (default $.Values.secrets.existingSecret $k.secret) }}
      key: {{ $k.key }}
{{- end }}
{{- end }}
{{- end -}}

{{- /*
Router-hop active: the router renders the hop-secret init container (router.hop.enabled, default on,
and secrets.env has LUMASTRA_MASTER_KEY). Returns "true" or "".
*/ -}}
{{- define "lumastra.routerHopOn" -}}
{{- $r := .Values.router -}}
{{- $hopCfg := default dict $r.hop -}}
{{- $hopOn := ternary $hopCfg.enabled true (hasKey $hopCfg "enabled") -}}
{{- $mk := get (default dict .Values.secrets.env) "LUMASTRA_MASTER_KEY" -}}
{{- $mkSecret := .Values.secrets.existingSecret -}}
{{- $mkKey := "" -}}
{{- if kindIs "string" $mk }}{{ $mkKey = $mk }}{{ else if kindIs "map" $mk }}{{ $mkSecret = default $mkSecret $mk.secret }}{{ $mkKey = default "LUMASTRA_MASTER_KEY" $mk.key }}{{ end -}}
{{- if and $r.enabled $hopOn $mkSecret $mkKey }}true{{ end -}}
{{- end -}}

{{- /*
Whether a NetworkPolicy peer (one networkPolicy.ingressFrom entry) is narrow enough to count as a guard:
a non-empty podSelector, a non-empty namespaceSelector, or an ipBlock narrower than /16 (IPv6: /64 or
narrower). `{}` selectors and `0.0.0.0/0` select every pod. Returns "true" or "".
*/ -}}
{{- define "lumastra.npPeerNarrow" -}}
{{- $ps := default dict .podSelector -}}
{{- $ns := default dict .namespaceSelector -}}
{{- $ok := false -}}
{{- if or $ps.matchLabels $ps.matchExpressions }}{{ $ok = true }}{{ end -}}
{{- if or $ns.matchLabels $ns.matchExpressions }}{{ $ok = true }}{{ end -}}
{{- if .ipBlock }}
{{- $parts := splitList "/" (toString .ipBlock.cidr) }}
{{- if eq (len $parts) 2 }}
{{- $bits := int (index $parts 1) }}
{{- if contains ":" (index $parts 0) }}{{ if ge $bits 64 }}{{ $ok = true }}{{ end }}{{ else }}{{ if ge $bits 17 }}{{ $ok = true }}{{ end }}{{ end }}
{{- end }}
{{- end }}
{{- if $ok }}true{{ end -}}
{{- end -}}

{{- /*
Whether the router adopts X-Forwarded-For from a range any in-cluster pod may be in. Returns
"true" (wide), "false" (narrow) or "unknown" (router.realIp.fromCIDRs empty: the router adopts none).
Narrow = exact addresses, IPv4 /28 or narrower, IPv6 /120 or narrower (a node's pod range is usually a
/24, a /64 is a whole subnet); ::ffff: mapped ranges count as wide. A wide range is NOT a problem when a
NetworkPolicy keeps other pods away from the router: networkPolicy.enabled and a non-empty ingressFrom
whose every entry is narrow (lumastra.npPeerNarrow). That holds only if your CNI enforces NetworkPolicy.
*/ -}}
{{- define "lumastra.routerRealIpWide" -}}
{{- $r := .Values.router -}}
{{- $cidrs := default list $r.realIp.fromCIDRs -}}
{{- $wide := false -}}
{{- range $cidrs }}
{{- $c := toString . }}
{{- $parts := splitList "/" $c }}
{{- if hasPrefix "::ffff:" (lower $c) }}{{ $wide = true }}
{{- else if eq (len $parts) 2 }}
{{- $bits := int (index $parts 1) }}
{{- if contains ":" (index $parts 0) }}{{ if lt $bits 120 }}{{ $wide = true }}{{ end }}{{ else }}{{ if lt $bits 28 }}{{ $wide = true }}{{ end }}{{ end }}
{{- end }}
{{- end }}
{{- $from := default list .Values.networkPolicy.ingressFrom -}}
{{- $guarded := and .Values.networkPolicy.enabled (gt (len $from) 0) -}}
{{- range $from }}{{ if not (include "lumastra.npPeerNarrow" .) }}{{ $guarded = false }}{{ end }}{{ end -}}
{{- if eq (len $cidrs) 0 }}unknown{{ else if and $wide (not $guarded) }}true{{ else }}false{{ end -}}
{{- end -}}
