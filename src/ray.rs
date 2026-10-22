use wasm_bindgen::prelude::*;

const MAX_TRIANGLES: usize = 100_000;
const MISS: [f64; 4] = [-1., 0., 0., 0.];

pub(crate) fn validate_ray(
    origin: &[f32],
    direction: &[f32],
    t_min: f64,
    t_max: f64,
) -> Result<(), String> {
    if origin.len() != 3
        || direction.len() != 3
        || origin.iter().chain(direction).any(|v| !v.is_finite())
        || direction.iter().all(|&v| v == 0.)
        || !t_min.is_finite()
        || t_min < 0.
        || t_max.is_nan()
        || t_max < t_min
    {
        return Err("expected a finite ray with nonzero direction and 0 <= t_min <= t_max".into());
    }
    Ok(())
}

fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

fn intersect_triangle(
    origin: [f64; 3],
    direction: [f64; 3],
    vertices: [[f64; 3]; 3],
    range: [f64; 2],
    cull_back_faces: bool,
) -> [f64; 4] {
    let [a, b, c] = vertices;
    let ab = subtract(b, a);
    let ac = subtract(c, a);
    let p = cross(direction, ac);
    let determinant = dot(ab, p);
    if determinant == 0. || (cull_back_faces && determinant < 0.) {
        return MISS;
    }
    let offset = subtract(origin, a);
    let u = dot(offset, p) / determinant;
    if !(0. ..=1.).contains(&u) {
        return MISS;
    }
    let q = cross(offset, ab);
    let v = dot(direction, q) / determinant;
    if v < 0. || u + v > 1. {
        return MISS;
    }
    let t = dot(ac, q) / determinant;
    if !t.is_finite() || t < range[0] || t > range[1] {
        return MISS;
    }
    [t, 1. - (u + v), u, v]
}

