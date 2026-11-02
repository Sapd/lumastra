// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Bounds ordinary HTTP sockets after Hyper takes ownership of response frames.
//! A body-level timeout cannot protect a Bytes frame already waiting in Hyper's
//! socket writer. These deadlines therefore wrap the actual listener IO.

use axum::serve::Listener;
use std::{
    future::Future,
    io::{self, IoSlice},
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{Instant, Sleep},
};

pub const MAX_ACCEPTED_CONNECTIONS: usize = 512;
pub const WRITE_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(60);
pub const READ_INACTIVITY_TIMEOUT: Duration = Duration::from_secs(120);

/// Acquires a connection reservation before accepting a socket. Kernel backlog
/// entries do not allocate an HTTP task, request buffer, or media response here.
pub struct BoundedListener {
    listener: TcpListener,
    permits: Arc<Semaphore>,
    write_timeout: Duration,
}

impl BoundedListener {
    pub fn new(listener: TcpListener, max_connections: usize, write_timeout: Duration) -> Self {
        Self {
            listener,
            permits: Arc::new(Semaphore::new(
                max_connections.clamp(1, MAX_ACCEPTED_CONNECTIONS),
            )),
            write_timeout,
        }
    }
}

impl Listener for BoundedListener {
    type Io = BoundedIo<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        // This private semaphore is never closed. Cancellation while waiting for
        // TcpListener::accept drops the already-acquired reservation as well.
        let permit = self
            .permits
            .clone()
            .acquire_owned()
            .await
            .expect("connection semaphore is never closed");
        // Keep Axum's maintained transient accept-error retry/backoff behavior.
        let (socket, address) = Listener::accept(&mut self.listener).await;
        let _ = socket.set_nodelay(true);
        (
            BoundedIo::new(socket, permit, self.write_timeout, READ_INACTIVITY_TIMEOUT),
            address,
        )
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

/// The remote address of a connection, for routes that only loopback peers may use.
#[derive(Clone, Copy, Debug)]
pub struct PeerAddress(pub SocketAddr);

impl PeerAddress {
    pub fn is_loopback(&self) -> bool {
        self.0.ip().to_canonical().is_loopback()
    }
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, BoundedListener>>
    for PeerAddress
{
    fn connect_info(stream: axum::serve::IncomingStream<'_, BoundedListener>) -> Self {
        Self(*stream.remote_addr())
    }
}

/// Public because it is the listener's associated IO type. Its reservation stays
/// owned until Drop, including after a deadline has closed the underlying socket.
pub struct BoundedIo<T> {
    inner: Option<T>,
    _permit: OwnedSemaphorePermit,
    write_timeout: Duration,
    read_timeout: Duration,
    write_stall: Option<WriteStall>,
    read_idle: Pin<Box<Sleep>>,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum WriteOperation {
    Flush,
    Shutdown,
    Write,
}

struct WriteStall {
    operation: WriteOperation,
    timer: Pin<Box<Sleep>>,
}

impl<T> BoundedIo<T> {
    fn new(
        inner: T,
        permit: OwnedSemaphorePermit,
        write_timeout: Duration,
        read_timeout: Duration,
    ) -> Self {
        Self {
            inner: Some(inner),
            _permit: permit,
            write_timeout,
            read_timeout,
            write_stall: None,
            read_idle: Box::pin(tokio::time::sleep(read_timeout)),
        }
    }

    fn timeout_error() -> io::Error {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "HTTP connection inactivity timeout",
        )
    }

    fn expire(&mut self) -> io::Error {
        // Drop closes the TCP stream immediately even if the caller retains this
        // wrapper briefly while unwinding Hyper's response/body ownership.
        self.inner.take();
        Self::timeout_error()
    }

    fn activity(&mut self) {
        self.read_idle
            .as_mut()
            .reset(Instant::now() + self.read_timeout);
    }

