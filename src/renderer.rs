//! Minimal instanced renderer. Owns GL objects and releases them in Drop / JS free().
use crate::SceneGraph;
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{
    HtmlCanvasElement, WebGl2RenderingContext as Gl, WebGlBuffer, WebGlProgram, WebGlShader,
    WebGlUniformLocation, WebGlVertexArrayObject,
};

#[wasm_bindgen]
pub struct RustRenderer {
    gl: Gl,
    program: WebGlProgram,
    vao: WebGlVertexArrayObject,
    buffers: Vec<WebGlBuffer>,
    matrix_buffer: WebGlBuffer,
    vp: WebGlUniformLocation,
    index_count: i32,
    instance_count: usize,
}

pub(super) fn shader(gl: &Gl, kind: u32, source: &str) -> Result<WebGlShader, JsValue> {
    let value = gl
        .create_shader(kind)
        .ok_or_else(|| JsValue::from_str("cannot allocate shader"))?;
    gl.shader_source(&value, &format!("#version 300 es\n{source}"));
    gl.compile_shader(&value);
    if !gl
        .get_shader_parameter(&value, Gl::COMPILE_STATUS)
        .as_bool()
        .unwrap_or(false)
    {
        let message = gl
            .get_shader_info_log(&value)
            .unwrap_or_else(|| "shader compile failed".into());
        gl.delete_shader(Some(&value));
        return Err(message.into());
    }
    Ok(value)
}

pub(super) fn buffer_storage_matches(gl: &Gl, target: u32, bytes: usize) -> bool {
    !gl.is_context_lost()
        && gl.get_buffer_parameter(target, Gl::BUFFER_SIZE).as_f64() == Some(bytes as f64)
}

