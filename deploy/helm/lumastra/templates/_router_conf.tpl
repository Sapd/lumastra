{{- /*
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only

Router nginx.conf. Context: dict root r fa strip upstreams hop (see router.yaml).
*/ -}}
{{- define "lumastra.routerConf" -}}
{{- $r := .r -}}
{{- $fa := .fa -}}
{{- $strip := .strip -}}
{{- $upstreams := .upstreams -}}
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {
    worker_connections 4096;
}
http {
    server_tokens off;
    # Room for long identity header names (X-authentik-username …) in proxy_set_header.
    proxy_headers_hash_bucket_size 128;
    proxy_headers_hash_max_size 1024;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;

    resolver {{ default (printf "kube-dns.kube-system.svc.%s" $r.clusterDomain) $r.resolver }} valid={{ $r.dnsValid }} ipv6=off;
    resolver_timeout 3s;
    {{- if .hop }}
    # Router-hop secret (init container hop-secret): a `map "" $lumastra_hop { default "<secret>"; }`.
    include /etc/lumastra-router-hop/hop.conf;
    {{- else }}
    map "" $lumastra_hop { default ""; }
    {{- end }}
    {{- range $r.realIp.fromCIDRs }}
    set_real_ip_from {{ . }};
    {{- end }}
    {{- if $r.realIp.fromCIDRs }}
    real_ip_header {{ $r.realIp.header }};
    real_ip_recursive {{ ternary "on" "off" $r.realIp.recursive }};
    {{- end }}

    # Path only: query strings carry playback grants.
    # key= names WHICH hash key routed the request (grant/session/ip), never its value: the
    # grant is a credential and must not reach the log. session= is the PlaySessionId.
    log_format lumastra '$time_iso8601 $remote_addr "$request_method $uri" $status $body_bytes_sent '
                        'upstream=$upstream_addr rt=$request_time urt=$upstream_response_time '
                        'ust=$upstream_status key=$lumastra_route_kind session=$arg_playsessionid'
                        {{- if $fa.enabled }} ' aus=$lumastra_auth_status'{{ end }};
    access_log {{ ternary "/dev/stdout lumastra" "off" $r.accessLog }};

    map $http_x_forwarded_proto $lumastra_proto {
        ""      $scheme;
        default $http_x_forwarded_proto;
    }
    map $http_upgrade $lumastra_connection {
        ""      "";
        default upgrade;
    }
    # PlaySessionId (argument names match case-insensitively); preview-* ids hash by client IP.
    map $arg_playsessionid $lumastra_session_key {
        ""           "";
        ~^preview-   "";
        default      "s:$arg_playsessionid";
    }
    map "$arg_grant|$lumastra_session_key" $lumastra_route_key {
        ~^([^|]+)\|  "t:$1";
        ~^\|(.+)$    "$1";
        default      "ip:$remote_addr";
    }
    map $lumastra_route_key $lumastra_route_kind {
        ~^t:     token;
        ~^s:     session;
        default  ip;
    }

    # One line per web pod: nginx hashes over server lines; the addresses of ONE re-resolved
    # name would be round-robined instead. A pod without a Ready DNS record is skipped.
    # max_fails=0: readiness (DNS) is the health signal — one transient error must not move a
    # session's key to another pod. keepalive_timeout < Node's 5 s keepAliveTimeout, so nginx never
    # reuses a connection the app is closing (that error would retry on the NEXT ring point).
    upstream lumastra_web {
        zone lumastra_web 256k;
        hash $lumastra_route_key consistent;
        {{- range $upstreams }}
        server {{ . }}:3000 resolve max_fails=0;
        {{- else }}
        # web.replicas is 0 (stopped): a static placeholder, so nginx starts and answers 502
        # without re-resolving names of pods that do not exist.
        server 127.0.0.1:9 down;
        {{- end }}
        keepalive 64;
        keepalive_timeout 4s;
    }
    {{- with $r.extraHttpConfig }}
    {{- . | nindent 4 }}
    {{- end }}

    server {
        listen 8080;
        # nginx-generated redirects (e.g. a trailing slash) must stay relative: an absolute
        # one would carry this pod's own scheme and port (http://host:8080/...) to the client.
        absolute_redirect off;
        client_max_body_size {{ $r.clientMaxBodySize }};
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout {{ $r.proxyTimeoutSeconds }}s;
        proxy_send_timeout {{ $r.proxyTimeoutSeconds }}s;
        send_timeout {{ $r.proxyTimeoutSeconds }}s;
        proxy_next_upstream error timeout;
        proxy_next_upstream_tries 2;

        location = /__router/healthz {
            access_log off;
            default_type text/plain;
            return 200 "ok\n";
        }
        {{- if $fa.enabled }}

        location = /__lumastra_auth {
            internal;
            set $lumastra_auth_url "{{ $fa.url }}";
            proxy_pass $lumastra_auth_url;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            {{- /* no Host line = nginx sends the endpoint's own host ($proxy_host) */}}
            {{- with $fa.hostHeader }}
            proxy_set_header Host {{ . }};
            {{- end }}
            proxy_set_header X-Original-URL $lumastra_proto://$http_host$request_uri;
            proxy_set_header X-Original-URI $request_uri;
            proxy_set_header X-Original-Method $request_method;
            proxy_set_header X-Forwarded-Proto $lumastra_proto;
            proxy_set_header X-Forwarded-Host $http_host;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_ssl_server_name on;
            {{- if $fa.sslVerify }}
            proxy_ssl_verify on;
            proxy_ssl_verify_depth 4;
            proxy_ssl_trusted_certificate {{ $fa.caFile }};
            {{- end }}
            # auth_request turns any answer but 2xx/401/403 into a 500 for the client. A 3xx/4xx/5xx
            # or timeout from the endpoint (e.g. 404: the IdP does not know this Host) is answered
            # as 401 instead, so every location's `error_page 401` fallback applies: /api/v1/ and
            # the other passthrough paths go to the app without identity (Bearer still works, no
            # auth = the app's own 401), / goes to sign-in. Never to the app WITH forward-auth
            # identity. $lumastra_auth_status (access log aus=) keeps the endpoint's real answer.
            proxy_intercept_errors on;
            error_page 300 301 302 303 307 308 400 404 405 408 429 500 502 503 504 = @lumastra_auth_failed;
        }

        location @lumastra_auth_failed {
            return 401;
        }

        location @lumastra_signin {
            internal;
            {{- if $fa.relayCookies }}
            add_header Set-Cookie $lumastra_auth_cookie;
            {{- end }}
            {{- if $fa.signinUrl }}
            return 302 "{{ $fa.signinUrl }}";
            {{- else }}
            return 401;
            {{- end }}
        }
        {{- $passthrough := default list $fa.extraPassthroughPaths }}
        {{- if $fa.apiV1Passthrough }}{{ $passthrough = prepend $passthrough "/api/v1/" }}{{ end }}
        {{- /* Account-linking callbacks (MAL) need the browser identity, so they must not ride the
               /oauth/ bypass; the longer ^~ prefix wins over /oauth/ whatever bypassPaths holds.
               A values file without the key (helm upgrade --reuse-values) keeps it on. */}}
        {{- $oauthLinks := ternary $fa.oauthLinksPassthrough true (hasKey $fa "oauthLinksPassthrough") }}
        {{- if and $oauthLinks (not (has "/oauth/links/" $passthrough)) (not (has "/oauth/links/" (default list $fa.bypassPaths))) }}{{ $passthrough = prepend $passthrough "/oauth/links/" }}{{ end }}
        {{- if $passthrough }}

        location @lumastra_noauth {
            {{- include "lumastra.routerProxy" (dict "strip" $strip "resp" list "auth" false) | nindent 12 }}
        }
        {{- end }}
        {{- if $fa.outpost.enabled }}

        location ^~ {{ $fa.outpost.path }} {
            set $lumastra_outpost "{{ required "router.forwardAuth.outpost.origin is required" $fa.outpost.origin }}";
            proxy_pass $lumastra_outpost$request_uri;
            {{- with $fa.outpost.hostHeader }}
            proxy_set_header Host {{ . }};
            {{- end }}
            # Authentik picks the application by X-Forwarded-Host (falls back to Host).
            proxy_set_header X-Forwarded-Host $http_host;
            proxy_set_header X-Original-URL $lumastra_proto://$http_host$request_uri;
            proxy_set_header X-Forwarded-Proto $lumastra_proto;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_ssl_server_name on;
            {{- if $fa.sslVerify }}
            proxy_ssl_verify on;
            proxy_ssl_verify_depth 4;
            proxy_ssl_trusted_certificate {{ $fa.caFile }};
            {{- end }}
        }
        {{- end }}
        {{- range $fa.bypassPaths }}

        location ^~ {{ . }} {
            {{- include "lumastra.routerProxy" (dict "strip" $strip "resp" list "auth" false) | nindent 12 }}
        }
        {{- end }}
        {{- range $passthrough }}

        location ^~ {{ . }} {
            {{- include "lumastra.routerAuth" (dict "fa" $fa "fallback" "@lumastra_noauth") | nindent 12 }}
            {{- include "lumastra.routerProxy" (dict "strip" $strip "resp" $fa.responseHeaders "auth" true) | nindent 12 }}
        }
        {{- end }}

        location / {
            {{- include "lumastra.routerAuth" (dict "fa" $fa "fallback" "@lumastra_signin") | nindent 12 }}
            {{- include "lumastra.routerProxy" (dict "strip" $strip "resp" $fa.responseHeaders "auth" true) | nindent 12 }}
        }
        {{- else }}

        location / {
            {{- /* no forward-auth here: an outer edge may inject identity headers, keep them */}}
            {{- include "lumastra.routerProxy" (dict "strip" list "resp" list "auth" false) | nindent 12 }}
        }
        {{- end }}
        {{- with $r.extraServerConfig }}
        {{- . | nindent 8 }}
        {{- end }}
    }
}
{{- end -}}
