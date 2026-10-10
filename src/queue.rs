//! Visibility and geometry/material batches, independent of the graphics API.
use crate::{math::Mat4, SceneGraph, MAX_NODES};
use wasm_bindgen::prelude::*;

fn planes(matrix: &[f32]) -> Result<[[f32; 4]; 6], String> {
    if matrix.len() != 16 || matrix.iter().any(|x| !x.is_finite()) {
        return Err("expected a finite view-projection matrix".into());
    }
    let mut result = [[0.; 4]; 6];
    for (i, plane) in result.iter_mut().enumerate() {
        let axis = i / 2;
        let sign = if i % 2 == 0 { 1. } else { -1. };
        for j in 0..4 {
            plane[j] = matrix[j * 4 + 3] + sign * matrix[j * 4 + axis];
        }
        let length = (plane[0].powi(2) + plane[1].powi(2) + plane[2].powi(2)).sqrt();
        if length < 1e-12 {
            return Err("degenerate projection plane".into());
        }
        for v in plane {
            *v /= length;
        }
    }
    Ok(result)
}

/// Column lengths are exact for orthogonal TRS. Use a conservative bound for shear.
pub(crate) fn radius_scale(m: &Mat4) -> f32 {
    let dot = |a: usize, b: usize| (0..3).map(|r| m[a * 4 + r] * m[b * 4 + r]).sum::<f32>();
    let largest = dot(0, 0).max(dot(1, 1)).max(dot(2, 2));
    let shear = dot(0, 1).abs().max(dot(0, 2).abs()).max(dot(1, 2).abs());
    if shear <= largest * 1e-5 {
        largest.sqrt()
    } else {
        (dot(0, 0) + dot(1, 1) + dot(2, 2)).sqrt()
    }
}

#[wasm_bindgen]
pub struct RenderQueue {
    pub(crate) nodes: Vec<u32>,
    pub(crate) groups: Vec<u32>,
    radii: Vec<f32>,
    pub(crate) ranges: Vec<(usize, usize)>,
    pub(crate) matrices: Vec<f32>,
    visible_ids: Vec<u32>,
    cursors: Vec<usize>,
    pub(crate) visible_items: Vec<usize>,
    pub(crate) packed: bool,
}

#[wasm_bindgen]
impl RenderQueue {
    /// Geometry spheres are centered on the local origin. Each group is one geometry/material pair.
    #[wasm_bindgen(constructor)]
    pub fn new(
        nodes: &[u32],
        groups: &[u32],
        radii: &[f32],
        group_count: usize,
    ) -> Result<Self, String> {
        if nodes.len() > MAX_NODES
            || group_count == 0
            || group_count > 4096
            || groups.len() != nodes.len()
            || radii.len() != nodes.len()
            || groups.iter().any(|&g| g as usize >= group_count)
            || radii.iter().any(|&r| !r.is_finite() || r < 0.)
        {
            return Err("invalid render queue descriptors".into());
        }
        let mut unique = std::collections::HashSet::new();
        if nodes.iter().any(|&id| !unique.insert(id)) {
            return Err("duplicate mesh node".into());
        }
        Ok(Self {
            nodes: nodes.to_vec(),
            groups: groups.to_vec(),
            radii: radii.to_vec(),
            ranges: vec![(0, 0); group_count],
            matrices: vec![0.; nodes.len() * 16],
            visible_ids: Vec::with_capacity(nodes.len()),
            cursors: vec![0; group_count],
            visible_items: Vec::with_capacity(nodes.len()),
            packed: false,
        })
    }

    pub fn prepare(
        &mut self,
        scene: &SceneGraph,
        view_projection: &[f32],
        culling: bool,
    ) -> Result<(), String> {
        self.prepare_direct(scene, view_projection, culling)?;
        let mut start = 0;
        for range in &mut self.ranges {
            range.0 = start;
            start += range.1;
        }
        for (cursor, range) in self.cursors.iter_mut().zip(&self.ranges) {
            *cursor = range.0;
        }
        for &i in &self.visible_items {
            let group = self.groups[i] as usize;
            let dst = self.cursors[group] * 16;
            let src = self.nodes[i] as usize * 16;
            self.matrices[dst..dst + 16].copy_from_slice(&scene.worlds[src..src + 16]);
            self.cursors[group] += 1;
        }
        self.packed = true;
        Ok(())
    }

