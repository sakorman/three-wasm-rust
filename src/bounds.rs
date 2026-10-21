use crate::math::Mat4;

// Recover the sign of addition rounding before expanding an interval endpoint.
fn add_outward(a: f64, b: f64, upper: bool) -> f64 {
    let sum = a + b;
    let recovered_b = sum - a;
    let error = (a - (sum - recovered_b)) + (b - recovered_b);
    if upper && error > 0. {
        sum.next_up()
    } else if !upper && error < 0. {
        sum.next_down()
    } else {
        sum
    }
}

fn to_f32_outward(value: f64, upper: bool) -> Result<f32, String> {
    let rounded = value as f32;
    let rounded = if upper && f64::from(rounded) < value {
        rounded.next_up()
    } else if !upper && f64::from(rounded) > value {
        rounded.next_down()
    } else {
        rounded
    };
    if !rounded.is_finite() {
        return Err("world AABB exceeds f32 range".into());
    }
    Ok(rounded)
}

/// Transform a finite, ordered local box by an affine f32 world matrix.
pub(crate) fn transform_aabb(matrix: &Mat4, bounds: &[f32; 6]) -> Result<[f32; 6], String> {
    let mut result = [0.; 6];
    for row in 0..3 {
        let mut min = f64::from(matrix[12 + row]);
        let mut max = min;
        for axis in 0..3 {
            // A product of two finite f32 values is exact and finite in f64.
            let a = f64::from(matrix[axis * 4 + row]) * f64::from(bounds[axis]);
            let b = f64::from(matrix[axis * 4 + row]) * f64::from(bounds[axis + 3]);
            min = add_outward(min, a.min(b), false);
            max = add_outward(max, a.max(b), true);
        }
        result[row] = to_f32_outward(min, false)?;
        result[row + 3] = to_f32_outward(max, true)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::IDENTITY;

    #[test]
    fn identity_preserves_points_planes_and_extreme_endpoints() {
        for bounds in [
            [0.; 6],
            [-1., 0., -2., 3., 0., 4.],
            [
                -f32::MAX,
                -f32::from_bits(1),
                0.,
                f32::MAX,
                f32::from_bits(1),
                0.,
            ],
        ] {
            assert_eq!(transform_aabb(&IDENTITY, &bounds).unwrap(), bounds);
        }
    }

    #[test]
    fn reflection_and_shear_select_each_axis_extreme() {
        let mut m = IDENTITY;
        m[0] = -2.;
        m[4] = 3.;
        m[8] = -0.5;
        m[12] = 5.;
        assert_eq!(
            transform_aabb(&m, &[-1., -2., -3., 4., 5., 6.]).unwrap(),
            [-12., -2., -3., 23.5, 5., 6.]
        );
    }

    #[test]
    fn bounds_round_outward_across_cancellation_and_underflow() {
        let mut m = IDENTITY;
        m[0] = 1e20;
        m[4] = 1.;
        m[8] = 1e20;
        let bounds = transform_aabb(&m, &[1., 0.5, -1., 1., 0.5, -1.]).unwrap();
        assert!(bounds[0] <= 0.5 && bounds[3] >= 0.5);
        m = IDENTITY;
        m[0] = f32::from_bits(1);
        assert_eq!(
            transform_aabb(&m, &[0.5, 0., 0., 0.5, 0., 0.]).unwrap(),
            [0., 0., 0., f32::from_bits(1), 0., 0.]
        );
        m[0] = -f32::from_bits(1);
        let bounds = transform_aabb(&m, &[0.5, 0., 0., 0.5, 0., 0.]).unwrap();
        assert_eq!(bounds[0], -f32::from_bits(1));
        assert_eq!(bounds[3], 0.);
    }

    #[test]
    fn unrepresentable_world_bounds_are_rejected() {
        let mut m = IDENTITY;
        m[0] = f32::MAX;
        for x in [-2., 2.] {
            assert!(transform_aabb(&m, &[x, 0., 0., x, 0., 0.]).is_err());
        }
    }
}
