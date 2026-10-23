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
}