/// Intersect one ray with indexed triangles in the same coordinate space.
/// Each result is [t, weight_a, weight_b, weight_c], or [-1, 0, 0, 0] for a miss.
#[wasm_bindgen]
pub fn ray_triangle_hits(
    origin: &[f32],
    direction: &[f32],
    positions: &[f32],
    indices: &[u32],
    t_min: f64,
    t_max: f64,
    cull_back_faces: bool,
) -> Result<Vec<f64>, String> {
    validate_ray(origin, direction, t_min, t_max)?;
    if !positions.len().is_multiple_of(3)
        || positions.iter().any(|v| !v.is_finite())
        || !indices.len().is_multiple_of(3)
        || indices.len() / 3 > MAX_TRIANGLES
    {
        return Err("expected finite xyz positions and at most 100000 indexed triangles".into());
    }
    let positions = positions.as_chunks::<3>().0;
    for (index, triangle) in indices.as_chunks::<3>().0.iter().enumerate() {
        if triangle.iter().any(|&id| id as usize >= positions.len()) {
            return Err(format!("invalid vertex index at triangle {index}"));
        }
    }
    let origin: [f32; 3] = origin.try_into().unwrap();
    let direction: [f32; 3] = direction.try_into().unwrap();
    let origin = origin.map(f64::from);
    let direction = direction.map(f64::from);
    let mut hits = Vec::with_capacity(indices.len() / 3 * 4);
    for triangle in indices.as_chunks::<3>().0 {
        let vertices = triangle.map(|id| positions[id as usize].map(f64::from));
        hits.extend_from_slice(&intersect_triangle(
            origin,
            direction,
            vertices,
            [t_min, t_max],
            cull_back_faces,
        ));
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRIANGLE: [f32; 9] = [0., 0., 0., 1., 0., 0., 0., 1., 0.];

    #[test]
    fn triangle_hits_report_vertex_weights_and_surface_parameters() {
        for (point, weights) in [
            ([0.25, 0.25, 1.], [0.5, 0.25, 0.25]),
            ([0., 0., 1.], [1., 0., 0.]),
            ([0.5, 0.5, 1.], [0., 0.5, 0.5]),
        ] {
            let hit = ray_triangle_hits(
                &point,
                &[0., 0., -1.],
                &TRIANGLE,
                &[0, 1, 2],
                0.,
                f64::INFINITY,
                true,
            )
            .unwrap();
            assert_eq!(hit, [1., weights[0], weights[1], weights[2]]);
        }
        assert_eq!(
            ray_triangle_hits(
                &[0.75, 0.75, 1.],
                &[0., 0., -1.],
                &TRIANGLE,
                &[0, 1, 2],
                0.,
                2.,
                false
            )
            .unwrap(),
            MISS
        );
    }

    #[test]
    fn winding_culling_and_parameter_clipping_are_explicit() {
        for order in [[0, 1, 2], [0, 2, 1]] {
            let both_sides = ray_triangle_hits(
                &[0.25, 0.25, -1.],
                &[0., 0., 2.],
                &TRIANGLE,
                &order,
                0.5,
                0.5,
                false,
            )
            .unwrap();
            assert_eq!(both_sides, [0.5, 0.5, 0.25, 0.25]);
            let culled = ray_triangle_hits(
                &[0.25, 0.25, -1.],
                &[0., 0., 2.],
                &TRIANGLE,
                &order,
                0.,
                1.,
                true,
            )
            .unwrap();
            assert_eq!(culled[0], if order[1] == 1 { -1. } else { 0.5 });
        }
        assert_eq!(
            ray_triangle_hits(
                &[0.25, 0.25, 1.],
                &[0., 0., -1.],
                &TRIANGLE,
                &[0, 1, 2],
                0.,
                0.5,
                false
            )
            .unwrap(),
            MISS
        );
    }

    #[test]
    fn coplanar_parallel_and_degenerate_triangles_have_no_unique_hit() {
        for (origin, direction, indices) in [
            ([0.25, 0.25, 0.], [1., 0., 0.], [0, 1, 2]),
            ([0.25, 0.25, 1.], [1., 0., 0.], [0, 1, 2]),
            ([0.25, 0.25, 1.], [0., 0., -1.], [0, 0, 2]),
        ] {
            assert_eq!(
                ray_triangle_hits(
                    &origin,
                    &direction,
                    &TRIANGLE,
                    &indices,
                    0.,
                    f64::INFINITY,
                    false
                )
                .unwrap(),
                MISS
            );
        }
        assert_eq!(
            ray_triangle_hits(
                &[0.25, 0.25, 0.],
                &[0., 0., -1.],
                &TRIANGLE,
                &[0, 1, 2],
                0.,
                0.,
                false
            )
            .unwrap(),
            [0., 0.5, 0.25, 0.25]
        );
    }

    #[test]
    fn nonzero_small_triangles_and_directions_do_not_use_absolute_epsilon() {
        for scale in [2_f64.powi(-140) as f32, 1., 2_f64.powi(120) as f32] {
            let positions = TRIANGLE.map(|v| v * scale);
            let hit = ray_triangle_hits(
                &[scale * 0.25, scale * 0.25, scale],
                &[0., 0., -scale],
                &positions,
                &[0, 1, 2],
                0.,
                f64::INFINITY,
                true,
            )
            .unwrap();
            assert_eq!(hit, [1., 0.5, 0.25, 0.25]);
        }
        let hit = ray_triangle_hits(
            &[0.25, 0.25, 1.],
            &[0., 0., -f32::from_bits(1)],
            &TRIANGLE,
            &[0, 1, 2],
            0.,
            f64::INFINITY,
            true,
        )
        .unwrap();
        assert_eq!(hit[0], 2_f64.powi(149));
    }

    #[test]
    fn malformed_batches_are_rejected_before_producing_hits() {
        let origin = [0., 0., 1.];
        let direction = [0., 0., -1.];
        assert!(
            ray_triangle_hits(&origin, &direction, &[0.; 8], &[0, 1, 2], 0., 1., false).is_err()
        );
        assert!(ray_triangle_hits(
            &origin,
            &direction,
            &[f32::NAN; 9],
            &[0, 1, 2],
            0.,
            1.,
            false
        )
        .is_err());
        assert!(ray_triangle_hits(&origin, &direction, &TRIANGLE, &[0, 1], 0., 1., false).is_err());
        assert!(ray_triangle_hits(
            &origin,
            &direction,
            &TRIANGLE,
            &[0, 1, 2, 0, 1, 3],
            0.,
            1.,
            false
        )
        .unwrap_err()
        .contains("triangle 1"));
        assert!(
            ray_triangle_hits(&origin, &[0.; 3], &TRIANGLE, &[0, 1, 2], 0., 1., false).is_err()
        );
        assert!(
            ray_triangle_hits(&origin, &direction, &TRIANGLE, &[0, 1, 2], 2., 1., false).is_err()
        );
        assert!(ray_triangle_hits(
            &origin,
            &direction,
            &TRIANGLE,
            &vec![0; (MAX_TRIANGLES + 1) * 3],
            0.,
            1.,
            false
        )
        .is_err());
        assert_eq!(
            ray_triangle_hits(&origin, &direction, &[], &[], 0., 1., false).unwrap(),
            []
        );
    }
}
