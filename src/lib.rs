#[cfg(target_arch = "wasm32")]
mod engine_renderer;
mod math;
mod queue;
#[cfg(target_arch = "wasm32")]
mod renderer;

use math::{compose, multiply, normalize_transforms, Mat4, IDENTITY};
use std::{cell::Cell, rc::Rc};
use wasm_bindgen::prelude::*;

const MAX_NODES: usize = 100_000;

#[derive(Clone, Copy)]
struct SceneState {
    revision: u64,
    ready: bool,
}

pub(crate) struct SceneSnapshot {
    state: Rc<Cell<SceneState>>,
    revision: u64,
}

impl SceneSnapshot {
    pub(crate) fn is_current(&self) -> bool {
        let state = self.state.get();
        state.ready && state.revision == self.revision
    }

    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn belongs_to(&self, scene: &SceneGraph) -> bool {
        Rc::ptr_eq(&self.state, &scene.state)
    }
}

/// A forest with stable indices. Validation and topology changes are transactional.
#[wasm_bindgen]
pub struct SceneGraph {
    parents: Vec<i32>,
    transforms: Vec<f32>,
    order: Vec<usize>,
    pub(crate) worlds: Vec<f32>,
    dirty: Vec<bool>,
    changed: Vec<bool>,
    updated_count: usize,
    invalid_worlds: Vec<bool>,
    invalid_count: usize,
    state: Rc<Cell<SceneState>>,
}

impl SceneGraph {
    fn invalidate(&self) {
        self.state.set(SceneState {
            revision: self.state.get().revision.wrapping_add(1),
            ready: false,
        });
    }

    pub(crate) fn ensure_ready(&self) -> Result<(), String> {
        if self.state.get().ready {
            Ok(())
        } else {
            Err("world matrices are pending or non-finite; update the scene before preparing or drawing".into())
        }
    }

    pub(crate) fn snapshot(&self) -> Result<SceneSnapshot, String> {
        self.ensure_ready()?;
        Ok(SceneSnapshot {
            state: Rc::clone(&self.state),
            revision: self.state.get().revision,
        })
    }
}

impl Drop for SceneGraph {
    fn drop(&mut self) {
        self.invalidate();
    }
}

fn traversal(parents: &[i32]) -> Result<Vec<usize>, String> {
    if parents.len() > MAX_NODES {
        return Err(format!("at most {MAX_NODES} nodes are supported"));
    }
    let mut children = vec![Vec::new(); parents.len()];
    let mut order = Vec::with_capacity(parents.len());
    for (id, &parent) in parents.iter().enumerate() {
        if parent == -1 {
            order.push(id);
        } else if parent < -1 || parent as usize >= parents.len() || parent as usize == id {
            return Err("parent must be -1 or another valid node index".into());
        } else {
            children[parent as usize].push(id);
        }
    }
    let mut cursor = 0;
    while cursor < order.len() {
        order.extend_from_slice(&children[order[cursor]]);
        cursor += 1;
    }
    if order.len() != parents.len() {
        return Err("scene graph must not contain a cycle".into());
    }
    Ok(order)
}

#[wasm_bindgen]
impl SceneGraph {
    #[wasm_bindgen(constructor)]
    pub fn new(parents: &[i32], transforms: &[f32]) -> Result<SceneGraph, String> {
        let order = traversal(parents)?;
        if transforms.len() != parents.len() * 10 {
            return Err("expected 10 transform floats per node".into());
        }
        let mut graph = Self {
            parents: parents.to_vec(),
            transforms: normalize_transforms(transforms)?,
            order,
            worlds: vec![0.; parents.len() * 16],
            dirty: vec![true; parents.len()],
            changed: vec![false; parents.len()],
            updated_count: 0,
            invalid_worlds: vec![false; parents.len()],
            invalid_count: 0,
            state: Rc::new(Cell::new(SceneState {
                revision: 0,
                ready: false,
            })),
        };
        graph.update_world_matrices()?;
        Ok(graph)
    }