#[wasm_bindgen]
impl RustRenderer {
    /// All instances share one indexed geometry; each has its own RGB color.
    #[wasm_bindgen(constructor)]
    pub fn new(
        canvas: HtmlCanvasElement,
        positions: &[f32],
        indices: &[u32],
        colors: &[f32],
    ) -> Result<RustRenderer, JsValue> {
        if positions.is_empty()
            || !positions.len().is_multiple_of(3)
            || indices.is_empty()
            || !indices.len().is_multiple_of(3)
            || !colors.len().is_multiple_of(3)
            || colors.len() / 3 > crate::MAX_NODES
            || indices.len() > i32::MAX as usize
            || indices
                .iter()
                .any(|&index| index as usize >= positions.len() / 3)
            || positions.iter().any(|v| !v.is_finite())
            || colors
                .iter()
                .any(|v| !v.is_finite() || !(0.0..=1.0).contains(v))
        {
            return Err("invalid indexed triangle geometry or colors".into());
        }
        let gl: Gl = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("WebGL2 is unavailable"))?
            .dyn_into()?;
        let vertex = shader(
            &gl,
            Gl::VERTEX_SHADER,
            include_str!("../web/shaders/scene.vert"),
        )?;
        let fragment = match shader(
            &gl,
            Gl::FRAGMENT_SHADER,
            include_str!("../web/shaders/scene.frag"),
        ) {
            Ok(value) => value,
            Err(error) => {
                gl.delete_shader(Some(&vertex));
                return Err(error);
            }
        };
        let Some(program) = gl.create_program() else {
            gl.delete_shader(Some(&vertex));
            gl.delete_shader(Some(&fragment));
            return Err("cannot allocate program".into());
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
            let message = gl.get_program_info_log(&program).unwrap_or_default();
            gl.delete_program(Some(&program));
            return Err(message.into());
        }
        let Some(vp) = gl.get_uniform_location(&program, "viewProjection") else {
            gl.delete_program(Some(&program));
            return Err("missing viewProjection uniform".into());
        };
        let Some(vao) = gl.create_vertex_array() else {
            gl.delete_program(Some(&program));
            return Err("cannot allocate vertex array".into());
        };
        let mut buffers = Vec::new();
        for _ in 0..4 {
            match gl.create_buffer() {
                Some(buffer) => buffers.push(buffer),
                None => {
                    for buffer in &buffers {
                        gl.delete_buffer(Some(buffer));
                    }
                    gl.delete_vertex_array(Some(&vao));
                    gl.delete_program(Some(&program));
                    return Err("cannot allocate GPU buffer".into());
                }
            }
        }
        // Own every handle before uploads so storage failures run the normal cleanup path.
        let renderer = Self {
            gl: gl.clone(),
            program,
            vao,
            matrix_buffer: buffers[2].clone(),
            buffers,
            vp,
            index_count: indices.len() as i32,
            instance_count: colors.len() / 3,
        };
        gl.bind_vertex_array(Some(&renderer.vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&renderer.buffers[0]));
        gl.buffer_data_with_u8_array(
            Gl::ARRAY_BUFFER,
            bytemuck::cast_slice(positions),
            Gl::STATIC_DRAW,
        );
        if !buffer_storage_matches(&gl, Gl::ARRAY_BUFFER, std::mem::size_of_val(positions)) {
            gl.bind_vertex_array(None);
            return Err("vertex buffer allocation failed".into());
        }
        gl.enable_vertex_attrib_array(0);
        gl.vertex_attrib_pointer_with_i32(0, 3, Gl::FLOAT, false, 0, 0);
        gl.bind_buffer(Gl::ELEMENT_ARRAY_BUFFER, Some(&renderer.buffers[1]));
        gl.buffer_data_with_u8_array(
            Gl::ELEMENT_ARRAY_BUFFER,
            bytemuck::cast_slice(indices),
            Gl::STATIC_DRAW,
        );
        if !buffer_storage_matches(
            &gl,
            Gl::ELEMENT_ARRAY_BUFFER,
            std::mem::size_of_val(indices),
        ) {
            gl.bind_vertex_array(None);
            return Err("index buffer allocation failed".into());
        }
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&renderer.buffers[2]));
        gl.buffer_data_with_i32(
            Gl::ARRAY_BUFFER,
            (colors.len() / 3 * 64) as i32,
            Gl::DYNAMIC_DRAW,
        );
        if !buffer_storage_matches(&gl, Gl::ARRAY_BUFFER, colors.len() / 3 * 64) {
            gl.bind_vertex_array(None);
            return Err("instance matrix buffer allocation failed".into());
        }
        for column in 0..4 {
            gl.enable_vertex_attrib_array(column + 1);
            gl.vertex_attrib_pointer_with_i32(
                column + 1,
                4,
                Gl::FLOAT,
                false,
                64,
                (column * 16) as i32,
            );
            gl.vertex_attrib_divisor(column + 1, 1);
        }
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&renderer.buffers[3]));
        gl.buffer_data_with_u8_array(
            Gl::ARRAY_BUFFER,
            bytemuck::cast_slice(colors),
            Gl::STATIC_DRAW,
        );
        if !buffer_storage_matches(&gl, Gl::ARRAY_BUFFER, std::mem::size_of_val(colors)) {
            gl.bind_vertex_array(None);
            return Err("color buffer allocation failed".into());
        }
        gl.enable_vertex_attrib_array(5);
        gl.vertex_attrib_pointer_with_i32(5, 3, Gl::FLOAT, false, 0, 0);
        gl.vertex_attrib_divisor(5, 1);
        gl.bind_vertex_array(None);
        Ok(renderer)
    }

    /// Updates GPU matrices and submits one draw; does not update the scene graph.
    pub fn render(&self, scene: &SceneGraph, view_projection: &[f32]) -> Result<(), JsValue> {
        scene.ensure_ready().map_err(JsValue::from)?;
        if scene.node_count() != self.instance_count {
            return Err(format!(
                "scene has {} nodes, renderer expects {} instances",
                scene.node_count(),
                self.instance_count
            )
            .into());
        }
        if view_projection.len() != 16 || view_projection.iter().any(|v| !v.is_finite()) {
            return Err("view-projection matrix must contain 16 finite floats".into());
        }
        let gl = &self.gl;
        if gl.is_context_lost() {
            return Err("WebGL context lost; reload to recreate renderer".into());
        }
        gl.viewport(0, 0, gl.drawing_buffer_width(), gl.drawing_buffer_height());
        gl.clear_color(0.035, 0.055, 0.075, 1.);
        gl.clear(Gl::COLOR_BUFFER_BIT | Gl::DEPTH_BUFFER_BIT);
        gl.enable(Gl::DEPTH_TEST);
        gl.enable(Gl::CULL_FACE);
        gl.use_program(Some(&self.program));
        gl.bind_vertex_array(Some(&self.vao));
        gl.bind_buffer(Gl::ARRAY_BUFFER, Some(&self.matrix_buffer));
        gl.buffer_sub_data_with_i32_and_u8_array(
            Gl::ARRAY_BUFFER,
            0,
            bytemuck::cast_slice(&scene.worlds),
        );
        gl.uniform_matrix4fv_with_f32_array(Some(&self.vp), false, view_projection);
        gl.draw_elements_instanced_with_i32(
            Gl::TRIANGLES,
            self.index_count,
            Gl::UNSIGNED_INT,
            0,
            self.instance_count as i32,
        );
        gl.bind_vertex_array(None);
        Ok(())
    }
}

impl Drop for RustRenderer {
    fn drop(&mut self) {
        for buffer in &self.buffers {
            self.gl.delete_buffer(Some(buffer));
        }
        self.gl.delete_vertex_array(Some(&self.vao));
        self.gl.delete_program(Some(&self.program));
    }
}