    /// Preserve descriptor order. No grouping or instance matrix packing.
    pub fn prepare_direct(
        &mut self,
        scene: &SceneGraph,
        view_projection: &[f32],
        culling: bool,
    ) -> Result<(), String> {
        let planes = planes(view_projection)?;
        if self
            .nodes
            .iter()
            .any(|&id| id as usize >= scene.node_count())
        {
            return Err("mesh node is outside the scene".into());
        }
        self.ranges.fill((0, 0));
        self.visible_ids.clear();
        self.visible_items.clear();
        self.packed = false;
        for i in 0..self.nodes.len() {
            let offset = self.nodes[i] as usize * 16;
            let m: &Mat4 = scene.worlds[offset..offset + 16].try_into().unwrap();
            let visible = !culling || {
                let radius = self.radii[i] * radius_scale(m);
                planes
                    .iter()
                    .all(|p| p[0] * m[12] + p[1] * m[13] + p[2] * m[14] + p[3] >= -radius)
            };
            if visible {
                self.ranges[self.groups[i] as usize].1 += 1;
                self.visible_ids.push(self.nodes[i]);
                self.visible_items.push(i);
            }
        }
        Ok(())
    }

    pub fn visible_count(&self) -> usize {
        self.visible_ids.len()
    }
    pub fn batch_count(&self) -> usize {
        self.ranges.iter().filter(|r| r.1 > 0).count()
    }
    pub fn visible_nodes(&self) -> Vec<u32> {
        self.visible_ids.clone()
    }
    pub fn batch_counts(&self) -> Vec<u32> {
        self.ranges.iter().map(|r| r.1 as u32).collect()
    }
    pub fn matrices_ptr(&self) -> *const f32 {
        self.matrices.as_ptr()
    }
    pub fn matrices_len(&self) -> usize {
        if self.packed {
            self.visible_count() * 16
        } else {
            0
        }
    }
    pub fn matrix_capacity(&self) -> usize {
        self.nodes.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::IDENTITY;
    #[test]
    fn culls_and_groups_without_losing_visible_nodes() {
        let t = [0., 0., 0., 0., 0., 0., 1., 1., 1., 1.];
        let mut values = t.repeat(3);
        values[10] = 20.;
        values[20] = 0.5;
        let scene = SceneGraph::new(&[-1; 3], &values).unwrap();
        let mut queue = RenderQueue::new(&[0, 1, 2], &[1, 0, 0], &[0.1; 3], 2).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_nodes(), vec![0, 2]);
        assert_eq!(queue.batch_counts(), vec![1, 1]);
        assert_eq!(queue.matrices[12], 0.5);
        assert_eq!(queue.matrices[28], 0.);
        queue.prepare(&scene, &IDENTITY, false).unwrap();
        assert_eq!(queue.visible_count(), 3);
    }
    #[test]
    fn rejects_invalid_inputs_and_handles_empty_queues() {
        assert!(RenderQueue::new(&[0, 0], &[0, 0], &[1., 1.], 1).is_err());
        assert!(RenderQueue::new(&[0], &[1], &[1.], 1).is_err());
        let scene = SceneGraph::new(&[], &[]).unwrap();
        let mut queue = RenderQueue::new(&[], &[], &[], 1).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_count(), 0);
        assert!(queue.prepare(&scene, &[0.; 16], true).is_err());
    }
    #[test]
    fn dirty_updates_propagate_and_skip_static_nodes() {
        let t = [0., 0., 0., 0., 0., 0., 1., 1., 1., 1.];
        let mut scene = SceneGraph::new(&[-1, 0, -1], &t.repeat(3)).unwrap();
        scene.update_world_matrices();
        assert_eq!(scene.updated_count(), 0);
        let mut changed = t;
        changed[0] = 4.;
        scene.set_transform(0, &changed).unwrap();
        scene.update_world_matrices();
        assert_eq!(scene.updated_count(), 2);
        assert_eq!(scene.worlds[28], 4.);
        scene.set_transform(0, &changed).unwrap();
        scene.update_world_matrices();
        assert_eq!(scene.updated_count(), 0);
    }

    #[test]
    fn direct_queue_preserves_order_and_discards_old_instance_layout() {
        let t = [0., 0., 0., 0., 0., 0., 1., 1., 1., 1.];
        let scene = SceneGraph::new(&[-1; 3], &t.repeat(3)).unwrap();
        let mut queue = RenderQueue::new(&[2, 0, 1], &[1, 0, 1], &[0.1; 3], 2).unwrap();
        queue.prepare(&scene, &IDENTITY, false).unwrap();
        assert_eq!(queue.matrices_len(), 48);
        queue.prepare_direct(&scene, &IDENTITY, false).unwrap();
        assert_eq!(queue.visible_nodes(), vec![2, 0, 1]);
        assert_eq!(queue.visible_items, vec![0, 1, 2]);
        assert_eq!(queue.matrices_len(), 0);
        assert!(!queue.packed);
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert!(queue.packed);
        assert_eq!(queue.matrices_len(), 48);
    }
}
