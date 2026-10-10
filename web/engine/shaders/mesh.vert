precision highp float;
in vec3 position;
uniform mat4 modelMatrix;
uniform mat4 viewProjection;
out vec3 worldPosition;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  worldPosition = world.xyz;
  gl_Position = viewProjection * world;
}