    pub fn node_count(&self) -> usize {
        self.parents.len()
    }

    pub fn set_transforms(&mut self, values: &[f32]) -> Result<(), String> {
        if values.len() != self.transforms.len() {
            return Err("transform count must match existing nodes".into());
        }
        let normalized = normalize_transforms(values)?;
        let mut changed = false;
        for (id, (old, new)) in self
            .transforms
            .as_chunks::<10>()
            .0
            .iter()
            .zip(normalized.as_chunks::<10>().0)
            .enumerate()
        {
            self.dirty[id] |= old != new;
            changed |= old != new;
        }
        self.transforms = normalized;
        if changed {
            self.invalidate();
        }
        Ok(())
    }

    pub fn set_transform(&mut self, id: usize, values: &[f32]) -> Result<(), String> {
        if id >= self.node_count() || values.len() != 10 {
            return Err("invalid node or transform length".into());
        }
        let normalized = normalize_transforms(values)?;
        let changed = self.transforms[id * 10..id * 10 + 10] != normalized;
        self.dirty[id] |= changed;
        self.transforms[id * 10..id * 10 + 10].copy_from_slice(&normalized);
        if changed {
            self.invalidate();
        }
        Ok(())
    }

    /// Keeps the local transform. Call update_world_matrices after changing parents.
    pub fn reparent(&mut self, id: usize, parent: i32) -> Result<(), String> {
        if id >= self.node_count() {
            return Err("invalid node index".into());
        }
        let mut parents = self.parents.clone();
        parents[id] = parent;
        let order = traversal(&parents)?;
        self.parents = parents;
        self.order = order;
        self.dirty[id] = true;
        self.invalidate();
        Ok(())
    }

    /// Iterative traversal: a deep hierarchy cannot overflow the call stack.
    pub fn update_world_matrices(&mut self) -> Result<(), String> {
        self.invalidate();
        self.updated_count = 0;
        for &id in &self.order {
            let parent = self.parents[id];
            self.changed[id] = self.dirty[id] || (parent >= 0 && self.changed[parent as usize]);
            if !self.changed[id] {
                continue;
            }
            let local = compose(&self.transforms[id * 10..id * 10 + 10]);
            let world = if self.parents[id] == -1 {
                local
            } else {
                let offset = self.parents[id] as usize * 16;
                let parent: &Mat4 = self.worlds[offset..offset + 16].try_into().unwrap();
                multiply(parent, &local)
            };
            let invalid = world.iter().any(|v| !v.is_finite());
            if invalid != self.invalid_worlds[id] {
                if invalid {
                    self.invalid_count += 1;
                } else {
                    self.invalid_count -= 1;
                }
                self.invalid_worlds[id] = invalid;
            }
            self.worlds[id * 16..id * 16 + 16].copy_from_slice(&world);
            self.dirty[id] = false;
            self.updated_count += 1;
        }
        if self.invalid_count != 0 {
            let id = self
                .invalid_worlds
                .iter()
                .position(|&invalid| invalid)
                .unwrap();
            return Err(format!("non-finite world matrix at node {id}"));
        }
        self.state.set(SceneState {
            ready: true,
            ..self.state.get()
        });
        Ok(())
    }

    /// Number of matrices recomputed by the last update (traversal is still O(N)).
    pub fn updated_count(&self) -> usize {
        self.updated_count
    }

    /// Full recomputation for arithmetic benchmarks against Object3D.updateMatrixWorld(true).
    pub fn update_all_world_matrices(&mut self) -> Result<(), String> {
        self.dirty.fill(true);
        self.update_world_matrices()
    }

