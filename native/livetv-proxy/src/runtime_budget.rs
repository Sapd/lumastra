// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Charge media until its LAST Bytes owner disappears, including HTTP responses
//! and compatibility carry-over. Reserve before allocation, never after reading.
use bytes::Bytes;
use std::{
    path::Path,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::io::AsyncReadExt;
const PROCESS_MEDIA_LIMIT: usize = 512 * 1024 * 1024;
struct Budget {
    used: AtomicUsize,
    limit: usize,
}
#[derive(Clone)]
pub struct MediaBudget {
    inner: Arc<Budget>,
}
impl MediaBudget {
    pub fn process() -> Self {
        Self {
            inner: budget().clone(),
        }
    }
    #[cfg(test)]
    pub(crate) fn with_limit(limit: usize) -> Self {
        Self {
            inner: Arc::new(Budget {
                used: AtomicUsize::new(0),
                limit,
            }),
        }
    }
    pub fn retained_bytes(&self) -> usize {
        self.inner.used.load(Ordering::Acquire)
    }
    pub async fn read_segment(&self, path: &Path) -> Result<Bytes, String> {
        read_with_budget(path, &self.inner).await
    }
}
struct Charge {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Budget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> Option<Charge> {
        self.used
            .try_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(bytes).filter(|next| *next <= self.limit)
            })
            .ok()?;
        Some(Charge {
            budget: self.clone(),
            bytes,
        })
    }
}
impl Drop for Charge {
    fn drop(&mut self) {
        self.budget.used.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}
struct OwnedMedia {
    data: Vec<u8>,
    _charge: Charge,
}
impl AsRef<[u8]> for OwnedMedia {
    fn as_ref(&self) -> &[u8] {
        &self.data
    }
}
fn budget() -> &'static Arc<Budget> {
    static GLOBAL: OnceLock<Arc<Budget>> = OnceLock::new();
    GLOBAL.get_or_init(|| {
        Arc::new(Budget {
            used: AtomicUsize::new(0),
            limit: PROCESS_MEDIA_LIMIT,
        })
    })
}
pub fn retained_bytes() -> usize {
    budget().used.load(Ordering::Acquire)
}
pub fn limit_bytes() -> usize {
    PROCESS_MEDIA_LIMIT
}
pub async fn read_segment(path: &Path) -> Result<Bytes, String> {
    MediaBudget::process().read_segment(path).await
}
async fn read_with_budget(path: &Path, budget: &Arc<Budget>) -> Result<Bytes, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "segment_unavailable")?;
    let length = file
        .metadata()
        .await
        .map_err(|_| "segment_unavailable")?
        .len();
    if length == 0 || length > crate::runtime_media::MAX_SEGMENT_BYTES as u64 {
        return Err("segment_size_limit".into());
    }
    let length = length as usize;
    let charge = budget.reserve(length).ok_or("media_memory_capacity")?;
    let mut data = vec![0; length];
    file.read_exact(&mut data)
        .await
        .map_err(|_| "segment_unavailable")?;
    let mut extra = [0];
    if file
        .read(&mut extra)
        .await
        .map_err(|_| "segment_unavailable")?
        != 0
    {
        return Err("segment_changed_during_publication".into());
    }
    Ok(Bytes::from_owner(OwnedMedia {
        data,
        _charge: charge,
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn last_response_or_carry_owner_releases_charge() {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(0),
            limit: 16,
        });
        let charge = budget.reserve(12).unwrap();
        assert!(budget.reserve(5).is_none());
        let media = Bytes::from_owner(OwnedMedia {
            data: vec![7; 12],
            _charge: charge,
        });
        let response = media.clone();
        let carry = media.slice(2..5);
        drop(media);
        drop(response);
        assert_eq!(budget.used.load(Ordering::Acquire), 12);
        assert!(budget.reserve(5).is_none());
        drop(carry);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
        assert!(budget.reserve(16).is_some());
    }
    #[test]
    fn concurrent_publications_share_one_atomic_limit() {
        let budget = Arc::new(Budget {
            used: AtomicUsize::new(0),
            limit: 16,
        });
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let budget = budget.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let charge = budget.reserve(8);
                    barrier.wait();
                    charge
                })
            })
            .collect();
        let charges: Vec<_> = threads
            .into_iter()
            .filter_map(|t| t.join().unwrap())
            .collect();
        assert_eq!(charges.len(), 2);
        assert_eq!(budget.used.load(Ordering::Acquire), 16);
        drop(charges);
        assert_eq!(budget.used.load(Ordering::Acquire), 0);
    }
}
