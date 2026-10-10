//! Column-major, column-vector matrices, matching Three.js and WebGL.
pub type Mat4 = [f32; 16];

pub const IDENTITY: Mat4 = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];

pub fn multiply(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.; 16];
    for col in 0..4 {
        for row in 0..4 {
            out[col * 4 + row] = (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum();
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
        // f64 avoids overflow when normalizing large, but finite, f32 input.
        let length = t[3..7]
            .iter()
            .map(|v| (*v as f64).powi(2))
            .sum::<f64>()
            .sqrt();
        if length < 1e-12 {
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
}
