use crate::bounds::add_outward;
use wasm_bindgen::prelude::*;

const MAX_SPLATS: usize = 1_000_000;
const MAX_TILES: usize = 1_000_000;
const MAX_TILE_REFERENCES: usize = 4_000_000;

fn valid_screen_covariance(covariance: &[f32; 3]) -> bool {
    let [xx, xy, yy] = covariance.map(f64::from);
    covariance.iter().all(|value| value.is_finite()) && xx > 0. && yy > 0. && xx * yy - xy * xy > 0.
}

fn valid_camera_covariance(covariance: &[f32; 6]) -> bool {
    let [xx, xy, xz, yy, yz, zz] = covariance.map(f64::from);
    let determinant =
        xx * (yy * zz - yz * yz) - xy * (xy * zz - yz * xz) + xz * (xy * yz - yy * xz);
    covariance.iter().all(|value| value.is_finite())
        && xx > 0.
        && xx * yy - xy * xy > 0.
        && determinant > 0.
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
        if !center.iter().all(|value| value.is_finite())
            || center[2] <= 0.
            || !valid_camera_covariance(covariance)
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

/// Apply an isotropic screen-space low-pass filter to projected covariances.
///
/// Each output is `[xx, xy, yy, opacity]`. The filter adds
/// `filter_variance * I` to the covariance, then scales peak opacity by
/// `sqrt(det(original) / det(filtered))` so the continuous Gaussian integral
/// is preserved. The returned f32 covariance, rather than an intermediate
/// f64 value, defines the compensation used by later bounds and raster stages.
#[wasm_bindgen]
pub fn gaussian_filter_screen_covariances(
    covariances: &[f32],
    opacities: &[f32],
    filter_variance: f32,
) -> Result<Vec<f32>, String> {
    if !filter_variance.is_finite() || filter_variance < 0. {
        return Err("Gaussian filter variance must be finite and nonnegative".into());
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
    let variance = f64::from(filter_variance);
    let mut result = Vec::with_capacity(opacities.len() * 4);
    for (index, (covariance, &opacity)) in covariances.iter().zip(opacities).enumerate() {
        if filter_variance == 0. {
            result.extend_from_slice(&[covariance[0], covariance[1], covariance[2], opacity]);
            continue;
        }
        let [xx, xy, yy] = covariance.map(f64::from);
        let filtered = [
            finite_f32(
                xx + variance,
                "filtered Gaussian covariance exceeds f32 range",
            )?,
            covariance[1],
            finite_f32(
                yy + variance,
                "filtered Gaussian covariance exceeds f32 range",
            )?,
        ];
        if !valid_screen_covariance(&filtered) {
            return Err(format!(
                "filtered Gaussian covariance is not positive definite in f32 at splat {index}"
            ));
        }
        let determinant = xx * yy - xy * xy;
        let filtered_determinant = f64::from(filtered[0]) * f64::from(filtered[2]) - xy * xy;
        let compensated = finite_f32(
            f64::from(opacity) * (determinant / filtered_determinant).sqrt(),
            "filtered Gaussian opacity exceeds f32 range",
        )?;
        if !(0. ..=1.).contains(&compensated) {
            return Err(format!(
                "filtered Gaussian opacity is invalid at splat {index}"
            ));
        }
        result.extend_from_slice(&[filtered[0], filtered[1], filtered[2], compensated]);
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

fn tile_dimensions(width: u32, height: u32, tile_size: u32) -> Result<(usize, usize), String> {
    if width == 0 || height == 0 || tile_size == 0 {
        return Err("Gaussian tile dimensions and tile size must be positive".into());
    }
    let columns = (width - 1) / tile_size + 1;
    let rows = (height - 1) / tile_size + 1;
    if u64::from(columns) * u64::from(rows) > MAX_TILES as u64 {
        return Err("at most 1000000 Gaussian tiles are supported".into());
    }
    Ok((columns as usize, rows as usize))
}

fn tile_axis_range(
    center: f32,
    extent: f32,
    length: u32,
    tile_size: u32,
    tile_count: usize,
) -> Option<(usize, usize)> {
    if extent == 0. {
        return None;
    }
    let lower = add_outward(f64::from(center), -f64::from(extent), false);
    let upper = add_outward(f64::from(center), f64::from(extent), true);
    let length = f64::from(length);
    if upper < 0. || lower > length {
        return None;
    }
    let tile_size = f64::from(tile_size);
    let first = (lower.max(0.) / tile_size).floor() as usize;
    let last = (upper.min(length) / tile_size).floor() as usize;
    Some((first.min(tile_count - 1), last.min(tile_count - 1)))
}

/// Bin screen-space Gaussian bounds into row-major tiles.
///
/// The output begins with `tile_count + 1` offsets, followed by candidate IDs.
/// `tile_count` is `ceil(width / tile_size) * ceil(height / tile_size)`. For
/// tile `t`, IDs occupy `output[offsets[t]..offsets[t + 1]]`. Each tile keeps
/// input candidate order. Bounds touching a tile edge are retained so callers
/// can use the result for conservative raster work submission.
#[wasm_bindgen]
pub fn gaussian_tile_bins(
    centers: &[f32],
    half_extents: &[f32],
    indices: &[u32],
    width: u32,
    height: u32,
    tile_size: u32,
) -> Result<Vec<u32>, String> {
    if !centers.len().is_multiple_of(2)
        || half_extents.len() != centers.len()
        || centers.len() / 2 > MAX_SPLATS
        || indices.len() > centers.len() / 2
    {
        return Err("expected paired xy centers and half extents, at most 1000000 splats and no more candidates than splats".into());
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
    let (columns, rows) = tile_dimensions(width, height, tile_size)?;
    let tile_count = columns * rows;
    let mut ranges = Vec::with_capacity(indices.len());
    let mut counts = vec![0_usize; tile_count];
    let mut reference_count = 0_usize;
    for &id in indices {
        let offset = id as usize * 2;
        let range = match (
            tile_axis_range(
                centers[offset],
                half_extents[offset],
                width,
                tile_size,
                columns,
            ),
            tile_axis_range(
                centers[offset + 1],
                half_extents[offset + 1],
                height,
                tile_size,
                rows,
            ),
        ) {
            (Some((x0, x1)), Some((y0, y1))) => Some((x0, x1, y0, y1)),
            _ => None,
        };
        if let Some((x0, x1, y0, y1)) = range {
            let references = (x1 - x0 + 1) * (y1 - y0 + 1);
            reference_count = reference_count
                .checked_add(references)
                .filter(|&count| count <= MAX_TILE_REFERENCES)
                .ok_or("at most 4000000 Gaussian tile references are supported")?;
            for y in y0..=y1 {
                for x in x0..=x1 {
                    counts[y * columns + x] += 1;
                }
            }
        }
        ranges.push(range);
    }
    let mut offsets = Vec::with_capacity(tile_count + 1);
    offsets.push(0);
    for count in counts {
        offsets.push(offsets.last().unwrap() + count);
    }
    let mut cursors = offsets[..tile_count].to_vec();
    let mut entries = vec![0_u32; reference_count];
    for (&id, range) in indices.iter().zip(ranges) {
        if let Some((x0, x1, y0, y1)) = range {
            for y in y0..=y1 {
                for x in x0..=x1 {
                    let tile = y * columns + x;
                    entries[cursors[tile]] = id;
                    cursors[tile] += 1;
                }
            }
        }
    }
    let mut result = Vec::with_capacity(tile_count + 1 + reference_count);
    result.extend(offsets.into_iter().map(|offset| offset as u32));
    result.extend(entries);
    Ok(result)
}

fn validate_tile_bin_ranges(
    depths: &[f32],
    tile_bins: &[u32],
    tile_count: u32,
) -> Result<usize, String> {
    if depths.len() > MAX_SPLATS {
        return Err("at most 1000000 Gaussian depths are supported".into());
    }
    if depths.iter().any(|value| !value.is_finite()) {
        return Err("Gaussian depths must be finite".into());
    }
    let tile_count = tile_count as usize;
    if tile_count == 0 || tile_count > MAX_TILES {
        return Err("Gaussian tile count must be in 1..=1000000".into());
    }
    let offset_count = tile_count + 1;
    if tile_bins.len() < offset_count {
        return Err(
            "Gaussian tile bins must begin with one offset per tile plus a sentinel".into(),
        );
    }
    let entry_count = tile_bins.len() - offset_count;
    if entry_count > MAX_TILE_REFERENCES {
        return Err("at most 4000000 Gaussian tile references are supported".into());
    }
    let offsets = &tile_bins[..offset_count];
    if offsets[0] != 0 {
        return Err("Gaussian tile bin offsets must begin at zero".into());
    }
    let mut previous = 0_usize;
    for (tile, &offset) in offsets.iter().enumerate() {
        let offset = offset as usize;
        if offset < previous || offset > entry_count {
            return Err(format!("invalid Gaussian tile bin offset at tile {tile}"));
        }
        previous = offset;
    }
    if previous != entry_count {
        return Err("Gaussian tile bin sentinel must equal the entry count".into());
    }
    let entries = &tile_bins[offset_count..];
    let mut seen_in_tile = vec![0_u32; depths.len()];
    for tile in 0..tile_count {
        let marker = tile as u32 + 1;
        let start = offsets[tile] as usize;
        let end = offsets[tile + 1] as usize;
        for (entry, &id) in entries[start..end].iter().enumerate() {
            let id = id as usize;
            if id >= depths.len() {
                return Err(format!(
                    "Gaussian tile bin index out of range at tile {tile} entry {entry}"
                ));
            }
            if seen_in_tile[id] == marker {
                return Err(format!(
                    "duplicate Gaussian tile bin index at tile {tile} entry {entry}"
                ));
            }
            seen_in_tile[id] = marker;
        }
    }
    Ok(offset_count)
}

fn stable_descending_depth_order(depths: &[f32], order: &mut [u32], scratch: &mut [u32]) {
    if order.len() < 2 {
        return;
    }
    debug_assert!(scratch.len() >= order.len());
    for shift in [0, 8, 16, 24] {
        let mut offsets = [0_usize; 256];
        for &id in order.iter() {
            offsets[((descending_depth_key(depths[id as usize]) >> shift) & 255) as usize] += 1;
        }
        let mut prefix = 0;
        for count in &mut offsets {
            let length = *count;
            *count = prefix;
            prefix += length;
        }
        for &id in order.iter() {
            let digit = ((descending_depth_key(depths[id as usize]) >> shift) & 255) as usize;
            scratch[offsets[digit]] = id;
            offsets[digit] += 1;
        }
        order.copy_from_slice(&scratch[..order.len()]);
    }
}

/// Sort every tile's unique Gaussian IDs by decreasing finite f32 depth.
///
/// `tile_bins` uses the offsets-and-entries layout returned by
/// [`gaussian_tile_bins`]. IDs may repeat in different tiles, but not in the
/// same tile. Offsets are preserved and equal depths retain their input order
/// within that tile.
#[wasm_bindgen]
pub fn gaussian_tile_depth_order(
    depths: &[f32],
    tile_bins: &[u32],
    tile_count: u32,
) -> Result<Vec<u32>, String> {
    let offset_count = validate_tile_bin_ranges(depths, tile_bins, tile_count)?;
    let offsets = &tile_bins[..offset_count];
    let largest_tile = offsets
        .windows(2)
        .map(|window| (window[1] - window[0]) as usize)
        .max()
        .unwrap_or(0);
    let mut result = tile_bins.to_vec();
    let entries = &mut result[offset_count..];
    let mut scratch = vec![0_u32; largest_tile];
    for tile in 0..tile_count as usize {
        let start = offsets[tile] as usize;
        let end = offsets[tile + 1] as usize;
        stable_descending_depth_order(depths, &mut entries[start..end], &mut scratch);
    }
    Ok(result)
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
    if !valid_depth_clip_range(near, far) {
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

fn valid_depth_clip_range(near: f32, far: f32) -> bool {
    near.is_finite() && near > 0. && !far.is_nan() && far >= near
}

fn depth_support_radius(variance_z: f32, opacity: f32, cutoff: f32) -> f64 {
    if opacity == cutoff {
        return 0.;
    }
    // Each step expands the f64 approximation so culling cannot shrink support
    // merely because of the logarithm, product, square root or endpoint sum.
    let ratio = (f64::from(opacity) / f64::from(cutoff)).next_up();
    let radius_squared = (2. * ratio.ln()).next_up();
    (f64::from(variance_z).next_up() * radius_squared)
        .next_up()
        .sqrt()
        .next_up()
}

/// Keep candidates whose alpha support intersects the camera depth interval.
///
/// The support is derived from `alpha = opacity * exp(-0.5 * d^T Sigma^-1 d)`
/// at `cutoff`. Its maximum camera-z displacement is
/// `sqrt(2 * Sigma_zz * ln(opacity / cutoff))`. This retains a positive-depth
/// center when its support reaches the near or far plane; it does not clip the
/// Gaussian geometry or make the perspective projection exact near the camera.
#[wasm_bindgen]
pub fn gaussian_clip_depth_support_indices(
    centers: &[f32],
    covariances: &[f32],
    opacities: &[f32],
    indices: &[u32],
    cutoff: f32,
    near: f32,
    far: f32,
) -> Result<Vec<u32>, String> {
    if !centers.len().is_multiple_of(3)
        || covariances.len() != centers.len() / 3 * 6
        || opacities.len() != centers.len() / 3
        || opacities.len() > MAX_SPLATS
        || indices.len() > opacities.len()
    {
        return Err("expected xyz centers, six covariance values and one opacity per splat, at most 1000000 splats and no more candidates than splats".into());
    }
    if !cutoff.is_finite() || cutoff <= 0. || cutoff > 1. {
        return Err("Gaussian cutoff must be finite and in (0, 1]".into());
    }
    if !valid_depth_clip_range(near, far) {
        return Err("expected finite near > 0 and far >= near for Gaussian depth clipping".into());
    }
    for (index, ((center, covariance), &opacity)) in centers
        .as_chunks::<3>()
        .0
        .iter()
        .zip(covariances.as_chunks::<6>().0)
        .zip(opacities)
        .enumerate()
    {
        if !center.iter().all(|value| value.is_finite())
            || center[2] <= 0.
            || !valid_camera_covariance(covariance)
            || !opacity.is_finite()
            || !(0. ..=1.).contains(&opacity)
        {
            return Err(format!(
                "invalid Gaussian center, depth, covariance or opacity at splat {index}"
            ));
        }
    }
    validate_candidate_indices(opacities.len(), indices)?;
    let near = f64::from(near);
    let far = f64::from(far);
    Ok(indices
        .iter()
        .copied()
        .filter(|&id| {
            let index = id as usize;
            let opacity = opacities[index];
            if opacity < cutoff {
                return false;
            }
            let depth = f64::from(centers[index * 3 + 2]);
            let radius = depth_support_radius(covariances[index * 6 + 5], opacity, cutoff);
            let lower = add_outward(depth, -radius, false);
            let upper = add_outward(depth, radius, true);
            lower <= far && upper >= near
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
    fn screen_filter_expands_covariance_and_preserves_continuous_energy() {
        let covariance = [4., 1., 9.];
        let opacity = [0.5];
        assert_eq!(
            gaussian_filter_screen_covariances(&covariance, &opacity, 0.).unwrap(),
            [4., 1., 9., 0.5]
        );
        let filtered = gaussian_filter_screen_covariances(&covariance, &opacity, 1.).unwrap();
        assert_eq!(&filtered[..3], &[5., 1., 10.]);
        let original_area = (4_f64 * 9. - 1.).sqrt();
        let filtered_area = (5_f64 * 10. - 1.).sqrt();
        assert!(filtered[3] < opacity[0]);
        assert!(
            (f64::from(filtered[3]) * filtered_area - f64::from(opacity[0]) * original_area).abs()
                < 1e-6
        );
    }

    #[test]
    fn screen_filter_validates_complete_batches_and_output_range() {
        let covariance = [1., 0., 1., 1., 0., 1.];
        let opacity = [1., 0.5];
        for variance in [-1., f32::NAN, f32::INFINITY] {
            assert!(gaussian_filter_screen_covariances(&covariance, &opacity, variance).is_err());
        }
        assert!(
            gaussian_filter_screen_covariances(&[1., 0., 1., 1., 2., 1.], &opacity, 1.).is_err()
        );
        assert!(gaussian_filter_screen_covariances(&covariance, &[1., f32::NAN], 1.).is_err());
        assert!(
            gaussian_filter_screen_covariances(&[f32::MAX, 0., f32::MAX], &[1.], f32::MAX).is_err()
        );
        assert_eq!(
            gaussian_filter_screen_covariances(&[], &[], 1.).unwrap(),
            []
        );
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
    fn tile_bins_keep_candidate_order_and_conservative_edges() {
        let centers = [
            8., 8., // touches four tiles at (16, 16)
            20., 6., // tile 1
            -1., 8., // reaches the left edge of tile 0
            40., 2., // entirely outside the 35px viewport
        ];
        let extents = [8., 8., 2., 2., 2., 1., 2., 2.];
        let result = gaussian_tile_bins(&centers, &extents, &[2, 0, 3, 1], 35, 18, 16).unwrap();
        // Six tiles: offsets [0, 2, 4, 4, 5, 6, 6], then row-major IDs.
        assert_eq!(result, [0, 2, 4, 4, 5, 6, 6, 2, 0, 0, 1, 0, 0]);
        assert_eq!(
            gaussian_tile_bins(&[8., 8.], &[0., 1.], &[0], 16, 16, 16).unwrap(),
            [0, 0]
        );
    }

    #[test]
    fn tile_bins_validate_dimensions_batches_and_reference_budget() {
        for dimensions in [(0, 1, 1), (1, 0, 1), (1, 1, 0), (1001, 1000, 1)] {
            assert!(
                gaussian_tile_bins(&[], &[], &[], dimensions.0, dimensions.1, dimensions.2)
                    .is_err()
            );
        }
        assert!(gaussian_tile_bins(&[0., 0., f32::NAN, 0.], &[1.; 4], &[0], 1, 1, 1).is_err());
        assert!(gaussian_tile_bins(&[0., 0.], &[1., -1.], &[0], 1, 1, 1).is_err());
        assert!(gaussian_tile_bins(&[0., 0.], &[1., 1.], &[0, 0], 1, 1, 1).is_err());
        assert!(gaussian_tile_bins(&[0., 0.], &[1., 1.], &[1], 1, 1, 1).is_err());

        let centers = vec![500.; 10];
        let extents = vec![500.; 10];
        assert!(
            gaussian_tile_bins(&centers, &extents, &[0, 1, 2, 3, 4], 1000, 1000, 1)
                .unwrap_err()
                .contains("4000000")
        );
    }

    #[test]
    fn tile_depth_order_sorts_each_tile_stably_and_reuses_ids_across_tiles() {
        let depths = [2., 5., 5., 9.];
        // Three tiles: [0, 2, 1], [3, 0], then an empty tile.
        let bins = [0, 3, 5, 5, 0, 2, 1, 3, 0];
        assert_eq!(
            gaussian_tile_depth_order(&depths, &bins, 3).unwrap(),
            [0, 3, 5, 5, 2, 1, 0, 3, 0]
        );
        assert_eq!(
            gaussian_tile_depth_order(&[1., 2.], &[0, 1, 2, 0, 0], 2).unwrap(),
            [0, 1, 2, 0, 0]
        );
    }

    #[test]
    fn tile_depth_order_rejects_malformed_offsets_and_tile_entries() {
        assert!(gaussian_tile_depth_order(&[1.], &[0], 0).is_err());
        assert!(gaussian_tile_depth_order(&[1.], &[1, 1], 1).is_err());
        assert!(gaussian_tile_depth_order(&[1.], &[0, 2], 1).is_err());
        assert!(gaussian_tile_depth_order(&[1.], &[0, 1, 0], 2).is_err());
        assert!(gaussian_tile_depth_order(&[1.], &[0, 1, 2], 1).is_err());
        assert!(gaussian_tile_depth_order(&[1., 2.], &[0, 2, 0, 0], 1).is_err());
        assert!(gaussian_tile_depth_order(&[f32::NAN], &[0, 0], 1).is_err());
        assert!(gaussian_tile_depth_order(&[], &[0], 1_000_001).is_err());
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
    fn depth_support_clipping_keeps_crossing_bounds_in_candidate_order() {
        let cutoff = 1. / 255.;
        let centers = [
            0., 0., 0.8, // reaches the near plane through z support
            0., 0., 4.4, // reaches the far plane through z support
            0., 0., 1., // exact near boundary, zero support at cutoff
            0., 0., 0.9, // zero support stays before the near plane
            0., 0., 2., // opacity below cutoff has no retained support
        ];
        let covariances = [
            0.01, 0., 0., 0.01, 0., 0.04, 0.01, 0., 0., 0.01, 0., 0.09, 0.01, 0., 0., 0.01, 0.,
            0.04, 0.01, 0., 0., 0.01, 0., 0.04, 0.01, 0., 0., 0.01, 0., 0.04,
        ];
        let opacities = [1., 1., cutoff, cutoff, cutoff * 0.5];
        let candidates = [4, 1, 3, 0, 2];
        assert_eq!(
            gaussian_clip_depth_support_indices(
                &centers,
                &covariances,
                &opacities,
                &candidates,
                cutoff,
                1.,
                4.,
            )
            .unwrap(),
            [1, 0, 2]
        );
        assert_eq!(
            gaussian_clip_depth_indices(&[0.8, 4.4, 1., 0.9, 2.], &[1, 3, 0, 2], 1., 4.).unwrap(),
            [2]
        );
        assert_eq!(
            gaussian_clip_depth_support_indices(&[], &[], &[], &[], cutoff, 1., 4.).unwrap(),
            []
        );
    }

    #[test]
    fn depth_support_clipping_validates_complete_batches() {
        let centers = [0., 0., 2., 0., 0., 2.];
        let covariances = [1., 0., 0., 1., 0., 1., 1., 0., 0., 1., 0., 1.];
        let opacities = [1., 1.];
        for cutoff in [0., -1., 2., f32::NAN, f32::INFINITY] {
            assert!(gaussian_clip_depth_support_indices(
                &centers,
                &covariances,
                &opacities,
                &[],
                cutoff,
                1.,
                4.
            )
            .is_err());
        }
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &[1., 0., 0., 1., 0., 1., 1., 0., 0., 1., 0., 0.],
            &opacities,
            &[0],
            0.01,
            1.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &[0., 0., 2., 0., 0., 0.],
            &covariances,
            &opacities,
            &[0],
            0.01,
            1.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &covariances,
            &[1., f32::NAN],
            &[0],
            0.01,
            1.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &covariances,
            &opacities,
            &[0, 0],
            0.01,
            1.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &covariances,
            &opacities,
            &[2],
            0.01,
            1.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &covariances,
            &opacities,
            &[],
            0.01,
            0.,
            4.
        )
        .is_err());
        assert!(gaussian_clip_depth_support_indices(
            &centers,
            &covariances,
            &opacities,
            &[],
            0.01,
            1.,
            f32::NAN
        )
        .is_err());
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
