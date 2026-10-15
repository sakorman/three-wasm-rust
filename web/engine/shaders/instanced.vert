precision highp float;
layout(location = 0) in vec3 position;
layout(location = 1) in mat4 instanceMatrix;
uniform mat4 viewProjection;
out vec3 surfacePosition;
void main() {
  vec4 world = instanceMatrix * vec4(position, 1.0);
  // Keep surface derivatives independent of the instance's world translation.
  surfacePosition = mat3(instanceMatrix) * position;
  gl_Position = viewProjection * world;
}
