use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use wifi_densepose_worldgraph::{
    WorldEdgeId, WorldEdgeRecord, WorldGraph, WorldGraphSnapshot, WorldId, WorldNode,
    SCHEMA_VERSION,
};

use crate::{TwinEnvelope, TwinMessage};

/// Authenticated identity and narrowly-scoped capabilities.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViewerClaims {
    /// Stable authenticated subject identifier.
    pub subject: String,
    /// Capabilities granted by the validated token.
    #[serde(default)]
    pub scopes: HashSet<String>,
    /// Absolute Unix expiry time in seconds.
    pub expires_at: u64,
}

impl ViewerClaims {
    /// Return whether the viewer owns `scope`.
    #[must_use]
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.contains(scope)
    }
}

/// Server-side authorization policy applied before serialization.
pub trait TwinAccessPolicy: Send + Sync {
    /// Decide whether a node may cross the viewer boundary.
    fn allows_node(&self, claims: &ViewerClaims, node: &WorldNode) -> bool;
    /// Decide whether an edge whose endpoints are visible may cross the boundary.
    fn allows_edge(&self, _claims: &ViewerClaims, _edge: &WorldEdgeRecord) -> bool {
        true
    }
}

/// Safe default: `twin:read` is mandatory; identity and semantic beliefs also
/// require the explicit `twin:sensitive` capability.
#[derive(Clone, Copy, Debug, Default)]
pub struct DefaultAccessPolicy;
impl TwinAccessPolicy for DefaultAccessPolicy {
    fn allows_node(&self, claims: &ViewerClaims, node: &WorldNode) -> bool {
        claims.has_scope("twin:read")
            && (!matches!(
                node,
                WorldNode::PersonTrack { .. } | WorldNode::SemanticState { .. }
            ) || claims.has_scope("twin:sensitive"))
    }
}

/// Stateful projector shared by snapshots and deltas. It resequences the
/// filtered stream so hidden deltas do not create client-visible gaps.
pub struct AccessProjector<P> {
    policy: P,
    claims: ViewerClaims,
    visible_nodes: HashSet<WorldId>,
    visible_edges: HashSet<WorldEdgeId>,
    edge_endpoints: HashMap<WorldEdgeId, (WorldId, WorldId)>,
    output_seq: Option<u64>,
    epoch: Option<String>,
}

impl<P: TwinAccessPolicy> AccessProjector<P> {
    /// Create an empty visibility projection for validated claims.
    #[must_use]
    pub fn new(policy: P, claims: ViewerClaims) -> Self {
        Self {
            policy,
            claims,
            visible_nodes: HashSet::new(),
            visible_edges: HashSet::new(),
            edge_endpoints: HashMap::new(),
            output_seq: None,
            epoch: None,
        }
    }

    /// Replace authorization after token refresh without restarting the wire
    /// epoch or sequence. Visibility is rebuilt by the next snapshot.
    pub fn replace_claims(&mut self, claims: ViewerClaims) {
        self.claims = claims;
        self.visible_nodes.clear();
        self.visible_edges.clear();
        self.edge_endpoints.clear();
    }

    /// Project an envelope, returning `None` when it conveys no visible state.
    pub fn project(&mut self, mut envelope: TwinEnvelope) -> Option<TwinEnvelope> {
        let input_epoch = envelope.stream_epoch.clone();
        let is_new_epoch = self.epoch.as_deref() != Some(input_epoch.as_str());
        envelope.message = match envelope.message {
            TwinMessage::Snapshot {
                graph_schema_version,
                rvf_json,
            } => {
                let graph = WorldGraph::from_json(rvf_json.as_bytes()).ok()?;
                let snapshot = self.project_snapshot(graph.snapshot());
                let _ = graph_schema_version;
                TwinMessage::Snapshot {
                    graph_schema_version: SCHEMA_VERSION,
                    rvf_json: serde_json::to_string(&snapshot).ok()?,
                }
            }
            TwinMessage::UpsertNode { node } => {
                let id = node.id();
                if self.policy.allows_node(&self.claims, &node) {
                    self.visible_nodes.insert(id);
                    TwinMessage::UpsertNode { node }
                } else if self.visible_nodes.remove(&id) {
                    self.forget_incident_edges(id);
                    TwinMessage::RemoveNode { id }
                } else {
                    return None;
                }
            }
            TwinMessage::RemoveNode { id } => {
                if !self.visible_nodes.remove(&id) {
                    return None;
                }
                self.forget_incident_edges(id);
                TwinMessage::RemoveNode { id }
            }
            TwinMessage::UpsertEdge { id, from, to, edge } => {
                let record = WorldEdgeRecord {
                    id,
                    from,
                    to,
                    edge: edge.clone(),
                };
                let allowed = self.visible_nodes.contains(&from)
                    && self.visible_nodes.contains(&to)
                    && self.policy.allows_edge(&self.claims, &record);
                if allowed {
                    self.visible_edges.insert(id);
                    self.edge_endpoints.insert(id, (from, to));
                    TwinMessage::UpsertEdge { id, from, to, edge }
                } else if self.visible_edges.remove(&id) {
                    self.edge_endpoints.remove(&id);
                    TwinMessage::RemoveEdge { id }
                } else {
                    return None;
                }
            }
            TwinMessage::RemoveEdge { id } => {
                if !self.visible_edges.remove(&id) {
                    return None;
                }
                self.edge_endpoints.remove(&id);
                TwinMessage::RemoveEdge { id }
            }
            TwinMessage::Presence { updates } => TwinMessage::Presence { updates },
        };
        if is_new_epoch {
            self.epoch = Some(input_epoch);
            self.output_seq = Some(0);
            envelope.seq = 0;
        } else {
            let seq = self.output_seq.unwrap_or(0).saturating_add(1);
            self.output_seq = Some(seq);
            envelope.seq = seq;
        }
        Some(envelope)
    }

    fn project_snapshot(&mut self, mut snapshot: WorldGraphSnapshot) -> WorldGraphSnapshot {
        snapshot
            .nodes
            .retain(|node| self.policy.allows_node(&self.claims, node));
        self.visible_nodes = snapshot.nodes.iter().map(WorldNode::id).collect();
        snapshot.edges.retain(|edge| {
            self.visible_nodes.contains(&edge.from)
                && self.visible_nodes.contains(&edge.to)
                && self.policy.allows_edge(&self.claims, edge)
        });
        self.visible_edges = snapshot.edges.iter().map(|edge| edge.id).collect();
        self.edge_endpoints = snapshot
            .edges
            .iter()
            .map(|edge| (edge.id, (edge.from, edge.to)))
            .collect();
        snapshot
    }

    fn forget_incident_edges(&mut self, node: WorldId) {
        let ids: Vec<_> = self
            .edge_endpoints
            .iter()
            .filter_map(|(id, (from, to))| (*from == node || *to == node).then_some(*id))
            .collect();
        for id in ids {
            self.visible_edges.remove(&id);
            self.edge_endpoints.remove(&id);
        }
    }
}
