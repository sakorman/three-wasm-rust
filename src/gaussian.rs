use crate::bounds::add_outward;
use wasm_bindgen::prelude::*;

const MAX_SPLATS: usize = 1_000_000;

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
        let [xx, xy, yy] = covariance.map(f64::from);
        if !opacity.is_finite()
            || !(0. ..=1.).contains(&opacity)
            || covariance.iter().any(|v| !v.is_finite())
            || xx <= 0.
            || yy <= 0.
            || xx * yy - xy * xy <= 0.
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

/// Sort a unique candidate list by decreasing finite f32 depth.
/// Larger depth means farther away. Equal depths retain candidate order.
#[wasm_bindgen]
pub fn gaussian_depth_order(depths: &[f32], indices: &[u32]) -> Result<Vec<u32>, String> {
    if depths.len() > MAX_SPLATS || indices.len() > depths.len() {
        return Err("expected at most 1000000 depths and no more candidates than depths".into());
    }
    if depths.iter().any(|value| !value.is_finite()) {
        return Err("Gaussian depths must be finite".into());
    }
    let mut seen = vec![0_u64; depths.len().div_ceil(64)];
    for (candidate, &id) in indices.iter().enumerate() {
        let index = id as usize;
        if index >= depths.len() {
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
}
