precision highp float;
in vec3 worldPosition;
in vec3 color;
out vec4 outColor;
void main() {
  vec3 normal = normalize(cross(dFdx(worldPosition), dFdy(worldPosition)));
  float light = 0.52 + 0.48 * abs(dot(normal, normalize(vec3(0.4, 0.8, 0.6))));
  outColor = vec4(color * light, 1.0);
}
