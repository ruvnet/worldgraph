//! Bounded in-memory log of simulated frame envelopes, keyed by session.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use serde::Serialize;
use wifi_densepose_worldmodel::SimulatedFrameEnvelope;

use super::{validate::validate_envelope, SimulatedError, MAX_ENVELOPES_PER_SESSION, MAX_SESSIONS};

/// Position of an accepted envelope within its session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublishReceipt {
    /// Session the envelope was appended to.
    pub session_id: String,
    /// Epoch of the accepted envelope.
    pub epoch: u64,
    /// Sequence of the accepted envelope.
    pub sequence: u64,
}

/// One known session and the position of its newest accepted envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionSummary {
    /// Provider session identifier.
    pub session_id: String,
    /// Epoch of the newest accepted envelope.
    pub epoch: u64,
    /// Sequence of the newest accepted envelope.
    pub sequence: u64,
    /// Envelopes currently retained, at most [`MAX_ENVELOPES_PER_SESSION`].
    /// Evicted envelopes are not counted.
    pub envelope_count: usize,
}

/// Read cursor for [`SimulatedStore::list`].
///
/// `after_sequence` alone keeps envelopes whose sequence is greater, in any
/// epoch. Adding `after_epoch` makes the cursor the pair
/// `(after_epoch, after_sequence)`, compared lexicographically, so a reader
/// can resume across an epoch change where sequences restart. `after_epoch`
/// alone keeps envelopes from later epochs only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ListCursor {
    /// Exclusive epoch bound.
    pub after_epoch: Option<u64>,
    /// Exclusive sequence bound.
    pub after_sequence: Option<u64>,
}

impl ListCursor {
    fn admits(self, epoch: u64, sequence: u64) -> bool {
        match (self.after_epoch, self.after_sequence) {
            (Some(e), Some(s)) => (epoch, sequence) > (e, s),
            (Some(e), None) => epoch > e,
            (None, Some(s)) => sequence > s,
            (None, None) => true,
        }
    }
}

struct SessionLog {
    epoch: u64,
    sequence: u64,
    envelopes: VecDeque<SimulatedFrameEnvelope>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, SessionLog>,
    /// Session ids in creation order; the front is evicted first.
    created: VecDeque<String>,
}

/// Bounded, in-memory store for simulated world-model output.
///
/// Cloning is cheap and every clone shares the same state. Nothing is written
/// to disk, and only envelopes (frame descriptors and provenance) are held;
/// media bytes never enter the store.
///
/// Bounds: at most [`MAX_SESSIONS`] sessions and [`MAX_ENVELOPES_PER_SESSION`]
/// envelopes per session. A new session beyond the bound evicts the session
/// that was created first; a new envelope beyond the bound evicts that
/// session's oldest envelope.
///
/// Ordering: within a session the epoch never decreases and the sequence
/// strictly increases within an epoch. The newest accepted position survives
/// envelope eviction, so replaying an evicted envelope is still a conflict.
/// It does not survive eviction of the whole session: an evicted session id
/// that publishes again starts a fresh session.
#[derive(Clone, Default)]
pub struct SimulatedStore {
    inner: Arc<Mutex<Inner>>,
}

impl SimulatedStore {
    /// Create an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Validate an envelope and append it to its session.
    ///
    /// Returns [`SimulatedError::Invalid`] for a malformed envelope and
    /// [`SimulatedError::OutOfOrder`] for a duplicate or out-of-order
    /// position. A rejected envelope changes nothing.
    pub fn publish(
        &self,
        envelope: SimulatedFrameEnvelope,
    ) -> Result<PublishReceipt, SimulatedError> {
        validate_envelope(&envelope)?;
        let receipt = PublishReceipt {
            session_id: envelope.session_id.clone(),
            epoch: envelope.epoch,
            sequence: envelope.sequence,
        };
        let mut inner = self.lock();
        if let Some(log) = inner.sessions.get_mut(&envelope.session_id) {
            let in_order = envelope.epoch > log.epoch
                || (envelope.epoch == log.epoch && envelope.sequence > log.sequence);
            if !in_order {
                return Err(SimulatedError::OutOfOrder {
                    session_id: receipt.session_id,
                    epoch: envelope.epoch,
                    sequence: envelope.sequence,
                    latest_epoch: log.epoch,
                    latest_sequence: log.sequence,
                });
            }
            if log.envelopes.len() >= MAX_ENVELOPES_PER_SESSION {
                log.envelopes.pop_front();
            }
            log.epoch = envelope.epoch;
            log.sequence = envelope.sequence;
            log.envelopes.push_back(envelope);
            return Ok(receipt);
        }
        while inner.sessions.len() >= MAX_SESSIONS {
            let Some(oldest) = inner.created.pop_front() else {
                break;
            };
            inner.sessions.remove(&oldest);
        }
        inner.created.push_back(receipt.session_id.clone());
        inner.sessions.insert(
            receipt.session_id.clone(),
            SessionLog {
                epoch: envelope.epoch,
                sequence: envelope.sequence,
                envelopes: VecDeque::from([envelope]),
            },
        );
        Ok(receipt)
    }

