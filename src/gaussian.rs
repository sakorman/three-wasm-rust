use crate::bounds::add_outward;
use wasm_bindgen::prelude::*;

const MAX_SPLATS: usize = 1_000_000;

fn valid_screen_covariance(covariance: &[f32; 3]) -> bool {
    let [xx, xy, yy] = covariance.map(f64::from);
    covariance.iter().all(|value| value.is_finite()) && xx > 0. && yy > 0. && xx * yy - xy * xy > 0.
}

fn finite_f32(value: f64, message: &str) -> Result<f32, String> {
    let value = value as f32;
    if value.is_finite() {
        Ok(value)
    } else {
        Err(message.into())
    }
}

/// Project camera-space 3D Gaussian covariances into pixel-space ellipses.
/// Inputs use `[xx, xy, xz, yy, yz, zz]`; output is
/// `[pixelX, pixelY, depth, screenXX, screenXY, screenYY]` per splat.
/// Reject a batch if its rounded f32 screen covariance loses positive definiteness.
#[wasm_bindgen]
pub fn gaussian_project_covariances(
    centers: &[f32],
    covariances: &[f32],
    focal_x: f32,
    focal_y: f32,
    principal_x: f32,
    principal_y: f32,
) -> Result<Vec<f32>, String> {
    if !centers.len().is_multiple_of(3)
        || covariances.len() != centers.len() / 3 * 6
        || centers.len() / 3 > MAX_SPLATS
    {
        return Err(
            "expected xyz centers and six covariance values per splat, at most 1000000 splats"
                .into(),
        );
    }
    if [focal_x, focal_y, principal_x, principal_y]
        .iter()
        .any(|value| !value.is_finite())
        || focal_x <= 0.
        || focal_y <= 0.
    {
        return Err("camera intrinsics must be finite with positive focal lengths".into());
    }
    for (index, (center, covariance)) in centers
        .as_chunks::<3>()
        .0
        .iter()
        .zip(covariances.as_chunks::<6>().0)
        .enumerate()
    {
        let [_, _, z] = center.map(f64::from);
        let [xx, xy, xz, yy, yz, zz] = covariance.map(f64::from);
        let determinant =
            xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
        if !center.iter().all(|value| value.is_finite())
            || !covariance.iter().all(|value| value.is_finite())
            || z <= 0.
            || xx <= 0.
            || xx * yy - xy * xy <= 0.
            || determinant <= 0.
        {
            return Err(format!(
                "invalid Gaussian center, depth or covariance at splat {index}"
            ));
        }
    }
    let fx = f64::from(focal_x);
    let fy = f64::from(focal_y);
    let px = f64::from(principal_x);
    let py = f64::from(principal_y);
    let mut result = Vec::with_capacity(centers.len() / 3 * 6);
    for (index, (center, covariance)) in centers
        .as_chunks::<3>()
        .0
        .iter()
        .zip(covariances.as_chunks::<6>().0)
        .enumerate()
    {
        let [x, y, z] = center.map(f64::from);
        let [xx, xy, xz, yy, yz, zz] = covariance.map(f64::from);
        let inv_z = 1. / z;
        let inv_z2 = inv_z * inv_z;
        let jx = [fx * inv_z, 0., -fx * x * inv_z2];
        let jy = [0., fy * inv_z, -fy * y * inv_z2];
        let c_xx = jx[0] * (jx[0] * xx + jx[2] * xz) + jx[2] * (jx[0] * xz + jx[2] * zz);
        let c_xy = jx[0] * (jy[1] * xy + jy[2] * xz) + jx[2] * (jy[1] * yz + jy[2] * zz);
        let c_yy = jy[1] * (jy[1] * yy + jy[2] * yz) + jy[2] * (jy[1] * yz + jy[2] * zz);
        let projected = [
            finite_f32(
                fx * x * inv_z + px,
                "projected Gaussian center exceeds f32 range",
            )?,
            finite_f32(
                fy * y * inv_z + py,
                "projected Gaussian center exceeds f32 range",
            )?,
            finite_f32(z, "Gaussian depth exceeds f32 range")?,
            finite_f32(c_xx, "projected Gaussian covariance exceeds f32 range")?,
            finite_f32(c_xy, "projected Gaussian covariance exceeds f32 range")?,
            finite_f32(c_yy, "projected Gaussian covariance exceeds f32 range")?,
        ];
        // Check the stored precision consumed by bounds and conic inversion.
        if !valid_screen_covariance(&[projected[3], projected[4], projected[5]]) {
            return Err(format!(
                "projected Gaussian covariance is not positive definite in f32 at splat {index}"
            ));
        }
        result.extend_from_slice(&projected);
    }
    Ok(result)
}

