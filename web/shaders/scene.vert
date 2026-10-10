precision highp float;
layout(location = 0) in vec3 position;
layout(location = 1) in mat4 instanceMatrix;
layout(location = 5) in vec3 instanceColor;
uniform mat4 viewProjection;
out vec3 worldPosition;
out vec3 color;
void main() {
  vec4 world = instanceMatrix * vec4(position, 1.0);
  worldPosition = world.xyz;
  color = instanceColor;
  gl_Position = viewProjection * world;
}
