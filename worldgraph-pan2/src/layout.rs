//! First-frame description: the caller's prose plus a layout sentence built
//! from the sanitized scene primitives.

use wifi_densepose_worldmodel::{ScenePrimitive, SceneSeed};

use crate::caption::MAX_PARAGRAPH_WORDS;
use crate::Pan2Error;

/// Most scene primitives named individually in the layout sentence.
pub const MAX_LAYOUT_ITEMS: usize = 10;

fn class_words(class: &str) -> Result<String, Pan2Error> {
    if !class
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b' '))
    {
        return Err(Pan2Error::invalid(format!(
            "scene class `{class}` must be ASCII letters, digits, space, `_` or `-`"
        )));
    }
    Ok(class.replace(['_', '-'], " ").trim().to_ascii_lowercase())
}

/// One clause per primitive, positioned relative to the scene centroid as seen
/// from the south looking north (east is right, north is far).
fn layout_clauses(scene: &[ScenePrimitive]) -> Result<Vec<String>, Pan2Error> {
    let centres: Vec<[f32; 3]> = scene
        .iter()
        .map(|primitive| match primitive {
            ScenePrimitive::Point { x_m, y_m, z_m, .. } => [*x_m, *y_m, *z_m],
            ScenePrimitive::Box { center_m, .. } => *center_m,
        })
        .collect();
    let count = centres.len().max(1) as f32;
    let mid_x = centres.iter().map(|c| c[0]).sum::<f32>() / count;
    let mid_y = centres.iter().map(|c| c[1]).sum::<f32>() / count;
    scene
        .iter()
        .zip(&centres)
        .map(|(primitive, centre)| {
            let side = match centre[0] - mid_x {
                dx if dx < -0.5 => "to the left",
                dx if dx > 0.5 => "to the right",
                _ => "at the centre",
            };
            let depth = match centre[1] - mid_y {
                dy if dy < -0.5 => "in the foreground",
                dy if dy > 0.5 => "in the background",
                _ => "in the middle distance",
            };
            let (class, width) = match primitive {
                ScenePrimitive::Point { class, .. } => (class, None),
                ScenePrimitive::Box { class, size_m, .. } => (class, Some(size_m[0])),
            };
            let class = class_words(class)?;
            let article = if class.starts_with(['a', 'e', 'i', 'o', 'u']) {
                "an"
            } else {
                "a"
            };
            Ok(match width {
                Some(width) => format!("{article} {class} about {width:.1} m wide {side} {depth}"),
                None => format!("{article} {class} {side} {depth}"),
            })
        })
        .collect()
}

pub(crate) fn init_description(seed: &SceneSeed) -> Result<String, Pan2Error> {
    let prompt = seed.prompt.as_deref().map(str::trim).unwrap_or("");
    let clauses = layout_clauses(&seed.scene)?;
    if prompt.is_empty() && clauses.is_empty() {
        return Err(Pan2Error::invalid(
            "the seed needs a prompt or at least one scene primitive to describe the first frame",
        ));
    }
    let mut budget = MAX_PARAGRAPH_WORDS
        .checked_sub(prompt.split_whitespace().count())
        .ok_or_else(|| Pan2Error::invalid("seed prompt exceeds 200 words"))?;
    let mut kept = Vec::new();
    // Reserve words for "The space contains" and a possible "and N further elements".
    budget = budget.saturating_sub(8);
    for clause in clauses.iter().take(MAX_LAYOUT_ITEMS) {
        let cost = clause.split_whitespace().count();
        if cost > budget {
            break;
        }
        budget -= cost;
        kept.push(clause.clone());
    }
    let mut text = prompt.to_owned();
    if !kept.is_empty() {
        let omitted = clauses.len() - kept.len();
        let mut sentence = format!("The space contains {}", kept.join(", "));
        if omitted > 0 {
            sentence.push_str(&format!(", and {omitted} further elements"));
        }
        sentence.push('.');
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(&sentence);
    }
    Ok(text)
}