fn half_extent(variance: f64, radius_squared: f64) -> f32 {
    // One f32 step covers arithmetic rounding; half a pixel preserves boundary samples.
    let extent = if radius_squared == 0. {
        0.
    } else {
        ((variance * radius_squared).sqrt() as f32).next_up()
    };
    let padded = add_outward(f64::from(extent), 0.5, true);
    let rounded = padded as f32;
    if f64::from(rounded) < padded {
        rounded.next_up()
    } else {
        rounded
    }
}

/// Pixel half-extents for alpha = opacity * exp(-0.5 * dᵀ covariance⁻¹ d).
/// Covariances are packed [xx, xy, yy]. Opacity below cutoff returns [0, 0].
#[wasm_bindgen]
pub fn gaussian_screen_bounds(
    covariances: &[f32],
    opacities: &[f32],
    cutoff: f32,
) -> Result<Vec<f32>, String> {
    if !cutoff.is_finite() || cutoff <= 0. || cutoff > 1. {
        return Err("Gaussian cutoff must be finite and in (0, 1]".into());
    }
    if opacities.len() > MAX_SPLATS || covariances.len() != opacities.len() * 3 {
        return Err("expected three covariance values per opacity, at most 1000000 splats".into());
    }
    let covariances = covariances.as_chunks::<3>().0;
    for (index, (covariance, &opacity)) in covariances.iter().zip(opacities).enumerate() {
        if !opacity.is_finite()
            || !(0. ..=1.).contains(&opacity)
            || !valid_screen_covariance(covariance)
        {
            return Err(format!(
                "invalid Gaussian opacity or positive-definite covariance at splat {index}"
            ));
        }
    }
    let mut result = Vec::with_capacity(opacities.len() * 2);
    for (covariance, &opacity) in covariances.iter().zip(opacities) {
        if opacity < cutoff {
            result.extend_from_slice(&[0., 0.]);
            continue;
        }
        let radius_squared = 2. * (f64::from(opacity) / f64::from(cutoff)).ln();
        result.extend_from_slice(&[
            half_extent(f64::from(covariance[0]), radius_squared),
            half_extent(f64::from(covariance[2]), radius_squared),
        ]);
    }
    Ok(result)
}

/// Return stable indices for splats whose peak opacity reaches the cutoff.
/// This lets a later renderer compact work before projection and rasterization.
#[wasm_bindgen]
pub fn gaussian_visible_indices(opacities: &[f32], cutoff: f32) -> Result<Vec<u32>, String> {
    if !cutoff.is_finite() || cutoff <= 0. || cutoff > 1. {
        return Err("Gaussian cutoff must be finite and in (0, 1]".into());
    }
    if opacities.len() > MAX_SPLATS {
        return Err("at most 1000000 Gaussian opacities are supported".into());
    }
    if opacities
        .iter()
        .any(|&value| !value.is_finite() || !(0. ..=1.).contains(&value))
    {
        return Err("Gaussian opacities must be finite values in [0, 1]".into());
    }
    Ok(opacities
        .iter()
        .enumerate()
        .filter_map(|(index, &opacity)| (opacity >= cutoff).then_some(index as u32))
        .collect())
}

