//! Visibility and geometry/material batches, independent of the graphics API.
use crate::{
    math::{is_mirrored, Mat4},
    SceneGraph, MAX_NODES,
};
use wasm_bindgen::prelude::*;

fn planes(matrix: &[f32]) -> Result<[[f64; 4]; 6], String> {
    if matrix.len() != 16 || matrix.iter().any(|x| !x.is_finite()) {
        return Err("expected a finite view-projection matrix".into());
    }
    let mut result = [[0.; 4]; 6];
    for (i, plane) in result.iter_mut().enumerate() {
        let axis = i / 2;
        let sign = if i % 2 == 0 { 1. } else { -1. };
        for j in 0..4 {
            plane[j] = f64::from(matrix[j * 4 + 3]) + sign * f64::from(matrix[j * 4 + axis]);
        }
        let length = (plane[0].powi(2) + plane[1].powi(2) + plane[2].powi(2)).sqrt();
        if length == 0. {
            return Err("degenerate projection plane".into());
        }
        for v in plane {
            *v /= length;
        }
    }
    Ok(result)
}

/// Bound the largest singular value, including arbitrarily small shear.
pub(crate) fn radius_scale(m: &Mat4) -> f64 {
    let dot = |a: usize, b: usize| {
        (0..3)
            .map(|r| f64::from(m[a * 4 + r]) * f64::from(m[b * 4 + r]))
            .sum::<f64>()
    };
    let [xx, yy, zz] = [dot(0, 0), dot(1, 1), dot(2, 2)];
    let [xy, xz, yz] = [dot(0, 1).abs(), dot(0, 2).abs(), dot(1, 2).abs()];
    // Both trace(AᵀA) and its largest absolute row sum bound its largest eigenvalue.
    let row_bound = (xx + xy + xz).max(yy + xy + yz).max(zz + xz + yz);
    let bound = row_bound.min(xx + yy + zz);
    // Keep accumulation/square-root rounding from shrinking the bound.
    (bound * (1. + 8. * f64::EPSILON)).sqrt()
}

