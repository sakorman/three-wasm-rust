mod math;
#[cfg(target_arch = "wasm32")]
mod renderer;

use math::{compose, multiply, normalize_transforms, Mat4, IDENTITY};
use wasm_bindgen::prelude::*;

const MAX_NODES: usize = 100_000;

/// A forest with stable indices. Validation and topology changes are transactional.
#[wasm_bindgen]
pub struct SceneGraph {
    parents: Vec<i32>,
    transforms: Vec<f32>,
    order: Vec<usize>,
    pub(crate) worlds: Vec<f32>,
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
        };
        graph.update_world_matrices();
        Ok(graph)
    }

    pub fn node_count(&self) -> usize {
        self.parents.len()
    }

    pub fn set_transforms(&mut self, values: &[f32]) -> Result<(), String> {
        if values.len() != self.transforms.len() {
            return Err("transform count must match existing nodes".into());
        }
        self.transforms = normalize_transforms(values)?;
        Ok(())
    }

    pub fn set_transform(&mut self, id: usize, values: &[f32]) -> Result<(), String> {
        if id >= self.node_count() || values.len() != 10 {
            return Err("invalid node or transform length".into());
        }
        let normalized = normalize_transforms(values)?;
        self.transforms[id * 10..id * 10 + 10].copy_from_slice(&normalized);
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
        Ok(())
    }

    /// Iterative traversal: a deep hierarchy cannot overflow the call stack.
    pub fn update_world_matrices(&mut self) {
        for &id in &self.order {
            let local = compose(&self.transforms[id * 10..id * 10 + 10]);
            let world = if self.parents[id] == -1 {
                local
            } else {
                let offset = self.parents[id] as usize * 16;
                let parent: &Mat4 = self.worlds[offset..offset + 16].try_into().unwrap();
                multiply(parent, &local)
            };
            self.worlds[id * 16..id * 16 + 16].copy_from_slice(&world);
        }
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
        }
        self.update_world_matrices();
        Ok(())
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
    Ok(multiply(a.try_into().unwrap(), b.try_into().unwrap()).to_vec())
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
        out.extend_from_slice(&multiply(left, right));
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
    let m = matrix;
    let mut out = Vec::with_capacity(points.len());
    for p in points.as_chunks::<3>().0 {
        let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
        if w.abs() < 1e-12 {
            return Err("point projects to infinity (w is zero)".into());
        }
        for row in 0..3 {
            out.push((m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]) / w);
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
        graph.update_world_matrices();
        assert_eq!(graph.worlds[44], 3.);
        graph.reparent(2, -1).unwrap();
        graph.update_world_matrices();
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
        graph.update_world_matrices();
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