    fn write_progress(&mut self) {
        self.write_stall = None;
        // A continuous feed has no new request bytes after its initial GET.
        // Successful outgoing media is activity for its read-idle deadline too.
        self.activity();
    }

    fn check_write_deadline(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if self.inner.is_none()
            || self
                .write_stall
                .as_mut()
                .is_some_and(|stall| stall.timer.as_mut().poll(cx).is_ready())
        {
            return Err(self.expire());
        }
        Ok(())
    }

    fn blocked_write(
        &mut self,
        cx: &mut Context<'_>,
        operation: WriteOperation,
    ) -> Poll<io::Result<()>> {
        if let Some(stall) = &mut self.write_stall {
            stall.operation = stall.operation.max(operation);
        } else {
            self.write_stall = Some(WriteStall {
                operation,
                timer: Box::pin(tokio::time::sleep(self.write_timeout)),
            });
        }
        // Poll registers the socket driver's waker with Tokio's timer. A peer
        // that never becomes writable still wakes this HTTP task at the deadline.
        match self.check_write_deadline(cx) {
            Ok(()) => Poll::Pending,
            Err(error) => Poll::Ready(Err(error)),
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for BoundedIo<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.inner.is_none() || this.read_idle.as_mut().poll(cx).is_ready() {
            return Poll::Ready(Err(this.expire()));
        }
        let previous = buffer.filled().len();
        let result = Pin::new(this.inner.as_mut().expect("checked IO")).poll_read(cx, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() > previous {
            this.activity();
        }
        result
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for BoundedIo<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if let Err(error) = this.check_write_deadline(cx) {
            return Poll::Ready(Err(error));
        }
        match Pin::new(this.inner.as_mut().expect("checked IO")).poll_write(cx, bytes) {
            Poll::Pending => this.blocked_write(cx, WriteOperation::Write).map_ok(|()| 0),
            Poll::Ready(Ok(count)) => {
                if count > 0 {
                    this.write_progress();
                }
                Poll::Ready(Ok(count))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        }
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffers: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if let Err(error) = this.check_write_deadline(cx) {
            return Poll::Ready(Err(error));
        }
        match Pin::new(this.inner.as_mut().expect("checked IO")).poll_write_vectored(cx, buffers) {
            Poll::Pending => this.blocked_write(cx, WriteOperation::Write).map_ok(|()| 0),
            Poll::Ready(Ok(count)) => {
                if count > 0 {
                    this.write_progress();
                }
                Poll::Ready(Ok(count))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner
            .as_ref()
            .is_some_and(AsyncWrite::is_write_vectored)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if let Err(error) = this.check_write_deadline(cx) {
            return Poll::Ready(Err(error));
        }
        match Pin::new(this.inner.as_mut().expect("checked IO")).poll_flush(cx) {
            Poll::Pending => this.blocked_write(cx, WriteOperation::Flush),
            Poll::Ready(Ok(())) => {
                // TcpStream::flush is immediately ready even when write is blocked.
                // It must not erase a deadline for a Hyper-held payload frame.
                if this
                    .write_stall
                    .as_ref()
                    .is_some_and(|stall| stall.operation == WriteOperation::Flush)
                {
                    this.write_stall = None;
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if let Err(error) = this.check_write_deadline(cx) {
            return Poll::Ready(Err(error));
        }
        match Pin::new(this.inner.as_mut().expect("checked IO")).poll_shutdown(cx) {
            Poll::Pending => this.blocked_write(cx, WriteOperation::Shutdown),
            Poll::Ready(Ok(())) => {
                if this
                    .write_stall
                    .as_ref()
                    .is_some_and(|stall| stall.operation == WriteOperation::Shutdown)
                {
                    this.write_stall = None;
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => Poll::Ready(Err(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, http::Response, routing::get};
    use bytes::Bytes;
    use futures_core::Stream;
    use std::{convert::Infallible, sync::Mutex};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        sync::oneshot,
        time::timeout,
    };

    async fn permit() -> (Arc<Semaphore>, OwnedSemaphorePermit) {
        let semaphore = Arc::new(Semaphore::new(1));
        let permit = semaphore.clone().acquire_owned().await.unwrap();
        (semaphore, permit)
    }

    #[tokio::test]
    async fn blocked_duplex_writer_expires_closes_io_and_releases_reservation_on_drop() {
        let (socket, mut peer) = tokio::io::duplex(1);
        let (semaphore, permit) = permit().await;
        let mut socket = BoundedIo::new(
            socket,
            permit,
            Duration::from_millis(20),
            READ_INACTIVITY_TIMEOUT,
        );
        let error = timeout(Duration::from_secs(1), socket.write_all(&[7; 1024]))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(socket.inner.is_none());
        let mut received = Vec::new();
        peer.read_to_end(&mut received).await.unwrap();
        assert_eq!(received, vec![7]);
        assert_eq!(semaphore.available_permits(), 0);
        drop(socket);
        assert_eq!(semaphore.available_permits(), 1);
    }

    #[tokio::test]
    async fn ready_empty_flush_cannot_reset_a_blocked_payload_write() {
        let (socket, _peer) = tokio::io::duplex(1);
        let (_, permit) = permit().await;
        let mut socket = BoundedIo::new(
            socket,
            permit,
            Duration::from_millis(15),
            READ_INACTIVITY_TIMEOUT,
        );
        socket.write_all(b"x").await.unwrap();
        let result = timeout(
            Duration::from_secs(1),
            std::future::poll_fn(
                |cx| match Pin::new(&mut socket).poll_write(cx, b"blocked") {
                    Poll::Pending => {
                        assert!(Pin::new(&mut socket).poll_flush(cx).is_ready());
                        Poll::Pending
                    }
                    Poll::Ready(result) => Poll::Ready(result),
                },
            ),
        )
        .await
        .unwrap();
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test]
    async fn healthy_media_writes_refresh_read_idle_without_incoming_request_bytes() {
        let (socket, mut peer) = tokio::io::duplex(1);
        let (_, permit) = permit().await;
        let socket = BoundedIo::new(
            socket,
            permit,
            Duration::from_millis(40),
            Duration::from_millis(25),
        );
        let (mut read, mut write) = tokio::io::split(socket);
        let writer = tokio::spawn(async move {
            for _ in 0..15 {
                write.write_all(b"x").await.unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            write
        });
        let reader = tokio::spawn(async move {
            let mut received = [0; 15];
            peer.read_exact(&mut received).await.unwrap();
            peer
        });
        let mut byte = [0];
        assert!(
            timeout(Duration::from_millis(60), read.read(&mut byte))
                .await
                .is_err()
        );
        let write = writer.await.unwrap();
        let _peer = reader.await.unwrap();
        assert_eq!(
            read.read(&mut byte).await.unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        drop(write);
    }

    #[tokio::test]
    async fn accepts_wait_for_io_drop_and_cancelled_accept_drops_its_reservation() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut listener = BoundedListener::new(listener, 1, WRITE_INACTIVITY_TIMEOUT);
        assert!(
            timeout(Duration::from_millis(10), listener.accept())
                .await
                .is_err()
        );
        assert_eq!(listener.permits.available_permits(), 1);
        let _first = TcpStream::connect(address).await.unwrap();
        let (first, _) = listener.accept().await;
        let _second = TcpStream::connect(address).await.unwrap();
        assert!(
            timeout(Duration::from_millis(20), listener.accept())
                .await
                .is_err()
        );
        assert_eq!(listener.permits.available_permits(), 0);
        drop(first);
        let (second, _) = timeout(Duration::from_secs(1), listener.accept())
            .await
            .unwrap();
        assert_eq!(listener.permits.available_permits(), 0);
        drop(second);
        assert_eq!(listener.permits.available_permits(), 1);
    }

    struct StuckControls;
    impl AsyncRead for StuckControls {
        fn poll_read(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            _: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }
    impl AsyncWrite for StuckControls {
        fn poll_write(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<io::Result<usize>> {
            Poll::Ready(Ok(bytes.len()))
        }
        fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
        fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    #[tokio::test]
    async fn pending_flush_and_shutdown_have_the_same_socket_deadline() {
        for shutdown in [false, true] {
            let (semaphore, permit) = permit().await;
            let mut socket = BoundedIo::new(
                StuckControls,
                permit,
                Duration::from_millis(15),
                READ_INACTIVITY_TIMEOUT,
            );
            let result = timeout(Duration::from_secs(1), async {
                if shutdown {
                    socket.shutdown().await
                } else {
                    socket.flush().await
                }
            })
            .await
            .unwrap();
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
            assert!(socket.inner.is_none());
            assert_eq!(
                socket.write(b"later").await.unwrap_err().kind(),
                io::ErrorKind::TimedOut
            );
            drop(socket);
            assert_eq!(semaphore.available_permits(), 1);
        }
    }

    struct MediaOwner {
        data: Vec<u8>,
        _alive: Arc<()>,
    }
    impl AsRef<[u8]> for MediaOwner {
        fn as_ref(&self) -> &[u8] {
            &self.data
        }
    }
    struct OneFrame {
        bytes: Option<Bytes>,
        yielded: Option<oneshot::Sender<()>>,
    }
    impl Stream for OneFrame {
        type Item = Result<Bytes, Infallible>;
        fn poll_next(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            if let Some(sender) = self.yielded.take() {
                let _ = sender.send(());
            }
            Poll::Ready(self.bytes.take().map(Ok))
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn actual_hyper_held_frame_is_released_and_next_client_can_enter_after_socket_stall() {
        use std::os::fd::AsRawFd;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let listener = BoundedListener::new(listener, 1, Duration::from_millis(40));
        let permits = listener.permits.clone();
        let alive = Arc::new(());
        let owner = Arc::downgrade(&alive);
        let bytes = Bytes::from_owner(MediaOwner {
            data: vec![1; 16 * 1024 * 1024],
            _alive: alive,
        });
        let (yielded, observed) = oneshot::channel();
        let frame = Arc::new(Mutex::new(Some(OneFrame {
            bytes: Some(bytes),
            yielded: Some(yielded),
        })));
        let app = Router::new().route(
            "/",
            get(move || {
                let frame = frame.lock().unwrap().take();
                async move {
                    Response::new(match frame {
                        Some(frame) => Body::from_stream(frame),
                        None => Body::from("healthy"),
                    })
                }
            }),
        );
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        let mut slow = TcpStream::connect(address).await.unwrap();
        let small_buffer: libc::c_int = 1024;
        // SAFETY: valid owned socket fd and correctly sized immutable integer.
        assert_eq!(
            unsafe {
                libc::setsockopt(
                    slow.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_RCVBUF,
                    std::ptr::from_ref(&small_buffer).cast(),
                    std::mem::size_of_val(&small_buffer) as libc::socklen_t,
                )
            },
            0
        );
        slow.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        timeout(Duration::from_secs(1), observed)
            .await
            .unwrap()
            .unwrap();
        assert!(
            owner.upgrade().is_some(),
            "Hyper must own the yielded frame while the peer refuses reads"
        );
        timeout(Duration::from_secs(2), async {
            while owner.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        // The blocked connection released its reservation, even though this peer
        // has not read the response and has not closed its side of the socket.
        let mut next = TcpStream::connect(address).await.unwrap();
        next.write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = String::new();
        timeout(Duration::from_secs(1), next.read_to_string(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.ends_with("healthy"), "{response}");
        drop(slow);
        stop.send(()).unwrap();
        timeout(Duration::from_secs(1), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(permits.available_permits(), 1);
    }
}
