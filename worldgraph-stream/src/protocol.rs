use serde::{Deserialize, Serialize};
use wifi_densepose_worldgraph::{
    EnuPoint, WorldEdge, WorldEdgeId, WorldGraph, WorldId, WorldNode, SCHEMA_VERSION,
};

/// Current wire protocol version.
pub const PROTOCOL_VERSION: u16 = 1;

/// A versioned, ordered message in one producer epoch.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TwinEnvelope {
    /// Wire protocol version, independent from snapshot schema version.
    pub protocol_version: u16,
    /// Opaque producer epoch. A process restart must create a new value.
    pub stream_epoch: String,
    /// Monotonic sequence number within the epoch. Snapshots start at zero.
    pub seq: u64,
    /// State operation.
    pub message: TwinMessage,
}

impl TwinEnvelope {
    /// Construct a current-version envelope.
    #[must_use]
    pub fn new(epoch: impl Into<String>, seq: u64, message: TwinMessage) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            stream_epoch: epoch.into(),
            seq,
            message,
        }
    }
}

/// An idempotent graph state operation. Its serde representation is the
/// documented `{ "op": "...", ...fields }` browser contract.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TwinMessage {
    /// Complete graph state. Required to begin or change epoch.
    Snapshot {
        /// Schema version declared by the embedded graph snapshot.
        graph_schema_version: u16,
        /// Serialized RVF/WorldGraph JSON snapshot.
        rvf_json: String,
    },
    /// Insert or replace a node by its stable id.
    UpsertNode {
        /// Complete typed node payload.
        node: WorldNode,
    },
    /// Remove a node and all incident edges.
    RemoveNode {
        /// Stable node identity.
        id: WorldId,
    },
    /// Insert or replace an edge by stable id.
    UpsertEdge {
        /// Stable edge identity.
        id: WorldEdgeId,
        /// Source node identity.
        from: WorldId,
        /// Target node identity.
        to: WorldId,
        /// Complete typed relationship payload.
        edge: WorldEdge,
    },
    /// Remove an edge by stable id.
    RemoveEdge {
        /// Stable edge identity.
        id: WorldEdgeId,
    },
    /// Ephemeral viewer presence; never persisted in WorldGraph snapshots.
    Presence {
        /// Pseudonymous presence changes.
        updates: Vec<PresenceUpdate>,
    },
}

/// Pseudonymous ephemeral viewer position.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PresenceUpdate {
    /// Server-issued connection-local pseudonym.
    pub viewer_id: u64,
    /// Validated ENU coordinate.
    pub position: EnuPoint,
    /// False announces departure; clients may remove the marker.
    pub active: bool,
}

/// Result of applying an envelope.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The envelope was accepted and its sequence advanced.
    Applied,
    /// The sequence had already been applied.
    Duplicate,
}

/// Replica validation or graph mutation failure.
#[derive(Debug, thiserror::Error)]
pub enum ApplyError {
    /// The envelope uses an unsupported protocol version.
    #[error("unsupported twin protocol version {found} (expected {expected})")]
    UnsupportedVersion {
        /// Received version.
        found: u16,
        /// Supported version.
        expected: u16,
    },
    /// A new epoch or uninitialized replica received a delta before a snapshot.
    #[error("epoch {epoch} must begin with a snapshot")]
    EpochRequiresSnapshot {
        /// Epoch that requires a snapshot.
        epoch: String,
    },
    /// One or more sequence values were skipped.
    #[error("sequence gap in epoch {epoch}: expected {expected}, received {received}")]
    SequenceGap {
        /// Active stream epoch.
        epoch: String,
        /// Required next sequence.
        expected: u64,
        /// Received sequence.
        received: u64,
    },
    /// The graph rejected a snapshot or mutation.
    #[error("world graph apply failed: {0}")]
    Graph(#[from] wifi_densepose_worldgraph::WorldGraphError),
    /// Ephemeral presence may only originate from an authenticated viewer session.
    #[error("presence is a server-only stream message")]
    ServerOnlyPresence,
}

/// Client-side ordered state machine for an authoritative twin stream.
#[derive(Debug, Default)]
pub struct TwinReplica {
    graph: Option<WorldGraph>,
    epoch: Option<String>,
    last_seq: Option<u64>,
}

impl TwinReplica {
    /// Borrow the reconstructed graph after the first snapshot.
    #[must_use]
    pub fn graph(&self) -> Option<&WorldGraph> {
        self.graph.as_ref()
    }
    /// Return the active stream epoch.
    #[must_use]
    pub fn epoch(&self) -> Option<&str> {
        self.epoch.as_deref()
    }
    /// Return the last accepted sequence in the active epoch.
    #[must_use]
    pub fn last_seq(&self) -> Option<u64> {
        self.last_seq
    }

    /// Validate and apply one envelope atomically.
    pub fn apply(&mut self, envelope: TwinEnvelope) -> Result<ApplyOutcome, ApplyError> {
        if envelope.protocol_version != PROTOCOL_VERSION {
            return Err(ApplyError::UnsupportedVersion {
                found: envelope.protocol_version,
                expected: PROTOCOL_VERSION,
            });
        }
        let changing_epoch = self.epoch.as_deref() != Some(envelope.stream_epoch.as_str());
        if changing_epoch {
            if !matches!(envelope.message, TwinMessage::Snapshot { .. }) {
                return Err(ApplyError::EpochRequiresSnapshot {
                    epoch: envelope.stream_epoch,
                });
            }
        } else if let Some(last) = self.last_seq {
            if envelope.seq <= last {
                return Ok(ApplyOutcome::Duplicate);
            }
            let expected = last.saturating_add(1);
            if envelope.seq != expected {
                return Err(ApplyError::SequenceGap {
                    epoch: envelope.stream_epoch,
                    expected,
                    received: envelope.seq,
                });
            }
        }

        match envelope.message {
            TwinMessage::Snapshot {
                graph_schema_version,
                rvf_json,
            } => {
                if graph_schema_version == 0 || graph_schema_version > SCHEMA_VERSION {
                    return Err(ApplyError::Graph(
                        wifi_densepose_worldgraph::WorldGraphError::UnsupportedSchema {
                            found: graph_schema_version,
                            maximum: SCHEMA_VERSION,
                        },
                    ));
                }
                self.graph = Some(WorldGraph::from_json(rvf_json.as_bytes())?);
            }
            TwinMessage::UpsertNode { node } => {
                self.graph_mut(&envelope.stream_epoch)?.upsert_node(node);
            }
            TwinMessage::RemoveNode { id } => {
                self.graph_mut(&envelope.stream_epoch)?.remove_node(id);
            }
            TwinMessage::UpsertEdge { id, from, to, edge } => {
                self.graph_mut(&envelope.stream_epoch)?
                    .upsert_edge(id, from, to, edge)?;
            }
            TwinMessage::RemoveEdge { id } => {
                self.graph_mut(&envelope.stream_epoch)?.remove_edge(id);
            }
            TwinMessage::Presence { .. } => {
                let _ = self.graph_mut(&envelope.stream_epoch)?;
            }
        }
        self.epoch = Some(envelope.stream_epoch);
        self.last_seq = Some(envelope.seq);
        Ok(ApplyOutcome::Applied)
    }

    fn graph_mut(&mut self, epoch: &str) -> Result<&mut WorldGraph, ApplyError> {
        self.graph
            .as_mut()
            .ok_or_else(|| ApplyError::EpochRequiresSnapshot {
                epoch: epoch.into(),
            })
    }
}
