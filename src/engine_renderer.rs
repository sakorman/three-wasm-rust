//! Resource registries and batched WebGL2 submission. The queue owns CPU culling.
use crate::{queue::RenderQueue, renderer::shader, SceneGraph, MAX_NODES};
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram,
    WebGlUniformLocation, WebGlVertexArrayObject,
};

struct Geometry {
    gl: Gl,
    vao: WebGlVertexArrayObject,
    vertex: WebGlBuffer,
    index: WebGlBuffer,
    count: i32,
}
impl Drop for Geometry {
    fn drop(&mut self) {
        self.gl.delete_vertex_array(Some(&self.vao));
        self.gl.delete_buffer(Some(&self.vertex));
        self.gl.delete_buffer(Some(&self.index));
    }
}
struct Material {
    color: [f32; 3],
    unlit: bool,
}

#[wasm_bindgen]
pub struct EngineRenderer {
    gl: Gl,
    program: WebGlProgram,
    instances: Option<WebGlBuffer>,
    model: Option<WebGlUniformLocation>,
    vp: WebGlUniformLocation,
    color: WebGlUniformLocation,
    unlit: WebGlUniformLocation,
    geometries: Vec<Geometry>,
    materials: Vec<Material>,
    batches: Vec<(usize, usize)>,
    capacity: usize,
    draws: usize,
    triangles: usize,
}