fn descending_depth_key(depth: f32) -> u32 {
    // Both zeros compare equal; finite f32 keys otherwise follow numeric order.
    let bits = if depth == 0. { 0 } else { depth.to_bits() };
    let ascending = if bits & 0x8000_0000 == 0 {
        bits ^ 0x8000_0000
    } else {
        !bits
    };
    !ascending
}

fn validate_depth_candidates(depths: &[f32], indices: &[u32]) -> Result<(), String> {
    if depths.len() > MAX_SPLATS || indices.len() > depths.len() {
        return Err("expected at most 1000000 depths and no more candidates than depths".into());
    }
    if depths.iter().any(|value| !value.is_finite()) {
        return Err("Gaussian depths must be finite".into());
    }
    validate_candidate_indices(depths.len(), indices)
}

fn validate_candidate_indices(count: usize, indices: &[u32]) -> Result<(), String> {
    let mut seen = vec![0_u64; count.div_ceil(64)];
    for (candidate, &id) in indices.iter().enumerate() {
        let index = id as usize;
        if index >= count {
            return Err(format!(
                "Gaussian index out of range at candidate {candidate}"
            ));
        }
        let mask = 1_u64 << (index % 64);
        if seen[index / 64] & mask != 0 {
            return Err(format!("duplicate Gaussian index at candidate {candidate}"));
        }
        seen[index / 64] |= mask;
    }
    Ok(())
}

/// Keep positive-area screen bounds intersecting [0, width] x [0, height].
/// Centers and half extents are packed xy pairs. Touching bounds retain their
/// original candidate order; this is a bounds test, not a visibility guarantee.
#[wasm_bindgen]
pub fn gaussian_viewport_indices(
    centers: &[f32],
    half_extents: &[f32],
    indices: &[u32],
    width: f32,
    height: f32,
) -> Result<Vec<u32>, String> {
    if !centers.len().is_multiple_of(2)
        || half_extents.len() != centers.len()
        || centers.len() / 2 > MAX_SPLATS
        || indices.len() > centers.len() / 2
    {
        return Err("expected paired xy centers and half extents, at most 1000000 splats and no more candidates than splats".into());
    }
    if !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0. {
        return Err("Gaussian viewport dimensions must be finite and positive".into());
    }
    if centers.iter().any(|value| !value.is_finite())
        || half_extents
            .iter()
            .any(|&value| !value.is_finite() || value < 0.)
    {
        return Err(
            "Gaussian screen centers must be finite and half extents finite and nonnegative".into(),
        );
    }
    validate_candidate_indices(centers.len() / 2, indices)?;
    let limits = [f64::from(width), f64::from(height)];
    Ok(indices
        .iter()
        .copied()
        .filter(|&id| {
            let offset = id as usize * 2;
            (0..2).all(|axis| {
                let center = f64::from(centers[offset + axis]);
                let extent = f64::from(half_extents[offset + axis]);
                extent > 0.
                    && add_outward(center, extent, true) >= 0.
                    && add_outward(center, -extent, false) <= limits[axis]
            })
        })
        .collect())
}

/// Keep candidate centers with near <= depth <= far, preserving candidate order.
/// Depth is positive forward; near must be finite and positive. Far may be +infinity.
/// This filters centers only, not the full Gaussian support volume.
#[wasm_bindgen]
pub fn gaussian_clip_depth_indices(
    depths: &[f32],
    indices: &[u32],
    near: f32,
    far: f32,
) -> Result<Vec<u32>, String> {
    if !near.is_finite() || near <= 0. || far.is_nan() || far < near {
        return Err("expected finite near > 0 and far >= near for Gaussian depth clipping".into());
    }
    validate_depth_candidates(depths, indices)?;
    Ok(indices
        .iter()
        .copied()
        .filter(|&id| {
            let depth = depths[id as usize];
            depth >= near && depth <= far
        })
        .collect())
}