    /// Rotate selected nodes about their local Y axis. Absolute, deterministic time.
    pub fn animate_nodes(&mut self, ids: &[u32], seconds: f32) -> Result<(), String> {
        if !seconds.is_finite() || ids.iter().any(|&id| id as usize >= self.node_count()) {
            return Err("invalid animation time or node index".into());
        }
        let mut changed = false;
        for &id in ids {
            let id = id as usize;
            let (s, c) = (seconds * 0.2 + (id % 19) as f32 * 0.03).sin_cos();
            let q = [0., s, 0., c];
            let t = &mut self.transforms[id * 10..id * 10 + 10];
            self.dirty[id] |= t[3..7] != q;
            changed |= t[3..7] != q;
            t[3..7].copy_from_slice(&q);
        }
        if changed {
            self.invalidate();
        }
        Ok(())
    }

    /// Demo-only absolute animation. Overwrites local rotation and updates the forest.
    pub fn animate_demo(&mut self, seconds: f32) -> Result<(), String> {
        if !seconds.is_finite() {
            return Err("animation time must be finite".into());
        }
        let (sx, cx) = (seconds * 0.125).sin_cos();
        for (id, t) in self
            .transforms
            .as_chunks_mut::<10>()
            .0
            .iter_mut()
            .enumerate()
        {
            let (sy, cy) = (seconds * 0.2 + id as f32 * 0.0065).sin_cos();
            t[3..7].copy_from_slice(&[sx * cy, cx * sy, -sx * sy, cx * cy]);
            self.dirty[id] = true;
        }
        self.update_world_matrices()
    }

    /// A copy, safe to retain after a WASM allocation or graph.free().
    pub fn world_matrices(&self) -> Vec<f32> {
        self.worlds.clone()
    }

    /// Borrowed memory; reacquire JS views after any potentially allocating WASM call.
    pub fn matrices_ptr(&self) -> *const f32 {
        self.worlds.as_ptr()
    }

    pub fn matrices_len(&self) -> usize {
        self.worlds.len()
    }
}

#[wasm_bindgen]
pub fn multiply_matrices(a: &[f32], b: &[f32]) -> Result<Vec<f32>, String> {
    if a.len() != 16 || b.len() != 16 || a.iter().chain(b).any(|v| !v.is_finite()) {
        return Err("expected two finite 4x4 matrices".into());
    }
    let product = multiply(a.try_into().unwrap(), b.try_into().unwrap());
    if product.iter().any(|v| !v.is_finite()) {
        return Err("matrix product exceeds f32 range".into());
    }
    Ok(product.to_vec())
}

#[wasm_bindgen]
pub fn compose_transform(transform: &[f32]) -> Result<Vec<f32>, String> {
    if transform.len() != 10 {
        return Err("expected 10 transform floats".into());
    }
    Ok(compose(&normalize_transforms(transform)?).to_vec())
}

/// Batch multiplication amortizes the JS/WASM boundary overhead.
#[wasm_bindgen]
pub fn multiply_matrices_batch(a: &[f32], b: &[f32]) -> Result<Vec<f32>, String> {
    if a.len() != b.len()
        || !a.len().is_multiple_of(16)
        || a.iter().chain(b).any(|v| !v.is_finite())
    {
        return Err(
            "matrix batches must have equal lengths divisible by 16 and finite values".into(),
        );
    }
    let mut out = Vec::with_capacity(a.len());
    for (left, right) in a.as_chunks::<16>().0.iter().zip(b.as_chunks::<16>().0) {
        let product = multiply(left, right);
        if product.iter().any(|v| !v.is_finite()) {
            return Err("matrix product exceeds f32 range".into());
        }
        out.extend_from_slice(&product);
    }
    Ok(out)
}

