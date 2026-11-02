// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use super::{DEADLINE, Transport, UpstreamGuard};
use axum::http::{HeaderMap, Method};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::{Duration, sleep, timeout},
};
use url::Url;

const CHUNK_BYTES: usize = 64 * 1024;
const PAYLOAD_BYTES: usize = 64 * 1024 * 1024;

struct Origin {
    url: String,
    written: Arc<AtomicUsize>,
    closed: Arc<AtomicBool>,
    task: JoinHandle<()>,
}

impl Drop for Origin {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn origin(chunked: bool) -> Origin {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let written = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(AtomicBool::new(false));
    let progress = written.clone();
    let ended = closed.clone();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = async {
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                if stream.read(&mut byte).await? == 0 {
                    return Ok::<(), std::io::Error>(());
                }
                request.push(byte[0]);
            }
            let framing = if chunked {
                "Transfer-Encoding: chunked\r\n".into()
            } else {
                format!("Content-Length: {PAYLOAD_BYTES}\r\n")
            };
            stream
                .write_all(
                    format!("HTTP/1.1 200 OK\r\nConnection: close\r\n{framing}\r\n").as_bytes(),
                )
                .await?;
            for index in 0..PAYLOAD_BYTES / CHUNK_BYTES {
                let mut bytes = vec![(index % 251) as u8; CHUNK_BYTES];
                bytes[..4].copy_from_slice(&(index as u32).to_be_bytes());
                if chunked {
                    stream
                        .write_all(format!("{CHUNK_BYTES:x}\r\n").as_bytes())
                        .await?;
                }
                stream.write_all(&bytes).await?;
                if chunked {
                    stream.write_all(b"\r\n").await?;
                }
                progress.fetch_add(CHUNK_BYTES, Ordering::Relaxed);
            }
            if chunked {
                stream.write_all(b"0\r\n\r\n").await?;
            }
            stream.shutdown().await
        }
        .await;
        ended.store(true, Ordering::Relaxed);
    });
    Origin {
        url,
        written,
        closed,
        task,
    }
}

async fn blocked(origin: &Origin) -> usize {
    timeout(Duration::from_secs(5), async {
        loop {
            let before = origin.written.load(Ordering::Relaxed);
            sleep(Duration::from_millis(150)).await;
            if before > 0 && before == origin.written.load(Ordering::Relaxed) {
                assert!(
                    before < PAYLOAD_BYTES,
                    "origin completed without exercising backpressure"
                );
                assert!(!origin.closed.load(Ordering::Relaxed));
                return before;
            }
        }
    })
    .await
    .expect("origin never reached backpressure")
}

#[tokio::test]
async fn raw_body_survives_a_paced_consumers_pause() {
    for chunked in [false, true] {
        let origin = origin(chunked).await;
        let guard = UpstreamGuard::start(false, &origin.url).await.unwrap();
        let client = Transport::new(true, "").unwrap();
        let url = Url::parse(&guard.stream_url("http://8.8.8.8/large.ts").unwrap()).unwrap();
        let mut response = timeout(
            Duration::from_secs(5),
            client.request(&url, &Method::GET, HeaderMap::new()),
        )
        .await
        .unwrap()
        .unwrap();
        let before = blocked(&origin).await;
        sleep(DEADLINE + Duration::from_secs(2)).await;
        assert!(origin.written.load(Ordering::Relaxed) - before <= 1024 * 1024);
        assert!(
            !origin.closed.load(Ordering::Relaxed),
            "paced body was disconnected"
        );
        let mut received = 0usize;
        timeout(DEADLINE * 2, async {
            while let Some(bytes) = response.next().await.unwrap() {
                for byte in bytes {
                    let block = received / CHUNK_BYTES;
                    let position = received % CHUNK_BYTES;
                    let expected = if position < 4 {
                        (block as u32).to_be_bytes()[position]
                    } else {
                        (block % 251) as u8
                    };
                    assert_eq!(byte, expected, "payload byte {received}");
                    received += 1;
                }
            }
        })
        .await
        .expect("body did not finish after the consumer resumed");
        assert_eq!(received, PAYLOAD_BYTES);
        assert!(response.clean_end);
        assert!(!guard.failed());
        drop(response);
        timeout(Duration::from_secs(2), client.shutdown())
            .await
            .unwrap();
        timeout(Duration::from_secs(2), guard.shutdown())
            .await
            .unwrap();
    }
}

async fn wait_closed(origin: &Origin) {
    timeout(Duration::from_secs(2), async {
        while !origin.closed.load(Ordering::Relaxed) {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("cancelled consumer retained its provider connection");
}

#[tokio::test]
async fn blocked_raw_body_is_cancelled_by_disconnect_and_shutdown() {
    for shutdown in [false, true] {
        let origin = origin(false).await;
        let guard = UpstreamGuard::start(false, &origin.url).await.unwrap();
        let client = Transport::new(true, "").unwrap();
        let url = Url::parse(&guard.stream_url("http://8.8.8.8/cancel.ts").unwrap()).unwrap();
        let response = timeout(
            Duration::from_secs(5),
            client.request(&url, &Method::GET, HeaderMap::new()),
        )
        .await
        .unwrap()
        .unwrap();
        blocked(&origin).await;
        if shutdown {
            timeout(Duration::from_secs(2), guard.shutdown())
                .await
                .unwrap();
            // Prove guard shutdown itself closes upstream, before dropping the client.
            wait_closed(&origin).await;
        }
        drop(response);
        timeout(Duration::from_secs(2), client.shutdown())
            .await
            .unwrap();
        if !shutdown {
            wait_closed(&origin).await;
        }
        assert!(
            !guard.failed(),
            "intentional cancellation is not an upstream failure"
        );
        timeout(Duration::from_secs(2), guard.shutdown())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn consuming_raw_client_still_observes_provider_inactivity_deadline() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin_url = format!("http://{}", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut headers = Vec::new();
        let mut byte = [0];
        while !headers.ends_with(b"\r\n\r\n") {
            if socket.read(&mut byte).await.unwrap() == 0 {
                return;
            }
            headers.push(byte[0]);
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nraw-media-prefix-that-never-finishes").await.unwrap();
        let _ = socket.read(&mut byte).await;
    });
    let guard = UpstreamGuard::start(false, &origin_url).await.unwrap();
    let url = Url::parse(&guard.stream_url("http://8.8.8.8/idle.ts").unwrap()).unwrap();
    let mut socket = tokio::net::TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
        .await
        .unwrap();
    socket
        .write_all(
            format!(
                "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                url.path(),
                url.query().unwrap()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let start = std::time::Instant::now();
    let mut body = Vec::new();
    // A raw TCP client has no competing body-read timer that could hide the relay's timeout.
    let _ = timeout(Duration::from_secs(15), socket.read_to_end(&mut body))
        .await
        .expect("relay failed to end an idle provider response");
    assert!(start.elapsed() >= Duration::from_secs(9));
    assert!(body.ends_with(b"raw-media-prefix-that-never-finishes"));
    timeout(Duration::from_secs(2), guard.shutdown())
        .await
        .unwrap();
    timeout(Duration::from_secs(2), provider)
        .await
        .unwrap()
        .unwrap();
}
