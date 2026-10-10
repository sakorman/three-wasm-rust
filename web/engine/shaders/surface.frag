precision highp float;
in vec3 worldPosition;
uniform vec3 baseColor;
uniform float unlit;
out vec4 outColor;
void main() {
  vec3 normal = normalize(cross(dFdx(worldPosition), dFdy(worldPosition)));
  float light = 0.42 + 0.58 * abs(dot(normal, normalize(vec3(0.4, 0.8, 0.6))));
  outColor = vec4(baseColor * mix(light, 1.0, unlit), 1.0);
}
