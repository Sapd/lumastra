// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Redirect pinning: failover, renewal, fencing and HEAD behaviour of the relay.
use super::{GuardFailureInfo, Transport, UpstreamGuard, pin_allowed};
use std::{
    future::Future,
    net::IpAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
    task::JoinHandle,
    time::{sleep, timeout},
};
use url::Url;

struct Origin {
    url: String,
    task: JoinHandle<()>,
}
impl Drop for Origin {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn origin<F, Fut>(handler: F) -> Origin
where
    F: Fn(String) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = String> + Send + 'static,
{
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let handler = Arc::new(handler);
    let task = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let handler = handler.clone();
            connections.spawn(async move {
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 100_000 {
                    if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    request.push(byte[0]);
                }
                let reply = handler(String::from_utf8_lossy(&request).into_owned()).await;
                let _ = stream.write_all(reply.as_bytes()).await;
            });
        }
    });
    Origin { url, task }
}
fn response(status: u16, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
        body.len()
    )
}
fn live(sequence: u64) -> String {
    format!(
        "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n#EXTINF:3,\nsegment.ts\n"
    )
}
async fn send(url: &str, method: &str) -> (u16, String) {
    let url = Url::parse(url).unwrap();
    let mut stream = tokio::net::TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
        .await
        .unwrap();
    let request = format!(
        "{method} {}?{} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        url.path(),
        url.query().unwrap_or("")
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    timeout(Duration::from_secs(10), stream.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    let text = String::from_utf8(bytes).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").unwrap();
    (
        head.split_whitespace().nth(1).unwrap().parse().unwrap(),
        body.to_owned(),
    )
}
async fn get(url: &str) -> (u16, String) {
    send(url, "GET").await
}
fn pin_of(guard: &UpstreamGuard, key: &str) -> Option<Url> {
    guard.state.playlist_routes.lock().unwrap().peek(key)
}
/// A reply for the request line: HEAD answers carry no body.
fn answer(request: &str, status: u16, body: &str) -> String {
    if request.starts_with("HEAD") {
        response(status, "", "")
    } else {
        response(status, "", body)
    }
}

#[tokio::test]
async fn dead_pinned_destination_fails_over_after_three_failures() {
    for mode in ["reset", "500", "502", "503"] {
        let entries = Arc::new(AtomicUsize::new(0));
        let down = Arc::new(AtomicBool::new(false));
        let (seen, off) = (entries.clone(), down.clone());
        let proxy = origin(move |r| {
            let (seen, off) = (seen.clone(), off.clone());
            async move {
                if r.contains("/entry ") {
                    let n = seen.fetch_add(1, Ordering::Relaxed);
                    response(
                        302,
                        if n == 0 {
                            "Location: /a\r\n"
                        } else {
                            "Location: /b\r\n"
                        },
                        "",
                    )
                } else if r.contains("/a ") {
                    if !off.load(Ordering::Relaxed) {
                        response(200, "", &live(10))
                    } else if mode == "reset" {
                        String::new()
                    } else {
                        response(mode.parse().unwrap(), "", "down")
                    }
                } else {
                    response(200, "", &live(100))
                }
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
        assert!(get(&url).await.1.contains("SEQUENCE:10\n"));
        down.store(true, Ordering::Relaxed);
        for _ in 0..2 {
            let r = get(&url).await;
            assert_eq!(r.0, 200, "{mode}");
            assert!(r.1.contains("SEQUENCE:10\n"), "{mode}");
            assert_eq!(entries.load(Ordering::Relaxed), 1, "{mode}");
        }
        let r = get(&url).await;
        assert_eq!(r.0, 200, "{mode}");
        assert!(r.1.contains("SEQUENCE:100\n"), "{mode}: {}", r.1);
        assert_eq!(entries.load(Ordering::Relaxed), 2, "{mode}");
        guard.shutdown().await;
    }
}

#[tokio::test]
async fn pinned_host_refusing_connections_fails_over() {
    let dead = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let dead_port = dead.local_addr().unwrap().port();
    // Serves exactly one request, then the listener is gone: later connects are refused.
    let once = tokio::spawn(async move {
        let (mut stream, _) = dead.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                return;
            }
            request.push(byte[0]);
        }
        let _ = stream
            .write_all(response(200, "", &live(10)).as_bytes())
            .await;
    });
    let entries = Arc::new(AtomicUsize::new(0));
    let seen = entries.clone();
    let entry = origin(move |r| {
        let seen = seen.clone();
        async move {
            if r.starts_with("GET /entry ") {
                if seen.fetch_add(1, Ordering::Relaxed) == 0 {
                    response(
                        302,
                        &format!("Location: http://127.0.0.1:{dead_port}/a\r\n"),
                        "",
                    )
                } else {
                    response(302, "Location: /b\r\n", "")
                }
            } else {
                response(200, "", &live(100))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(true, "").await.unwrap();
    let url = guard.stream_url(&format!("{}/entry", entry.url)).unwrap();
    assert!(get(&url).await.1.contains("SEQUENCE:10\n"));
    once.await.unwrap();
    for _ in 0..2 {
        assert_eq!(get(&url).await.0, 200);
        assert_eq!(entries.load(Ordering::Relaxed), 1);
    }
    let r = get(&url).await;
    assert!(r.1.contains("SEQUENCE:100\n"), "{}", r.1);
    assert_eq!(entries.load(Ordering::Relaxed), 2);
    guard.shutdown().await;
}

#[tokio::test]
async fn too_many_requests_never_fails_over() {
    let entries = Arc::new(AtomicUsize::new(0));
    let down = Arc::new(AtomicBool::new(false));
    let (seen, off) = (entries.clone(), down.clone());
    let proxy = origin(move |r| {
        let (seen, off) = (seen.clone(), off.clone());
        async move {
            if r.contains("/entry ") {
                seen.fetch_add(1, Ordering::Relaxed);
                response(302, "Location: /a\r\n", "")
            } else if off.load(Ordering::Relaxed) {
                response(429, "", "slow down")
            } else {
                response(200, "", &live(10))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
    let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
    assert_eq!(get(&url).await.0, 200);
    down.store(true, Ordering::Relaxed);
    for _ in 0..6 {
        assert_eq!(get(&url).await.0, 429);
    }
    assert_eq!(entries.load(Ordering::Relaxed), 1);
    assert!(pin_of(&guard, "http://8.8.8.8/entry").is_some());
    guard.shutdown().await;
}

/// Entry and pinned hostnames are resolved by a test resolver: the pinned name is public
/// once (creating the pin), then private.
async fn dns_guard(
    allow_private: bool,
    proxy: &str,
    private_after_first: bool,
) -> (UpstreamGuard, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let mut transport = Transport::new(allow_private, proxy).unwrap();
    transport.resolver = Some(Arc::new(move |host: &str| -> Vec<IpAddr> {
        if host == "cdn.example.test"
            && private_after_first
            && counted.fetch_add(1, Ordering::Relaxed) > 0
        {
            vec!["10.0.0.1".parse().unwrap()]
        } else {
            vec!["8.8.8.8".parse().unwrap()]
        }
    }));
    (
        UpstreamGuard::with_transport(transport).await.unwrap(),
        calls,
    )
}

#[tokio::test]
async fn pinned_hostname_is_rechecked_and_private_answers_are_not_renewed() {
    for allow_private in [false, true] {
        let entries = Arc::new(AtomicUsize::new(0));
        let seen = entries.clone();
        let proxy = origin(move |r| {
            let seen = seen.clone();
            async move {
                if r.contains("/entry ") {
                    seen.fetch_add(1, Ordering::Relaxed);
                    response(302, "Location: http://cdn.example.test/playlist\r\n", "")
                } else {
                    response(200, "", &live(10))
                }
            }
        })
        .await;
        let (guard, calls) = dns_guard(allow_private, &proxy.url, true).await;
        let key = "http://entry.example.test/entry";
        let url = guard.stream_url(key).unwrap();
        assert_eq!(get(&url).await.0, 200);
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        for _ in 0..5 {
            let r = get(&url).await;
            if allow_private {
                assert_eq!(r.0, 200);
            } else {
                assert_eq!(r.0, 403);
                assert_eq!(
                    guard.failure(),
                    Some(GuardFailureInfo {
                        status: 403,
                        diagnostic: "private upstream destination"
                    })
                );
            }
        }
        assert!(
            calls.load(Ordering::Relaxed) >= 2,
            "DNS re-checked per reload"
        );
        assert_eq!(
            entries.load(Ordering::Relaxed),
            1,
            "allow_private={allow_private}"
        );
        assert_eq!(
            pin_of(&guard, key).unwrap().as_str(),
            "http://cdn.example.test/playlist"
        );
        guard.shutdown().await;
    }
}

#[tokio::test]
async fn slow_renewal_falls_back_to_the_cache_and_renewed_manifest_is_cached() {
    let expired = Arc::new(AtomicBool::new(false));
    let slow = Arc::new(AtomicBool::new(false));
    let outage = Arc::new(AtomicBool::new(false));
    let (e, s, o) = (expired.clone(), slow.clone(), outage.clone());
    let n = Arc::new(AtomicUsize::new(0));
    let proxy = origin(move |r| {
        let (e, s, o, n) = (e.clone(), s.clone(), o.clone(), n.clone());
        async move {
            if r.contains("/entry ") {
                if n.fetch_add(1, Ordering::Relaxed) == 0 {
                    return response(302, "Location: /a\r\n", "");
                }
                if s.load(Ordering::Relaxed) {
                    sleep(Duration::from_secs(5)).await;
                }
                response(302, "Location: /b\r\n", "")
            } else if o.load(Ordering::Relaxed) {
                response(503, "", "offline")
            } else if r.contains("/a ") {
                if e.load(Ordering::Relaxed) {
                    response(403, "", "expired")
                } else {
                    response(200, "", &live(10))
                }
            } else {
                response(200, "", &live(100))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
    let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
    assert!(get(&url).await.1.contains("SEQUENCE:10\n"));
    expired.store(true, Ordering::Relaxed);
    slow.store(true, Ordering::Relaxed);
    let started = std::time::Instant::now();
    let r = get(&url).await;
    assert_eq!(r.0, 200, "a slow renewal must not become a 504");
    assert!(r.1.contains("SEQUENCE:10\n"));
    assert!(started.elapsed() < Duration::from_millis(3500));
    // Fast renewal: the renewed manifest is cached and survives a provider outage.
    slow.store(false, Ordering::Relaxed);
    let r = get(&url).await;
    assert!(r.1.contains("SEQUENCE:100\n"), "{}", r.1);
    outage.store(true, Ordering::Relaxed);
    let r = get(&url).await;
    assert_eq!(r.0, 200, "renewed manifest must be cached");
    assert!(r.1.contains("SEQUENCE:100\n"));
    guard.shutdown().await;
}

#[tokio::test]
async fn stale_request_fenced_by_a_newer_pin_retries_on_that_pin() {
    let armed = Arc::new(AtomicBool::new(false));
    let reached = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let entries = Arc::new(AtomicUsize::new(0));
    let (a, r1, r2, seen) = (
        armed.clone(),
        reached.clone(),
        release.clone(),
        entries.clone(),
    );
    let proxy = origin(move |r| {
        let (a, r1, r2, seen) = (a.clone(), r1.clone(), r2.clone(), seen.clone());
        async move {
            if r.contains("/entry ") {
                seen.fetch_add(1, Ordering::Relaxed);
                response(302, "Location: /a\r\n", "")
            } else if r.contains("/a ") {
                if a.load(Ordering::Relaxed) {
                    r1.notify_one();
                    r2.notified().await;
                    response(403, "", "expired")
                } else {
                    response(200, "", &live(10))
                }
            } else {
                response(200, "", &live(100))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
    let key = "http://8.8.8.8/entry";
    let url = guard.stream_url(key).unwrap();
    assert!(get(&url).await.1.contains("SEQUENCE:10\n"));
    armed.store(true, Ordering::Relaxed);
    let stale = tokio::spawn({
        let url = url.clone();
        async move { get(&url).await }
    });
    reached.notified().await;
    // A newer request re-pinned the entry to another server meanwhile.
    let newer = Url::parse("http://8.8.8.8/b").unwrap();
    assert!(
        guard
            .state
            .playlist_routes
            .lock()
            .unwrap()
            .set(key, Some(newer.clone()), 10_000)
    );
    release.notify_one();
    let r = stale.await.unwrap();
    assert_eq!(r.0, 200);
    assert!(r.1.contains("SEQUENCE:100\n"), "{}", r.1);
    assert_eq!(entries.load(Ordering::Relaxed), 1);
    assert_eq!(pin_of(&guard, key), Some(newer));
    guard.shutdown().await;
}

#[tokio::test]
async fn head_never_tombstones_or_renews() {
    for mode in ["403", "503", "reset"] {
        let entries = Arc::new(AtomicUsize::new(0));
        let down = Arc::new(AtomicBool::new(false));
        let (seen, off) = (entries.clone(), down.clone());
        let proxy = origin(move |r| {
            let (seen, off) = (seen.clone(), off.clone());
            async move {
                if r.contains("/entry ") {
                    seen.fetch_add(1, Ordering::Relaxed);
                    response(302, "Location: /a\r\n", "")
                } else if !off.load(Ordering::Relaxed) {
                    answer(&r, 200, &live(10))
                } else if mode == "reset" {
                    String::new()
                } else {
                    answer(&r, mode.parse().unwrap(), "down")
                }
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
        let key = "http://8.8.8.8/entry";
        let url = guard.stream_url(key).unwrap();
        assert_eq!(get(&url).await.0, 200);
        let pin = pin_of(&guard, key).unwrap();
        down.store(true, Ordering::Relaxed);
        for _ in 0..5 {
            let r = send(&url, "HEAD").await;
            assert_eq!(
                r.0,
                if mode == "reset" {
                    502
                } else {
                    mode.parse().unwrap()
                },
                "{mode}"
            );
        }
        assert_eq!(entries.load(Ordering::Relaxed), 1, "{mode}");
        assert_eq!(pin_of(&guard, key), Some(pin), "{mode}");
        // HEAD failures were not counted: two GET failures still keep the pin.
        if mode != "403" {
            for _ in 0..2 {
                get(&url).await;
            }
            assert_eq!(entries.load(Ordering::Relaxed), 1, "{mode}");
        }
        guard.shutdown().await;
    }
}

#[tokio::test]
async fn refusal_arriving_as_an_error_still_renews() {
    let expired = Arc::new(AtomicBool::new(false));
    let entries = Arc::new(AtomicUsize::new(0));
    let (off, seen) = (expired.clone(), entries.clone());
    let proxy = origin(move |r| {
        let (off, seen) = (off.clone(), seen.clone());
        async move {
            if r.contains("/entry ") {
                if seen.fetch_add(1, Ordering::Relaxed) == 0 {
                    response(302, "Location: /a\r\n", "")
                } else {
                    response(302, "Location: /b\r\n", "")
                }
            } else if r.contains("/a ") {
                if off.load(Ordering::Relaxed) {
                    // Declares more than it sends: the body read fails after the 403 headers.
                    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 100\r\n\r\nexpired".into()
                } else {
                    response(200, "", &live(10))
                }
            } else {
                response(200, "", &live(100))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
    let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
    assert_eq!(get(&url).await.0, 200);
    expired.store(true, Ordering::Relaxed);
    let r = get(&url).await;
    assert_eq!(r.0, 200);
    assert!(r.1.contains("SEQUENCE:100\n"), "{}", r.1);
    assert_eq!(entries.load(Ordering::Relaxed), 2);
    guard.shutdown().await;
}

#[tokio::test]
async fn pinned_200_that_is_not_a_playlist_drops_the_pin() {
    let broken = Arc::new(AtomicBool::new(false));
    let entries = Arc::new(AtomicUsize::new(0));
    let (off, seen) = (broken.clone(), entries.clone());
    let proxy = origin(move |r| {
        let (off, seen) = (off.clone(), seen.clone());
        async move {
            if r.contains("/entry ") {
                if seen.fetch_add(1, Ordering::Relaxed) == 0 {
                    response(302, "Location: /a\r\n", "")
                } else {
                    response(302, "Location: /b\r\n", "")
                }
            } else if r.contains("/a ") {
                if off.load(Ordering::Relaxed) {
                    response(200, "", "<html>please log in</html>")
                } else {
                    response(200, "", &live(10))
                }
            } else {
                response(200, "", &live(100))
            }
        }
    })
    .await;
    let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
    let key = "http://8.8.8.8/entry";
    let url = guard.stream_url(key).unwrap();
    assert_eq!(get(&url).await.0, 200);
    broken.store(true, Ordering::Relaxed);
    let r = get(&url).await;
    assert_eq!(r.0, 200);
    assert!(r.1.contains("SEQUENCE:100\n"), "{}", r.1);
    assert_eq!(entries.load(Ordering::Relaxed), 2);
    assert_eq!(pin_of(&guard, key).unwrap().path(), "/b");
    guard.shutdown().await;
}

#[test]
fn https_entries_are_never_pinned_to_plain_http() {
    let https = Url::parse("https://provider.example/entry").unwrap();
    let http = Url::parse("http://provider.example/entry").unwrap();
    let other = Url::parse("https://cdn.example/live").unwrap();
    let plain = Url::parse("http://cdn.example/live").unwrap();
    assert!(!pin_allowed(&https, &plain));
    assert!(pin_allowed(&https, &other));
    assert!(pin_allowed(&http, &plain));
    assert!(pin_allowed(&http, &other));
    assert!(pin_allowed(&http, &https));
}

#[test]
fn playlist_prefix_skips_bom_and_ascii_whitespace_case_sensitively() {
    use super::is_playlist_prefix as playlist;
    assert!(playlist(b"#EXTM3U\n"));
    assert!(playlist(b"\xEF\xBB\xBF#EXTM3U\n"));
    assert!(playlist(b"\xEF\xBB\xBF\r\n \t\r\n#EXTM3U\n"));
    assert!(playlist(b"\r\n\r\n#EXTM3U"));
    assert!(playlist(
        &[b"\xEF\xBB\xBF".as_slice(), &[b'\n'; 40], b"#EXTM3U"].concat()
    ));
    assert!(!playlist(b"#extm3u\n"));
    assert!(!playlist(b"<html>#EXTM3U"));
    assert!(!playlist(b""));
}

#[tokio::test]
async fn bom_or_whitespace_prefixed_playlist_keeps_the_pin() {
    for prefix in ["\u{feff}", "\r\n\r\n", "\u{feff}\r\n  \r\n\t\n"] {
        let entries = Arc::new(AtomicUsize::new(0));
        let seen = entries.clone();
        let body = format!("{prefix}{}", live(10));
        let proxy = origin(move |r| {
            let (seen, body) = (seen.clone(), body.clone());
            async move {
                if r.contains("/entry ") {
                    seen.fetch_add(1, Ordering::Relaxed);
                    response(302, "Location: /a\r\n", "")
                } else {
                    response(200, "", &body)
                }
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &proxy.url).await.unwrap();
        let key = "http://8.8.8.8/entry";
        let url = guard.stream_url(key).unwrap();
        for _ in 0..4 {
            let r = get(&url).await;
            assert_eq!(r.0, 200, "{prefix:?}");
            assert!(r.1.contains("SEQUENCE:10\n"), "{prefix:?}: {}", r.1);
        }
        assert_eq!(entries.load(Ordering::Relaxed), 1, "{prefix:?}");
        assert_eq!(pin_of(&guard, key).unwrap().path(), "/a");
        guard.shutdown().await;
    }
}