    /// Return up to `limit` retained envelopes of one session, oldest first,
    /// that lie after `cursor`. An unknown session yields an empty list.
    #[must_use]
    pub fn list(
        &self,
        session_id: &str,
        cursor: ListCursor,
        limit: usize,
    ) -> Vec<SimulatedFrameEnvelope> {
        self.lock()
            .sessions
            .get(session_id)
            .map(|log| {
                log.envelopes
                    .iter()
                    .filter(|e| cursor.admits(e.epoch, e.sequence))
                    .take(limit)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Summarize every known session, in creation order.
    #[must_use]
    pub fn sessions(&self) -> Vec<SessionSummary> {
        let inner = self.lock();
        inner
            .created
            .iter()
            .filter_map(|id| {
                inner.sessions.get(id).map(|log| SessionSummary {
                    session_id: id.clone(),
                    epoch: log.epoch,
                    sequence: log.sequence,
                    envelope_count: log.envelopes.len(),
                })
            })
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Every mutation completes under the lock without panicking paths
        // between related writes, so a poisoned guard still holds valid state.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::envelope;
    use super::*;

    fn positions(store: &SimulatedStore, session: &str, cursor: ListCursor) -> Vec<(u64, u64)> {
        store
            .list(session, cursor, usize::MAX)
            .iter()
            .map(|e| (e.epoch, e.sequence))
            .collect()
    }

    #[test]
    fn enforces_epoch_and_sequence_order_per_session() {
        let store = SimulatedStore::new();
        store.publish(envelope("a", 1, 5)).unwrap();
        // Duplicate, lower sequence, and older epoch are all conflicts.
        for (epoch, sequence) in [(1, 5), (1, 4), (0, 9)] {
            let err = store.publish(envelope("a", epoch, sequence)).unwrap_err();
            assert_eq!(
                err,
                SimulatedError::OutOfOrder {
                    session_id: "a".into(),
                    epoch,
                    sequence,
                    latest_epoch: 1,
                    latest_sequence: 5,
                }
            );
        }
        // Gaps are allowed; a newer epoch may restart its sequence.
        store.publish(envelope("a", 1, 9)).unwrap();
        store.publish(envelope("a", 2, 0)).unwrap();
        // Sessions are independent.
        store.publish(envelope("b", 0, 0)).unwrap();
        assert_eq!(
            positions(&store, "a", ListCursor::default()),
            [(1, 5), (1, 9), (2, 0)]
        );
    }

    #[test]
    fn rejected_envelopes_leave_the_store_untouched() {
        let store = SimulatedStore::new();
        let mut bad = envelope("a", 0, 0);
        bad.chunk.provenance.simulated = false;
        assert!(matches!(
            store.publish(bad),
            Err(SimulatedError::Invalid(_))
        ));
        assert!(store.sessions().is_empty());
        store.publish(envelope("a", 0, 3)).unwrap();
        store.publish(envelope("a", 0, 2)).unwrap_err();
        assert_eq!(store.sessions()[0].sequence, 3);
        assert_eq!(store.sessions()[0].envelope_count, 1);
    }

    #[test]
    fn cursor_filters_by_sequence_and_optionally_epoch() {
        let store = SimulatedStore::new();
        for (epoch, sequence) in [(0, 1), (0, 2), (1, 0), (1, 1)] {
            store.publish(envelope("a", epoch, sequence)).unwrap();
        }
        let cursor = |after_epoch, after_sequence| ListCursor {
            after_epoch,
            after_sequence,
        };
        assert_eq!(
            positions(&store, "a", cursor(None, Some(1))),
            [(0, 2)],
            "sequence-only cursor ignores epochs"
        );
        assert_eq!(
            positions(&store, "a", cursor(Some(0), Some(1))),
            [(0, 2), (1, 0), (1, 1)]
        );
        assert_eq!(
            positions(&store, "a", cursor(Some(0), None)),
            [(1, 0), (1, 1)]
        );
        assert_eq!(store.list("a", ListCursor::default(), 2).len(), 2);
        assert!(store.list("missing", ListCursor::default(), 10).is_empty());
    }

    #[test]
    fn evicts_oldest_envelope_but_still_rejects_its_replay() {
        let store = SimulatedStore::new();
        for sequence in 0..=MAX_ENVELOPES_PER_SESSION as u64 {
            store.publish(envelope("a", 0, sequence)).unwrap();
        }
        let kept = positions(&store, "a", ListCursor::default());
        assert_eq!(kept.len(), MAX_ENVELOPES_PER_SESSION);
        assert_eq!(kept[0], (0, 1));
        assert_eq!(kept[kept.len() - 1], (0, MAX_ENVELOPES_PER_SESSION as u64));
        assert_eq!(
            store.sessions()[0].envelope_count,
            MAX_ENVELOPES_PER_SESSION
        );
        assert!(matches!(
            store.publish(envelope("a", 0, 0)),
            Err(SimulatedError::OutOfOrder { .. })
        ));
    }

    #[test]
    fn evicts_the_first_created_session_when_full() {
        let store = SimulatedStore::new();
        for index in 0..MAX_SESSIONS {
            store.publish(envelope(&format!("s{index}"), 0, 0)).unwrap();
        }
        // Activity on the oldest session does not protect it: eviction is by
        // creation order.
        store.publish(envelope("s0", 0, 1)).unwrap();
        store.publish(envelope("new", 0, 0)).unwrap();
        let ids: Vec<_> = store.sessions().into_iter().map(|s| s.session_id).collect();
        assert_eq!(ids.len(), MAX_SESSIONS);
        assert_eq!(ids[0], "s1");
        assert_eq!(ids[ids.len() - 1], "new");
        assert!(store.list("s0", ListCursor::default(), 10).is_empty());
    }

    #[test]
    fn clones_share_state() {
        let store = SimulatedStore::new();
        store.clone().publish(envelope("a", 0, 0)).unwrap();
        assert_eq!(store.sessions().len(), 1);
    }
}
