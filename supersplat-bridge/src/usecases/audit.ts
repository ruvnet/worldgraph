// ADR-202 §4 — Direct Provenance Auditing ("Click-to-Audit").
//
// Because the WorldGraph enforces semantic provenance, every node carries an
// auditable trail. When a user clicks an avatar / box / room in the 3-D scene,
// this module resolves the picked entity to its WorldId, pulls the provenance
// card from Rust WASM memory, and formats it for an info panel.

import type { ProvenanceCard } from '../types.js';
import type { SemanticVisualizer } from '../wasm-bridge.js';
import { primitiveKey } from '../renderer.js';
import type { RenderPrimitive } from '../types.js';

/** Parse a `${kind}:${id}` entity key back to a numeric WorldId. */
export function worldIdFromKey(key: string): number | null {
  const idx = key.lastIndexOf(':');
  if (idx < 0) return null;
  const id = Number(key.slice(idx + 1));
  return Number.isFinite(id) ? id : null;
}

/** The entity key for a render primitive (re-exported for pick handlers). */
export { primitiveKey };

/** A panel-ready view of a provenance card. */
export interface ProvenancePanelModel {
  title: string;
  summary: string;
  rows: Array<{ label: string; value: string }>;
  evidence: string[];
}

/** Format a provenance card into a flat panel model. */
export function formatProvenanceCard(card: ProvenanceCard): ProvenancePanelModel {
  return {
    title: card.title,
    summary: card.summary,
    rows: card.fields.map((f) => ({ label: f.key, value: f.value })),
    evidence: card.evidence
  };
}

/** Render a provenance card as a compact Markdown block (for tooltips/logs). */
export function provenanceToMarkdown(card: ProvenanceCard): string {
  const lines = [`### ${card.title}`, '', card.summary, ''];
  for (const f of card.fields) lines.push(`- **${f.key}**: ${f.value}`);
  if (card.evidence.length > 0) {
    lines.push('', '**Evidence**');
    for (const e of card.evidence) lines.push(`- \`${e}\``);
  }
  return lines.join('\n');
}

/**
 * Resolves scene picks to provenance cards.
 *
 * ```ts
 * const panel = new ProvenancePanel(viz);
 * const card = panel.onPickEntity(pickedEntity.name); // "person_track:42"
 * if (card) showInfoPanel(formatProvenanceCard(card));
 * ```
 */
export class ProvenancePanel {
  constructor(private readonly viz: SemanticVisualizer) {}

  /** Look up provenance for a clicked render primitive. */
  onPick(prim: RenderPrimitive): ProvenanceCard | null {
    return this.viz.provenance(prim.id);
  }

  /** Look up provenance from an entity key like `"room:3"`. */
  onPickEntity(entityKey: string): ProvenanceCard | null {
    const id = worldIdFromKey(entityKey);
    return id === null ? null : this.viz.provenance(id);
  }
}