#[wasm_bindgen]
pub fn transform_points(matrix: &[f32], points: &[f32]) -> Result<Vec<f32>, String> {
    if matrix.len() != 16
        || !points.len().is_multiple_of(3)
        || matrix.iter().chain(points).any(|v| !v.is_finite())
    {
        return Err("expected a finite matrix and packed xyz points".into());
    }
    let m: &Mat4 = matrix.try_into().unwrap();
    let m = m.map(f64::from);
    let mut out = Vec::with_capacity(points.len());
    for (index, p) in points.as_chunks::<3>().0.iter().enumerate() {
        let p = p.map(f64::from);
        let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        if w == 0. {
            return Err(format!("point {index} projects to infinity (w is zero)"));
        }
        for row in 0..3 {
            let coordinate =
                ((m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]) / w) as f32;
            if !coordinate.is_finite() {
                return Err(format!("transformed point {index} exceeds f32 range"));
            }
            out.push(coordinate);
        }
    }
    Ok(out)
}

/// Tiny export for measuring call overhead without a large arithmetic workload.
#[wasm_bindgen]
pub fn identity_value(value: f64) -> f64 {
    value
}

#[wasm_bindgen]
pub fn identity_matrix() -> Vec<f32> {
    IDENTITY.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transforms(count: usize) -> Vec<f32> {
        [1., 0., 0., 0., 0., 0., 1., 1., 1., 1.].repeat(count)
    }

    #[test]
    fn point_projection_accepts_equivalent_small_and_negative_homogeneous_matrices() {
        let points = [1.25, -2., 3., 1e20, 0., 0.];
        for scale in [2_f32.powi(-90), -2_f32.powi(-90), 1., 2_f32.powi(90)] {
            assert_eq!(
                transform_points(&IDENTITY.map(|v| v * scale), &points).unwrap(),
                points
            );
        }
    }

    #[test]
    fn point_projection_divides_after_large_products_and_denominator_cancellation() {
        let mut matrix = IDENTITY;
        matrix[0] = 1e30;
        matrix[5] = 1e30;
        matrix[3] = 1e30;
        matrix[15] = 0.;
        assert_eq!(
            transform_points(&matrix, &[1e20, 2e20, 0.]).unwrap(),
            [1., 2., 0.]
        );
        matrix = IDENTITY;
        matrix[3] = 1e8;
        matrix[7] = 1.;
        matrix[15] = -1e8;
        assert_eq!(
            transform_points(&matrix, &[1., 0.5, 0.]).unwrap(),
            [2., 1., 0.]
        );
        matrix = IDENTITY;
        matrix[15] = 1e-20;
        assert!(transform_points(&matrix, &[1., 0., 0.]).unwrap()[0].is_finite());
    }

    #[test]
    fn point_projection_rejects_zero_w_and_final_overflow_without_partial_results() {
        let mut matrix = IDENTITY;
        matrix[3] = 1.;
        matrix[15] = -1.;
        let points = [2., 0., 0., 1., 0., 0.];
        assert!(transform_points(&matrix, &points)
            .unwrap_err()
            .contains("point 1 projects to infinity"));
        matrix = IDENTITY;
        matrix[0] = 1e20;
        assert!(transform_points(&matrix, &[0., 0., 0., 1e20, 0., 0.])
            .unwrap_err()
            .contains("point 1 exceeds f32 range"));
        assert_eq!(transform_points(&IDENTITY, &points).unwrap(), points);
        assert!(transform_points(&[0.; 16], &[]).unwrap().is_empty());
    }

    #[test]
    fn matrix_exports_reject_final_overflow_in_single_and_mixed_batches() {
        let mut large = IDENTITY;
        large[0] = 1e20;
        assert!(multiply_matrices(&large, &large).is_err());
        assert!(
            multiply_matrices_batch(&[IDENTITY, large].concat(), &[IDENTITY, large].concat())
                .is_err()
        );
        assert!(multiply_matrices_batch(&[], &[]).unwrap().is_empty());
    }

    #[test]
    fn overflow_is_rejected_until_every_invalid_branch_is_repaired() {
        let local = |scale| [0., 0., 0., 0., 0., 0., 1., scale, scale, scale];
        assert!(SceneGraph::new(&[-1, 0], &[local(1e20), local(1e20)].concat()).is_err());
        let mut graph = SceneGraph::new(
            &[-1, 0, -1, 2],
            &[local(1.), local(1e20), local(1.), local(1e20)].concat(),
        )
        .unwrap();
        let snapshot = graph.snapshot().unwrap();
        graph.set_transform(0, &local(1e20)).unwrap();
        graph.set_transform(2, &local(1e20)).unwrap();
        assert!(!snapshot.is_current());
        assert_eq!(
            graph.update_world_matrices().unwrap_err(),
            "non-finite world matrix at node 1"
        );
        assert_eq!(graph.invalid_count, 2);
        assert!(graph.update_world_matrices().is_err());
        assert_eq!(graph.updated_count(), 0);
        graph.set_transform(0, &local(1.)).unwrap();
        assert_eq!(
            graph.update_world_matrices().unwrap_err(),
            "non-finite world matrix at node 3"
        );
        assert_eq!(graph.invalid_count, 1);
        graph.set_transform(2, &local(1.)).unwrap();
        graph.update_world_matrices().unwrap();
        assert!(graph.snapshot().unwrap().is_current());
        assert!(!snapshot.is_current());
        assert_eq!(graph.invalid_count, 0);
        assert!(graph.worlds.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn parents_can_follow_children_in_storage() {
        let graph = SceneGraph::new(&[2, -1, 1], &transforms(3)).unwrap();
        assert_eq!(graph.worlds[12], 3.);
        assert_eq!(graph.worlds[28], 1.);
        assert_eq!(graph.worlds[44], 2.);
    }

    #[test]
    fn reparent_rejects_cycles_and_preserves_existing_graph() {
        let mut graph = SceneGraph::new(&[-1, 0, 1], &transforms(3)).unwrap();
        assert!(graph.reparent(0, 2).is_err());
        graph.update_world_matrices().unwrap();
        assert_eq!(graph.worlds[44], 3.);
        graph.reparent(2, -1).unwrap();
        graph.update_world_matrices().unwrap();
        assert_eq!(graph.worlds[44], 1.);
    }

    #[test]
    fn invalid_inputs_are_rejected_without_partial_mutation() {
        assert!(SceneGraph::new(&[1, 0], &transforms(2)).is_err());
        assert!(SceneGraph::new(&[-2], &transforms(1)).is_err());
        assert!(SceneGraph::new(&[4], &transforms(1)).is_err());
        assert!(SceneGraph::new(&[-1], &[]).is_err());
        let mut graph = SceneGraph::new(&[-1], &transforms(1)).unwrap();
        assert!(graph.set_transform(0, &[0.; 10]).is_err());
        assert!(graph.set_transform(3, &transforms(1)).is_err());
        assert!(graph.animate_demo(f32::NAN).is_err());
        graph.update_world_matrices().unwrap();
        assert_eq!(graph.worlds[12], 1.);
    }

    #[test]
    fn handles_empty_forests_and_deep_hierarchies() {
        let mut empty = SceneGraph::new(&[], &[]).unwrap();
        empty.animate_demo(1.).unwrap();
        assert!(empty.world_matrices().is_empty());
        let parents: Vec<i32> = (0..20_000).map(|id| id - 1).collect();
        let graph = SceneGraph::new(&parents, &transforms(parents.len())).unwrap();
        assert_eq!(graph.worlds[19_999 * 16 + 12], 20_000.);
    }

    #[test]
    fn points_use_homogeneous_coordinates_and_batches_validate_lengths() {
        let m = compose(&[2., 3., 4., 0., 0., 0., 1., 2., 2., 2.]);
        assert_eq!(transform_points(&m, &[1., 2., 3.]).unwrap(), [4., 7., 10.]);
        assert!(transform_points(&[0.; 16], &[1., 2., 3.]).is_err());
        assert!(multiply_matrices_batch(&[1.; 17], &[1.; 17]).is_err());
    }
}
