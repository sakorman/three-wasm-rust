//! Column-major, column-vector matrices, matching Three.js and WebGL.
pub type Mat4 = [f32; 16];

pub const IDENTITY: Mat4 = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

/// The sign of the affine determinant includes reflections inherited from parents.
pub fn is_mirrored(m: &Mat4) -> bool {
    let [a, b, c, d, e, f, g, h, i] =
        [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]].map(f64::from);
    a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) < 0.
}

pub fn multiply(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.; 16];
    for col in 0..4 {
        for row in 0..4 {
            // Round once after accumulation so cancelling large terms retain small offsets.
            out[col * 4 + row] = (0..4)
                .map(|k| f64::from(a[k * 4 + row]) * f64::from(b[col * 4 + k]))
                .sum::<f64>() as f32;
        }
    }
    out
}

/// Packed transform: position xyz, normalized quaternion xyzw, scale xyz.
pub fn compose(t: &[f32]) -> Mat4 {
    let [x, y, z, w] = [t[3], t[4], t[5], t[6]];
    let [sx, sy, sz] = [t[7], t[8], t[9]];
    let (xx, xy, xz) = (2. * x * x, 2. * x * y, 2. * x * z);
    let (yy, yz, zz) = (2. * y * y, 2. * y * z, 2. * z * z);
    let (wx, wy, wz) = (2. * w * x, 2. * w * y, 2. * w * z);
    [
        (1. - yy - zz) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.,
        (xy - wz) * sy,
        (1. - xx - zz) * sy,
        (yz + wx) * sy,
        0.,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1. - xx - yy) * sz,
        0.,
        t[0],
        t[1],
        t[2],
        1.,
    ]
}

pub fn normalize_transforms(values: &[f32]) -> Result<Vec<f32>, String> {
    if !values.len().is_multiple_of(10) || values.iter().any(|v| !v.is_finite()) {
        return Err("transforms must contain finite groups of 10 floats".into());
    }
    let mut output = values.to_vec();
    for t in output.as_chunks_mut::<10>().0 {
        // f64 keeps every nonzero finite f32 quaternion's squared length representable.
        let length = t[3..7]
            .iter()
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        if length == 0. {
            return Err("quaternion must have nonzero length".into());
        }
        for value in &mut t[3..7] {
            *value = (*value as f64 / length) as f32;
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplication_keeps_small_terms_between_cancelling_large_terms() {
        let mut a = IDENTITY;
        a[0] = 1e8;
        a[4] = 1.;
        a[12] = -1e8;
        let mut b = IDENTITY;
        b[12] = 1.;
        b[13] = 0.5;
        assert_eq!(multiply(&a, &b)[12], 0.5);
    }

    #[test]
    fn intermediate_products_can_exceed_f32_when_the_final_sum_is_finite() {
        let mut a = IDENTITY;
        a[0] = 1e20;
        a[4] = 1e20;
        let mut b = IDENTITY;
        b[0] = 1e20;
        b[1] = -1e20;
        let product = multiply(&a, &b);
        assert_eq!(product[0], 0.);
        assert!(product.iter().all(|v| v.is_finite()));
        b[1] = 0.;
        assert!(!multiply(&a, &b)[0].is_finite());
    }

    #[test]
    fn reflection_uses_world_orientation_without_overflow() {
        let transform = |x, y, z| compose(&[0., 0., 0., 0., 0., 0., 1., x, y, z]);
        for (scale, mirrored) in [
            ([1., 2., 3.], false),
            ([-1., 2., 3.], true),
            ([-1., -2., 3.], false),
            ([-1., -2., -3.], true),
            ([-1., 0., 3.], false),
            ([-f32::MAX, f32::MAX, f32::MAX], true),
            (
                [-f32::MIN_POSITIVE, f32::MIN_POSITIVE, f32::MIN_POSITIVE],
                true,
            ),
        ] {
            assert_eq!(
                is_mirrored(&transform(scale[0], scale[1], scale[2])),
                mirrored
            );
        }
        let parent = transform(-2., 3., 4.);
        let child = compose(&[0., 0., 0., 0., 0.5, 0., 0.8660254, 1., 1., 1.]);
        assert!(is_mirrored(&multiply(&parent, &child)));
        assert!(!is_mirrored(&multiply(&parent, &transform(-1., 1., 1.))));
    }

    #[test]
    fn translation_and_scale_follow_column_major_convention() {
        let a = compose(&[1., 2., 3., 0., 0., 0., 1., 2., 3., 4.]);
        let b = compose(&[5., 6., 7., 0., 0., 0., 1., 1., 1., 1.]);
        let world = multiply(&a, &b);
        assert_eq!(&world[12..15], &[11., 20., 31.]);
        assert_eq!(multiply(&world, &IDENTITY), world);
    }

    #[test]
    fn normalization_handles_large_and_invalid_quaternions() {
        let t = normalize_transforms(&[0., 0., 0., 0., 0., 0., f32::MAX, 1., 1., 1.]).unwrap();
        assert_eq!(compose(&t), IDENTITY);
        assert!(normalize_transforms(&[0.; 10]).is_err());
        assert!(normalize_transforms(&[f32::NAN; 10]).is_err());
        assert!(normalize_transforms(&[1.; 9]).is_err());
    }

    #[test]
    fn normalization_accepts_nonzero_subnormal_quaternions() {
        for magnitude in [f32::from_bits(1), 1e-30, 1e-20, 1e-13, 1., f32::MAX] {
            for sign in [-1., 1.] {
                let transform = [0., 0., 0., 0., 0., 0., sign * magnitude, 1., 1., 1.];
                let normalized = normalize_transforms(&transform).unwrap();
                assert_eq!(compose(&normalized), IDENTITY);
                assert_eq!(normalized[6], sign);
            }
        }
    }

    #[test]
    fn quaternion_rescaling_preserves_rotation_for_representable_components() {
        let mut base = [2., -3., 4., 0.25, -0.5, 0.75, 1., -2., 3., 4.];
        let expected = compose(&normalize_transforms(&base).unwrap());
        for exponent in [-140, -100, -40, 0, 40, 120] {
            for sign in [-1., 1.] {
                let factor = sign * 2_f64.powi(exponent) as f32;
                base[3..7].copy_from_slice(&[0.25 * factor, -0.5 * factor, 0.75 * factor, factor]);
                assert_eq!(compose(&normalize_transforms(&base).unwrap()), expected);
            }
        }
    }
}