#[wasm_bindgen]
pub struct RenderQueue {
    pub(crate) nodes: Vec<u32>,
    pub(crate) groups: Vec<u32>,
    radii: Vec<f32>,
    centers: Vec<f32>,
    // Each resource group has a CCW range followed by a CW range.
    pub(crate) ranges: Vec<(usize, usize)>,
    pub(crate) mirrored: Vec<bool>,
    pub(crate) matrices: Vec<f32>,
    visible_ids: Vec<u32>,
    cursors: Vec<usize>,
    pub(crate) visible_items: Vec<usize>,
    pub(crate) packed: bool,
    pub(crate) prepared: bool,
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
            centers: vec![0.; nodes.len() * 3],
            ranges: vec![(0, 0); group_count * 2],
            mirrored: vec![false; nodes.len()],
            matrices: vec![0.; nodes.len() * 16],
            visible_ids: Vec::with_capacity(nodes.len()),
            cursors: vec![0; group_count * 2],
            visible_items: Vec::with_capacity(nodes.len()),
            packed: false,
            prepared: false,
        })
    }

    /// Replace local bounding spheres in descriptor order. Re-prepare before drawing.
    pub fn set_bounds(&mut self, centers: &[f32], radii: &[f32]) -> Result<(), String> {
        if centers.len() != self.nodes.len() * 3
            || radii.len() != self.nodes.len()
            || centers.iter().any(|v| !v.is_finite())
            || radii.iter().any(|&r| !r.is_finite() || r < 0.)
        {
            return Err("invalid bounding spheres".into());
        }
        self.centers.copy_from_slice(centers);
        self.radii.copy_from_slice(radii);
        self.invalidate();
        Ok(())
    }

    fn invalidate(&mut self) {
        self.ranges.fill((0, 0));
        self.visible_ids.clear();
        self.visible_items.clear();
        self.packed = false;
        self.prepared = false;
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
            let group = self.groups[i] as usize * 2 + usize::from(self.mirrored[i]);
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
        self.invalidate();
        let planes = planes(view_projection)?;
        if self
            .nodes
            .iter()
            .any(|&id| id as usize >= scene.node_count())
        {
            return Err("mesh node is outside the scene".into());
        }
        for i in 0..self.nodes.len() {
            let offset = self.nodes[i] as usize * 16;
            let m: &Mat4 = scene.worlds[offset..offset + 16].try_into().unwrap();
            let visible = !culling || {
                let radius = f64::from(self.radii[i]) * radius_scale(m);
                let center = &self.centers[i * 3..i * 3 + 3];
                let world = [0, 1, 2].map(|axis| {
                    f64::from(m[axis]) * f64::from(center[0])
                        + f64::from(m[axis + 4]) * f64::from(center[1])
                        + f64::from(m[axis + 8]) * f64::from(center[2])
                        + f64::from(m[axis + 12])
                });
                planes
                    .iter()
                    .all(|p| p[0] * world[0] + p[1] * world[1] + p[2] * world[2] + p[3] >= -radius)
            };
            if visible {
                self.mirrored[i] = is_mirrored(m);
                let group = self.groups[i] as usize * 2 + usize::from(self.mirrored[i]);
                self.ranges[group].1 += 1;
                self.visible_ids.push(self.nodes[i]);
                self.visible_items.push(i);
            }
        }
        self.prepared = true;
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
        self.ranges
            .as_chunks::<2>()
            .0
            .iter()
            .map(|r| (r[0].1 + r[1].1) as u32)
            .collect()
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
    fn tiny_hierarchical_shear_keeps_a_sphere_crossing_the_frustum() {
        let angle = std::f32::consts::FRAC_PI_8;
        let scene = SceneGraph::new(
            &[-1, 0],
            &[
                2.000006,
                0.,
                0.,
                0.,
                0.,
                0.,
                1.,
                1.000008,
                1.,
                1.,
                0.,
                0.,
                0.,
                0.,
                0.,
                angle.sin(),
                angle.cos(),
                1.,
                1.,
                1.,
            ],
        )
        .unwrap();
        let m = &scene.worlds[16..32];
        let direction = std::f64::consts::FRAC_1_SQRT_2;
        let tip_x = m[12] as f64 + direction * (-m[0] as f64 + m[4] as f64);
        assert!(tip_x < 1., "sphere reaches the frustum: {tip_x}");
        let mut queue = RenderQueue::new(&[1], &[0], &[1.], 1).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_nodes(), vec![1]);
        queue.prepare_direct(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_nodes(), vec![1]);
    }

    #[test]
    fn reciprocal_radius_and_scale_remain_finite() {
        for (scale, radius) in [(1e-30, 1e30), (1e30, 1e-30)] {
            let scene = SceneGraph::new(
                &[-1; 2],
                &[
                    1.5, 0., 0., 0., 0., 0., 1., scale, scale, scale, 3., 0., 0., 0., 0., 0., 1.,
                    -scale, scale, scale,
                ],
            )
            .unwrap();
            let mut queue = RenderQueue::new(&[0, 1], &[0; 2], &[radius; 2], 1).unwrap();
            queue.prepare(&scene, &IDENTITY, true).unwrap();
            assert_eq!(queue.visible_nodes(), vec![0], "scale {scale}");
            queue.set_bounds(&[0.; 6], &[0.; 2]).unwrap();
            queue.prepare_direct(&scene, &IDENTITY, true).unwrap();
            assert_eq!(queue.visible_count(), 0);
        }
    }

    #[test]
    fn positive_clip_matrix_scaling_preserves_visibility() {
        let scene = SceneGraph::new(
            &[-1; 2],
            &[
                0.5, 0., 0., 0., 0., 0., 1., 1., 1., 1., 3., 0., 0., 0., 0., 0., 1., 1., 1., 1.,
            ],
        )
        .unwrap();
        let mut queue = RenderQueue::new(&[0, 1], &[0; 2], &[0.25; 2], 1).unwrap();
        for scale in [1e-30, 1., 1e30] {
            queue
                .prepare(&scene, &IDENTITY.map(|v| v * scale), true)
                .unwrap();
            assert_eq!(queue.visible_nodes(), vec![0], "clip scale {scale}");
        }
    }

    #[test]
    fn radius_bound_covers_the_exact_stretch_of_sheared_spheres() {
        for scale in [1e-30_f32, 1., 1e30] {
            for shear in [0., 1e-7, 4e-6, 0.1, 1., 1000.] {
                let mut matrix = IDENTITY;
                matrix[0] = -scale;
                matrix[4] = scale * shear;
                matrix[5] = scale;
                matrix[10] = scale;
                let s = f64::from(matrix[4]) / f64::from(scale);
                let exact = (s.hypot(2.) + s.abs()) * 0.5 * f64::from(scale);
                let bound = radius_scale(&matrix);
                assert!(bound.is_finite() && bound >= exact, "{bound} < {exact}");
                let frobenius = (3. + s * s).sqrt() * f64::from(scale);
                assert!(bound <= frobenius * (1. + 16. * f64::EPSILON));
            }
        }
        let mut zero = IDENTITY;
        zero[0] = 0.;
        zero[5] = 0.;
        zero[10] = 0.;
        assert_eq!(radius_scale(&zero), 0.);
    }

    #[test]
    fn offset_spheres_follow_rotation_scale_and_parent_reflection() {
        let s = std::f32::consts::FRAC_1_SQRT_2;
        let scene = SceneGraph::new(
            &[-1, 0],
            &[
                1., 2., 3., 0., 0., 0., 1., -2., 3., 4., 5., 6., 7., 0., 0., s, s, 0.5, 1., 2.,
            ],
        )
        .unwrap();
        let mut queue = RenderQueue::new(&[1], &[0], &[0.1], 1).unwrap();
        let mut camera = IDENTITY;
        camera[12..15].copy_from_slice(&[3., -23., -63.]);
        queue.prepare(&scene, &camera, true).unwrap();
        assert_eq!(queue.visible_count(), 0);
        queue.set_bounds(&[2., 3., 4.], &[0.1]).unwrap();
        queue.prepare(&scene, &camera, true).unwrap();
        assert_eq!(queue.visible_nodes(), vec![1]);
        assert_eq!(queue.mirrored, vec![true]);
        queue.prepare_direct(&scene, &camera, true).unwrap();
        assert_eq!(queue.visible_nodes(), vec![1]);
        camera[12] += 5.;
        queue.prepare(&scene, &camera, true).unwrap();
        assert_eq!(queue.visible_count(), 0);
    }

    #[test]
    fn bounds_updates_are_atomic_and_invalidate_cached_draws() {
        let scene = SceneGraph::new(&[-1], &[0., 0., 0., 0., 0., 0., 1., 1., 1., 1.]).unwrap();
        let mut queue = RenderQueue::new(&[0], &[0], &[1.], 1).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        for (centers, radii) in [
            (vec![0.; 2], vec![1.]),
            (vec![0.; 3], vec![]),
            (vec![f32::NAN, 0., 0.], vec![1.]),
            (vec![0., f32::INFINITY, 0.], vec![1.]),
            (vec![0.; 3], vec![-1.]),
            (vec![0.; 3], vec![f32::INFINITY]),
        ] {
            assert!(queue.set_bounds(&centers, &radii).is_err());
            assert!(queue.prepared && queue.packed);
            assert_eq!(queue.centers, vec![0.; 3]);
            assert_eq!(queue.radii, vec![1.]);
        }
        queue.set_bounds(&[100., 0., 0.], &[0.]).unwrap();
        assert!(!queue.prepared && !queue.packed);
        assert_eq!(queue.visible_count(), 0);
        assert_eq!(queue.batch_count(), 0);
        assert_eq!(queue.matrices_len(), 0);
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_count(), 0);
        queue.set_bounds(&[1., 0., 0.], &[0.]).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_count(), 1);
        queue.set_bounds(&[1.001, 0., 0.], &[0.]).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.visible_count(), 0);
        RenderQueue::new(&[], &[], &[], 1)
            .unwrap()
            .set_bounds(&[], &[])
            .unwrap();
    }

    #[test]
    fn winding_batches_follow_parent_reflections_and_scale_changes() {
        let t = [0., 0., 0., 0., 0., 0., 1., 1., 1., 1.];
        let mut values = t.repeat(4);
        values[7] = -1.;
        values[27] = -1.;
        let mut scene = SceneGraph::new(&[-1, 0, 0, -1], &values).unwrap();
        let mut queue = RenderQueue::new(&[1, 2, 3], &[0; 3], &[0.1; 3], 1).unwrap();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.mirrored, vec![true, false, false]);
        assert_eq!(queue.batch_counts(), vec![3]);
        assert_eq!(queue.batch_count(), 2);
        assert_eq!(queue.ranges, vec![(0, 2), (2, 1)]);
        assert_eq!(queue.matrices[0], 1.);
        assert_eq!(queue.matrices[32], -1.);

        scene.set_transform(0, &t).unwrap();
        scene.update_world_matrices();
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert_eq!(queue.mirrored, vec![false, true, false]);
        assert_eq!(queue.visible_nodes(), vec![1, 2, 3]);
        assert_eq!(queue.matrices[32], -1.);

        scene.set_transform(2, &t).unwrap();
        scene.update_world_matrices();
        queue.prepare_direct(&scene, &IDENTITY, false).unwrap();
        assert_eq!(queue.mirrored, vec![false; 3]);
        assert_eq!(queue.batch_count(), 1);
        assert_eq!(queue.visible_items, vec![0, 1, 2]);
        assert_eq!(queue.matrices_len(), 0);
    }
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

    #[test]
    fn failed_prepare_invalidates_previous_draws_and_recovers_on_valid_input() {
        let scene = SceneGraph::new(&[-1], &[0., 0., 0., 0., 0., 0., 1., 1., 1., 1.]).unwrap();
        let empty_scene = SceneGraph::new(&[], &[]).unwrap();
        let mut queue = RenderQueue::new(&[0], &[0], &[1.], 1).unwrap();
        assert!(!queue.prepared);
        queue.prepare(&scene, &IDENTITY, false).unwrap();
        assert_eq!(queue.visible_count(), 1);
        assert!(queue.prepare(&scene, &[f32::NAN; 16], true).is_err());
        assert!(!queue.prepared);
        assert_eq!(queue.matrices_len(), 0);
        assert_eq!(queue.visible_count(), 0);
        assert_eq!(queue.batch_count(), 0);
        queue.prepare_direct(&scene, &IDENTITY, false).unwrap();
        assert!(queue.prepared);
        assert!(queue
            .prepare_direct(&empty_scene, &IDENTITY, false)
            .is_err());
        assert!(!queue.prepared);
        assert_eq!(queue.visible_count(), 0);
        queue.prepare(&scene, &IDENTITY, true).unwrap();
        assert!(queue.prepared && queue.packed);
        assert_eq!(queue.visible_count(), 1);
    }
}
