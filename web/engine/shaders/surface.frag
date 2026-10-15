precision highp float;
in vec3 surfacePosition;
uniform vec3 baseColor;
uniform float unlit;
out vec4 outColor;

vec3 scaleDerivative(vec3 value) {
  float largest = max(max(abs(value.x), abs(value.y)), abs(value.z));
  return largest > 0.0 ? value / largest : vec3(0.0);
}

void main() {
  if (unlit > 0.5) {
    outColor = vec4(baseColor, 1.0);
    return;
  }
  vec3 normal = cross(scaleDerivative(dFdx(surfacePosition)), scaleDerivative(dFdy(surfacePosition)));
  float squaredLength = dot(normal, normal);
  float light = 0.42;
  if (squaredLength > 0.0) {
    normal *= inversesqrt(squaredLength);
    light += 0.58 * abs(dot(normal, normalize(vec3(0.4, 0.8, 0.6))));
  }
  outColor = vec4(baseColor * light, 1.0);
}
