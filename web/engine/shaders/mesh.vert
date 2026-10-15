precision highp float;
layout(location = 0) in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 viewProjection;
out vec3 surfacePosition;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  // Translation does not affect the surface normal and can erase small differences.
  surfacePosition = mat3(modelMatrix) * position;
  gl_Position = viewProjection * world;
}