#[wasm_bindgen]
impl EngineRenderer {
    #[wasm_bindgen(constructor)]
    pub fn new(
        canvas: HtmlCanvasElement,
        capacity: usize,
        instanced: Option<bool>,
    ) -> Result<Self, JsValue> {
        let instanced = instanced.unwrap_or(true);
        if capacity > MAX_NODES {
            return Err("instance capacity exceeds limit".into());
        }
        let gl: Gl = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("WebGL2 unavailable"))?
            .dyn_into()?;
        let vertex = shader(
            &gl,
            Gl::VERTEX_SHADER,
            if instanced {
                include_str!("../web/engine/shaders/instanced.vert")
            } else {
                include_str!("../web/engine/shaders/mesh.vert")
            },
        )?;
        let fragment = match shader(
            &gl,
            Gl::FRAGMENT_SHADER,
            include_str!("../web/engine/shaders/surface.frag"),
        ) {
            Ok(s) => s,
            Err(e) => {
                gl.delete_shader(Some(&vertex));
                return Err(e);
            }
        };
        let Some(program) = gl.create_program() else {
            gl.delete_shader(Some(&vertex));
            gl.delete_shader(Some(&fragment));
            return Err("program allocation failed".into());
        };
        gl.attach_shader(&program, &vertex);
        gl.attach_shader(&program, &fragment);
        gl.link_program(&program);
        gl.delete_shader(Some(&vertex));
        gl.delete_shader(Some(&fragment));
        if !gl
            .get_program_parameter(&program, Gl::LINK_STATUS)
            .as_bool()
            .unwrap_or(false)
        {
            let error = gl.get_program_info_log(&program).unwrap_or_default();
            gl.delete_program(Some(&program));
            return Err(error.into());
        }
        let locations = (
            gl.get_uniform_location(&program, "viewProjection"),
            gl.get_uniform_location(&program, "baseColor"),
            gl.get_uniform_location(&program, "unlit"),
        );
        let (Some(vp), Some(color), Some(unlit)) = locations else {
            gl.delete_program(Some(&program));
            return Err("missing shader uniforms".into());
        };
        let model = gl.get_uniform_location(&program, "modelMatrix");
        if !instanced && model.is_none() {
            gl.delete_program(Some(&program));
            return Err("missing modelMatrix".into());
        }
        let instances = if instanced {
            let Some(buffer) = gl.create_buffer() else {
                gl.delete_program(Some(&program));
                return Err("buffer allocation failed".into());
            };
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&buffer));
            gl.buffer_data_with_i32(Gl::ARRAY_BUFFER, (capacity * 64) as i32, Gl::DYNAMIC_DRAW);
            Some(buffer)
        } else {
            None
        };
        Ok(Self {
            gl,
            program,
            instances,
            model,
            vp,
            color,
            unlit,
            geometries: vec![],
            materials: vec![],
            batches: vec![],
            capacity,
            draws: 0,
            triangles: 0,
        })
    }

    pub fn add_geometry(&mut self, positions: &[f32], indices: &[u32]) -> Result<usize, JsValue> {
        if positions.is_empty()
            || !positions.len().is_multiple_of(3)
            || !indices.len().is_multiple_of(3)
            || indices.is_empty()
            || indices.len() > i32::MAX as usize
            || positions.iter().any(|x| !x.is_finite())
            || indices.iter().any(|&i| i as usize >= positions.len() / 3)
        {
            return Err("invalid geometry".into());
        }
        let gl = &self.gl;
        let Some(vao) = gl.create_vertex_array() else {
            return Err("VAO allocation failed".into());
        };
        let Some(vertex) = gl.create_buffer() else {
            gl.delete_vertex_array(Some(&vao));
            return Err("vertex allocation failed".into());
        };
        let Some(index) = gl.create_buffer() else {
            gl.delete_vertex_array(Some(&vao));
            gl.delete_buffer(Some(&vertex));
            return Err("index allocation failed".into());
        };
        gl.bind_vertex_array(Some(&vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&vertex));
        gl.buffer_data_with_u8_array(
            Gl::ARRAY_BUFFER,
            bytemuck::cast_slice(positions),
            Gl::STATIC_DRAW,
        );
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_with_i32(0, 3, Gl::FLOAT, false, 0, 0);
        gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, Some(&index));
        gl.buffer_data_with_u8_array(
            Gl::ELEMENT_ARRAY_BUFFER,
            bytemuck::cast_slice(indices),
            Gl::STATIC_DRAW,
        );
        if let Some(instances) = &self.instances {
            gl.bind_buffer(Gl::ARRAY_BUFFER, Some(instances));
            for col in 0..4 {
                gl.enable_vertex_attrib_array(col + 1);
                gl.vertex_attrib_pointer_with_i32(
                    col + 1,
                    4,
                    Gl::FLOAT,
                    false,
                    64,
                    (col * 16) as i32,
                );
                gl.vertex_attrib_divisor(col + 1, 1);
            }
        }
        gl.bind_vertex_array(None);
        self.geometries.push(Geometry {
            gl: gl.clone(),
            vao,
            vertex,
            index,
            count: indices.len() as i32,
        });
        Ok(self.geometries.len() - 1)
    }

    pub fn add_material(&mut self, color: &[f32], unlit: bool) -> Result<usize, JsValue> {
        if color.len() != 3
            || color
                .iter()
                .any(|c| !c.is_finite() || !(0.0..=1.0).contains(c))
        {
            return Err("invalid material color".into());
        }
        self.materials.push(Material {
            color: color.try_into().unwrap(),
            unlit,
        });
        Ok(self.materials.len() - 1)
    }

    pub fn set_batches(&mut self, geometries: &[u32], materials: &[u32]) -> Result<(), JsValue> {
        if geometries.len() != materials.len()
            || geometries.len() > 4096
            || geometries
                .iter()
                .any(|&i| i as usize >= self.geometries.len())
            || materials
                .iter()
                .any(|&i| i as usize >= self.materials.len())
        {
            return Err("invalid batch resources".into());
        }
        self.batches = geometries
            .iter()
            .zip(materials)
            .map(|(&g, &m)| (g as usize, m as usize))
            .collect();
        Ok(())
    }

    pub fn render(&mut self, queue: &RenderQueue, view_projection: &[f32]) -> Result<(), JsValue> {
        if self.instances.is_none() || !queue.packed {
            return Err(
                "instanced rendering requires an instanced renderer and packed queue".into(),
            );
        }
        self.validate(queue, view_projection)?;
        self.begin_frame(view_projection)?;
        let gl = &self.gl;
        gl.bind_buffer(Gl::ARRAY_BUFFER, self.instances.as_ref());
        gl.buffer_sub_data_with_i32_and_u8_array(
            Gl::ARRAY_BUFFER,
            0,
            bytemuck::cast_slice(&queue.matrices[..queue.matrices_len()]),
        );
        for (group, &(start, count)) in queue.ranges.iter().enumerate() {
            if count == 0 {
                continue;
            }
            let (g, m) = self.batches[group / 2];
            let geometry = &self.geometries[g];
            let material = &self.materials[m];
            gl.front_face(if group % 2 == 0 { Gl::CCW } else { Gl::CW });
            gl.bind_vertex_array(Some(&geometry.vao));
            for col in 0..4 {
                gl.vertex_attrib_pointer_with_i32(
                    col + 1,
                    4,
                    Gl::FLOAT,
                    false,
                    64,
                    (start * 64 + col as usize * 16) as i32,
                );
            }
            gl.uniform3fv_with_f32_array(Some(&self.color), &material.color);
            gl.uniform1f(Some(&self.unlit), if material.unlit { 1. } else { 0. });
            gl.draw_elements_instanced_with_i32(
                Gl::TRIANGLES,
                geometry.count,
                Gl::UNSIGNED_INT,
                0,
                count as i32,
            );
            self.draws += 1;
            self.triangles += geometry.count as usize / 3 * count;
        }
        gl.bind_vertex_array(None);
        Ok(())
    }

    /// A real non-instanced drawElements call per visible mesh, in scene descriptor order.
    pub fn render_direct(
        &mut self,
        queue: &RenderQueue,
        scene: &SceneGraph,
        view_projection: &[f32],
    ) -> Result<(), JsValue> {
        if self.instances.is_some()
            || queue.packed
            || self.model.is_none()
            || queue
                .nodes
                .iter()
                .any(|&id| id as usize >= scene.node_count())
        {
            return Err(
                "direct rendering requires a direct renderer, unpacked queue and valid scene"
                    .into(),
            );
        }
        self.validate(queue, view_projection)?;
        self.begin_frame(view_projection)?;
        let gl = &self.gl;
        let mut last_geometry = None;
        let mut last_material = None;
        let mut last_mirrored = None;
        for &item in &queue.visible_items {
            let (g, m) = self.batches[queue.groups[item] as usize];
            let geometry = &self.geometries[g];
            if last_geometry != Some(g) {
                gl.bind_vertex_array(Some(&geometry.vao));
                last_geometry = Some(g);
            }
            if last_material != Some(m) {
                let material = &self.materials[m];
                gl.uniform3fv_with_f32_array(Some(&self.color), &material.color);
                gl.uniform1f(Some(&self.unlit), if material.unlit { 1. } else { 0. });
                last_material = Some(m);
            }
            let offset = queue.nodes[item] as usize * 16;
            let mirrored = queue.mirrored[item];
            if last_mirrored != Some(mirrored) {
                gl.front_face(if mirrored { Gl::CW } else { Gl::CCW });
                last_mirrored = Some(mirrored);
            }
            gl.uniform_matrix4fv_with_f32_array(
                self.model.as_ref(),
                false,
                &scene.worlds[offset..offset + 16],
            );
            gl.draw_elements_with_i32(Gl::TRIANGLES, geometry.count, Gl::UNSIGNED_INT, 0);
            self.draws += 1;
            self.triangles += geometry.count as usize / 3;
        }
        gl.bind_vertex_array(None);
        Ok(())
    }

    fn validate(&self, queue: &RenderQueue, view_projection: &[f32]) -> Result<(), JsValue> {
        if !queue.prepared
            || queue.matrix_capacity() > self.capacity
            || queue.ranges.len() != self.batches.len() * 2
            || view_projection.len() != 16
            || view_projection.iter().any(|x| !x.is_finite())
        {
            return Err("invalid queue or camera".into());
        }
        Ok(())
    }

    fn begin_frame(&mut self, view_projection: &[f32]) -> Result<(), JsValue> {
        let gl = &self.gl;
        if gl.is_context_lost() {
            return Err("WebGL context lost".into());
        }
        self.draws = 0;
        self.triangles = 0;
        gl.viewport(0, 0, gl.drawing_buffer_width(), gl.drawing_buffer_height());
        gl.clear_color(0.035, 0.055, 0.075, 1.);
        gl.clear(Gl::COLOR_BUFFER_BIT | Gl::DEPTH_BUFFER_BIT);
        gl.enable(Gl::DEPTH_TEST);
        gl.enable(Gl::CULL_FACE);
        gl.disable(Gl::BLEND);
        gl.use_program(Some(&self.program));
        gl.uniform_matrix4fv_with_f32_array(Some(&self.vp), false, view_projection);
        Ok(())
    }
    pub fn draw_calls(&self) -> usize {
        self.draws
    }
    pub fn triangles(&self) -> usize {
        self.triangles
    }
}
impl Drop for EngineRenderer {
    fn drop(&mut self) {
        self.gl.delete_buffer(self.instances.as_ref());
        self.gl.delete_program(Some(&self.program));
    }
}