/// Sort a unique candidate list by decreasing finite f32 depth.
/// Larger depth means farther away. Equal depths retain candidate order.
#[wasm_bindgen]
pub fn gaussian_depth_order(depths: &[f32], indices: &[u32]) -> Result<Vec<u32>, String> {
    validate_depth_candidates(depths, indices)?;
    let mut order = indices.to_vec();
    if order.len() < 2 {
        return Ok(order);
    }
    let mut scratch = vec![0; order.len()];
    for shift in [0, 8, 16, 24] {
        let mut offsets = [0_usize; 256];
        for &id in &order {
            offsets[((descending_depth_key(depths[id as usize]) >> shift) & 255) as usize] += 1;
        }
        let mut prefix = 0;
        for count in &mut offsets {
            let length = *count;
            *count = prefix;
            prefix += length;
        }
        for &id in &order {
            let digit = ((descending_depth_key(depths[id as usize]) >> shift) & 255) as usize;
            scratch[offsets[digit]] = id;
            offsets[digit] += 1;
        }
        std::mem::swap(&mut order, &mut scratch);
    }
    Ok(order)
}

fn f32_to_half_outward(value: f32) -> Result<u16, String> {
    if !value.is_finite() || value < 0. || value > 65504. {
        return Err("Gaussian extent must be finite and in [0, 65504]".into());
    }
    if value == 0. {
        return Ok(0);
    }
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ff_ff;
    if exponent <= 0 {
        if exponent < -10 {
            return Ok(1);
        }
        let value = mantissa | 0x80_00_00;
        let shift = (14 - exponent) as u32;
        let mut half = (value >> shift) as u16;
        let remainder = value & ((1 << shift) - 1);
        if remainder != 0 {
            half += 1;
        }
        return Ok(half);
    }
    let mut half = ((exponent as u16) << 10) | (mantissa >> 13) as u16;
    let remainder = mantissa & 0x1fff;
    // The validated upper bound keeps outward rounding finite.
    if remainder != 0 {
        half += 1;
    }
    Ok(half)
}

/// Pack nonnegative [halfWidth, halfHeight] pairs into one u32 per Gaussian.
/// The low/high 16-bit halves use IEEE 754 binary16 and preserve input order.
/// Each extent rounds upward so decoding cannot shrink the input bounds.
#[wasm_bindgen]
pub fn gaussian_pack_half_extents(half_extents: &[f32]) -> Result<Vec<u32>, String> {
    if !half_extents.len().is_multiple_of(2) || half_extents.len() / 2 > MAX_SPLATS {
        return Err("expected pairs of half extents, at most 1000000 splats".into());
    }
    half_extents
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let width = u32::from(f32_to_half_outward(pair[0])?);
            let height = u32::from(f32_to_half_outward(pair[1])?);
            Ok(width | height << 16)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opacity_changes_support_and_keeps_threshold_equality() {
        let cutoff = 1. / 255.;
        let values =
            gaussian_screen_bounds(&[4., 0., 9.].repeat(4), &[1., 0.1, cutoff, 0.], cutoff)
                .unwrap();
        assert!(values[0] > values[2] && values[1] > values[3]);
        assert_eq!(&values[4..], &[0.5, 0.5, 0., 0.]);
        let radius = (2. * (1. / f64::from(cutoff)).ln()).sqrt();
        assert!(f64::from(values[0]) >= radius * 2. + 0.5);
        assert!(f64::from(values[1]) >= radius * 3. + 0.5);
    }

    #[test]
    fn perspective_projection_uses_f64_jacobian_and_keeps_cross_terms() {
        let result = gaussian_project_covariances(
            &[2., 3., 10.],
            &[1., 0.2, 0.1, 4., 0.3, 9.],
            100.,
            200.,
            320.,
            240.,
        )
        .unwrap();
        assert_eq!(&result[..3], &[340., 300., 10.]);
        assert!((result[3] - 132.).abs() < 1e-5);
        assert!((result[4] - 130.).abs() < 1e-5);
        assert!((result[5] - 1852.).abs() < 1e-5);
    }

    #[test]
    fn projection_rejects_covariances_that_degenerate_when_stored_as_f32() {
        for center in [[0., 0., 1e30], [1e5, 1e5, 1.], [1e5, 100001., 1.]] {
            let centers = [0., 0., 1., center[0], center[1], center[2]];
            let covariance = [1., 0., 0., 1., 0., 1.].repeat(2);
            let error =
                gaussian_project_covariances(&centers, &covariance, 1., 1., 0., 0.).unwrap_err();
            assert!(
                error.contains("positive definite in f32 at splat 1"),
                "{error}"
            );
        }
    }

    #[test]
    fn projection_keeps_representable_positive_covariances_without_an_epsilon_floor() {
        let tiny = gaussian_project_covariances(
            &[0., 0., 2_f32.powi(74)],
            &[0.5, 0., 0., 0.5, 0., 1.],
            1.,
            1.,
            0.,
            0.,
        )
        .unwrap();
        assert_eq!(&tiny[3..], &[f32::from_bits(1), 0., f32::from_bits(1)]);
        assert!(gaussian_screen_bounds(&tiny[3..], &[1.], 1. / 255.).is_ok());
        let huge = gaussian_project_covariances(
            &[0., 0., 1.],
            &[f32::MAX, 0., 0., f32::MAX, 0., f32::MAX],
            1.,
            1.,
            0.,
            0.,
        )
        .unwrap();
        assert_eq!(&huge[3..], &[f32::MAX, 0., f32::MAX]);
        assert!(gaussian_screen_bounds(&huge[3..], &[1.], 1. / 255.).is_ok());
    }

    #[test]
    fn perspective_projection_rejects_invalid_batch_atomically() {
        assert!(gaussian_project_covariances(
            &[0., 0., 2., 0., 0., -1.],
            &[1., 0., 0., 1., 0., 1., 1., 0., 0., 1., 0., 1.],
            1.,
            1.,
            0.,
            0.
        )
        .unwrap_err()
        .contains("splat 1"));
        assert!(gaussian_project_covariances(&[0., 0.], &[], 1., 1., 0., 0.).is_err());
    }

    #[test]
    fn rotated_ellipse_boundary_stays_inside_the_padded_quad() {
        let covariance = [25., 12., 9.];
        let cutoff = 1. / 255.;
        let extents = gaussian_screen_bounds(&covariance, &[0.2], cutoff).unwrap();
        let radius = (2. * (f64::from(0.2_f32) / f64::from(cutoff)).ln()).sqrt();
        for step in 0..360 {
            let angle = f64::from(step).to_radians();
            let x = radius * 5. * angle.cos();
            let y = radius * (2.4 * angle.cos() + (9_f64 - 2.4 * 2.4).sqrt() * angle.sin());
            assert!(x.abs() + 0.5 <= f64::from(extents[0]));
            assert!(y.abs() + 0.5 <= f64::from(extents[1]));
        }
    }

    #[test]
    fn finite_covariance_extremes_do_not_overflow_or_drop_pixel_padding() {
        let tiny = f32::from_bits(1);
        let result =
            gaussian_screen_bounds(&[tiny, 0., tiny, f32::MAX, 0., f32::MAX], &[1., 1.], tiny)
                .unwrap();
        assert!(result.iter().all(|value| value.is_finite() && *value > 0.5));
        assert_eq!(gaussian_screen_bounds(&[], &[], 1.).unwrap(), []);
    }

    #[test]
    fn invalid_batches_are_rejected_even_when_opacity_is_invisible() {
        for covariance in [[0., 0., 1.], [1., 2., 1.], [1., 1., 1.], [f32::NAN, 0., 1.]] {
            assert!(gaussian_screen_bounds(&covariance, &[0.], 0.01).is_err());
        }
        for opacity in [-1., 1.1, f32::NAN, f32::INFINITY] {
            assert!(gaussian_screen_bounds(&[1., 0., 1.], &[opacity], 0.01).is_err());
        }
        for cutoff in [0., -1., 2., f32::NAN, f32::INFINITY] {
            assert!(gaussian_screen_bounds(&[1., 0., 1.], &[1.], cutoff).is_err());
        }
        assert!(gaussian_screen_bounds(&[1., 0.], &[1.], 0.01).is_err());
        assert!(gaussian_screen_bounds(&[], &vec![1.; MAX_SPLATS + 1], 0.01).is_err());
    }

    #[test]
    fn visible_indices_are_stable_and_match_bound_culling() {
        let cutoff = 1. / 255.;
        let opacity = [0., cutoff - f32::EPSILON, cutoff, 0.2, 1.];
        assert_eq!(
            gaussian_visible_indices(&opacity, cutoff).unwrap(),
            [2, 3, 4]
        );
        let bounds =
            gaussian_screen_bounds(&[1., 0., 1.].repeat(opacity.len()), &opacity, cutoff).unwrap();
        for index in 0..opacity.len() {
            assert_eq!(
                bounds[index * 2] > 0. || bounds[index * 2 + 1] > 0.,
                opacity[index] >= cutoff
            );
        }
        assert!(gaussian_visible_indices(&[f32::NAN], cutoff).is_err());
        assert!(gaussian_visible_indices(&[1.], 0.).is_err());
        assert_eq!(gaussian_visible_indices(&[], cutoff).unwrap(), []);
        assert_eq!(gaussian_visible_indices(&[0.; 4], cutoff).unwrap(), []);
        assert_eq!(
            gaussian_visible_indices(&[1.; 4], 1.).unwrap(),
            [0, 1, 2, 3]
        );
        assert!(gaussian_visible_indices(&vec![0.; MAX_SPLATS + 1], cutoff).is_err());
    }

    #[test]
    fn viewport_candidates_keep_all_touching_edges_and_input_order() {
        let centers = [
            -1., 2., 5., 2., 2., -1., 2., 5., -2., 2., 6., 2., 2., -2., 2., 6., 2., 2., 2., 2.,
        ];
        let mut extents = [1.; 20];
        extents[18] = 0.;
        let candidates = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
        assert_eq!(
            gaussian_viewport_indices(&centers, &extents, &candidates, 4., 4.).unwrap(),
            [8, 3, 2, 1, 0]
        );
        assert_eq!(
            gaussian_viewport_indices(&[], &[], &[], 4., 4.).unwrap(),
            []
        );
        assert_eq!(
            gaussian_viewport_indices(&centers, &extents, &[], 4., 4.).unwrap(),
            []
        );
    }

    #[test]
    fn viewport_candidates_handle_extreme_and_subnormal_bounds() {
        let tiny = f32::from_bits(1);
        assert_eq!(
            gaussian_viewport_indices(
                &[-f32::MAX, 0., f32::MAX, 0., tiny, tiny, -tiny, tiny],
                &[f32::MAX, 1., f32::MAX, 1., tiny, tiny, tiny, tiny],
                &[3, 2, 1, 0],
                tiny,
                tiny,
            )
            .unwrap(),
            [3, 2, 1, 0]
        );
        assert_eq!(
            gaussian_viewport_indices(&[2. + f32::EPSILON * 2., 1.], &[1., 1.], &[0], 1., 1.)
                .unwrap(),
            []
        );
    }

    #[test]
    fn viewport_candidates_validate_entire_batches() {
        for invalid in [0., -1., f32::INFINITY, f32::NAN] {
            assert!(gaussian_viewport_indices(&[], &[], &[], invalid, 1.).is_err());
            assert!(gaussian_viewport_indices(&[], &[], &[], 1., invalid).is_err());
        }
        for invalid in [-1., f32::INFINITY, f32::NAN] {
            assert!(gaussian_viewport_indices(
                &[0., 0., 0., 0.],
                &[1., 1., invalid, 1.],
                &[0],
                1.,
                1.
            )
            .is_err());
        }
        assert!(
            gaussian_viewport_indices(&[0., 0., f32::NAN, 0.], &[1.; 4], &[0], 1., 1.).is_err()
        );
        assert!(gaussian_viewport_indices(&[0.], &[1.], &[], 1., 1.).is_err());
        assert!(gaussian_viewport_indices(&[0., 0.], &[], &[], 1., 1.).is_err());
        assert!(
            gaussian_viewport_indices(&[0.; 4], &[1.; 4], &[0, 0], 1., 1.)
                .unwrap_err()
                .contains("duplicate")
        );
        assert!(
            gaussian_viewport_indices(&[0., 0.], &[1., 1.], &[1], 1., 1.)
                .unwrap_err()
                .contains("out of range")
        );
        assert!(gaussian_viewport_indices(&[0., 0.], &[1., 1.], &[0, 0], 1., 1.).is_err());
        assert!(gaussian_viewport_indices(
            &vec![0.; MAX_SPLATS * 2 + 2],
            &vec![1.; MAX_SPLATS * 2 + 2],
            &[],
            1.,
            1.
        )
        .is_err());
    }

    #[test]
    fn depth_clipping_keeps_boundary_centers_and_candidate_order() {
        let depths = [
            -1.,
            -0.,
            0.,
            0.5,
            1.,
            1_f32.next_up(),
            2.,
            2_f32.next_up(),
            f32::MAX,
        ];
        assert_eq!(
            gaussian_clip_depth_indices(&depths, &[8, 6, 4, 3, 5, 7, 0, 2, 1], 1., 2.).unwrap(),
            [6, 4, 5]
        );
        assert_eq!(
            gaussian_clip_depth_indices(&depths, &[8, 4], 1., f32::INFINITY).unwrap(),
            [8, 4]
        );
        assert_eq!(
            gaussian_clip_depth_indices(&depths, &[4, 5], 1., 1.).unwrap(),
            [4]
        );
        let tiny = f32::from_bits(1);
        assert_eq!(
            gaussian_clip_depth_indices(&[0., tiny], &[0, 1], tiny, tiny).unwrap(),
            [1]
        );
        assert_eq!(gaussian_clip_depth_indices(&[], &[], 1., 2.).unwrap(), []);
        assert_eq!(
            gaussian_clip_depth_indices(&depths, &[0, 1, 2], 1., 2.).unwrap(),
            []
        );
    }

    #[test]
    fn depth_clipping_validates_even_discarded_candidates() {
        for (near, far) in [
            (0., 1.),
            (-0., 1.),
            (-1., 1.),
            (2., 1.),
            (1., f32::NEG_INFINITY),
            (f32::INFINITY, f32::INFINITY),
            (f32::NAN, 1.),
            (1., f32::NAN),
        ] {
            assert!(gaussian_clip_depth_indices(&[], &[], near, far).is_err());
        }
        for depth in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(gaussian_clip_depth_indices(&[1., depth], &[0], 1., 2.).is_err());
        }
        assert!(gaussian_clip_depth_indices(&[-1., 1.], &[0, 0], 1., 2.)
            .unwrap_err()
            .contains("duplicate"));
        assert!(gaussian_clip_depth_indices(&[1.], &[1], 1., 2.)
            .unwrap_err()
            .contains("out of range"));
        assert!(gaussian_clip_depth_indices(&[1.], &[0, 0], 1., 2.).is_err());
        assert!(gaussian_clip_depth_indices(&vec![1.; MAX_SPLATS + 1], &[], 1., 2.).is_err());
    }

    #[test]
    fn depth_order_is_back_to_front_and_stable_for_ties() {
        assert_eq!(
            gaussian_depth_order(&[1., 3., 2., 3., 0.], &[0, 3, 2, 1, 4]).unwrap(),
            [3, 1, 2, 0, 4]
        );
        assert_eq!(
            gaussian_depth_order(&[0., -0., 0.], &[2, 1, 0]).unwrap(),
            [2, 1, 0]
        );
        assert_eq!(
            gaussian_depth_order(&[10., 1., 2., 100.], &[2, 1]).unwrap(),
            [2, 1]
        );
        assert_eq!(gaussian_depth_order(&[], &[]).unwrap(), []);
        assert_eq!(gaussian_depth_order(&[1., 2.], &[1]).unwrap(), [1]);
    }

    #[test]
    fn depth_order_preserves_adjacent_floats_and_signed_extremes() {
        let depths = [
            -f32::MAX,
            -1.,
            -f32::from_bits(1),
            -0.,
            0.,
            f32::from_bits(1),
            1_f32.next_down(),
            1.,
            1_f32.next_up(),
            f32::MAX,
        ];
        let candidates: Vec<u32> = (0..depths.len() as u32).collect();
        assert_eq!(
            gaussian_depth_order(&depths, &candidates).unwrap(),
            [9, 8, 7, 6, 5, 3, 4, 2, 1, 0]
        );
    }

    #[test]
    fn radix_order_matches_stable_comparison_sort() {
        let mut state = 12345_u32;
        let depths: Vec<f32> = (0..4097)
            .map(|i| {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                if i % 5 == 0 {
                    1.
                } else {
                    f32::from_bits((state & 0x807f_ffff) | (((state >> 23) % 255) << 23))
                }
            })
            .collect();
        let indices: Vec<u32> = (0..depths.len() as u32).rev().collect();
        let mut expected = indices.clone();
        expected.sort_by(|&a, &b| depths[b as usize].partial_cmp(&depths[a as usize]).unwrap());
        assert_eq!(gaussian_depth_order(&depths, &indices).unwrap(), expected);
    }

    #[test]
    fn invalid_depth_batches_are_rejected_without_mutation() {
        let depths = [1., 2., 3.];
        let indices = [2, 0, 2];
        assert!(gaussian_depth_order(&depths, &indices)
            .unwrap_err()
            .contains("duplicate"));
        assert_eq!(indices, [2, 0, 2]);
        assert_eq!(depths, [1., 2., 3.]);
        assert!(gaussian_depth_order(&depths, &[3])
            .unwrap_err()
            .contains("out of range"));
        for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            assert!(gaussian_depth_order(&[1., invalid], &[0]).is_err());
        }
        assert!(gaussian_depth_order(&[1.], &[0, 0]).is_err());
        assert!(gaussian_depth_order(&vec![0.; MAX_SPLATS + 1], &[]).is_err());
    }

    #[test]
    fn half_extent_packing_rounds_pairs_and_keeps_zero_support_compact() {
        let packed = gaussian_pack_half_extents(&[0., 0.5, 1., 2., 65504., 0.]).unwrap();
        assert_eq!(packed.len(), 3);
        assert_eq!(packed[0] >> 16, 0x3800); // 0.5
        assert_eq!(packed[0] & 0xffff, 0); // zero
        assert_eq!(packed[1] & 0xffff, 0x3c00); // 1
        assert_eq!(packed[1] >> 16, 0x4000); // 2
        assert_eq!(packed[2] & 0xffff, 0x7bff); // max finite binary16
        assert_eq!(packed[2] >> 16, 0);
    }

    #[test]
    fn half_extent_packing_never_shrinks_positive_support() {
        let packed = gaussian_pack_half_extents(&[
            2049.,
            2_f32.powi(-25),
            -0.,
            f32::from_bits(1),
            2_f32.powi(-14).next_down(),
            65504_f32.next_down(),
        ])
        .unwrap();
        assert_eq!(packed, [0x0001_6801, 0x0001_0000, 0x7bff_0400]);
    }

    #[test]
    fn half_extent_packing_rejects_invalid_values_and_shapes() {
        for value in [f32::NAN, f32::INFINITY, -1., 65505.] {
            assert!(gaussian_pack_half_extents(&[value, 1.]).is_err());
        }
        assert!(gaussian_pack_half_extents(&[1.]).is_err());
        assert!(gaussian_pack_half_extents(&vec![1.; MAX_SPLATS * 2 + 2]).is_err());
        assert_eq!(gaussian_pack_half_extents(&[]).unwrap(), []);
    }
}
