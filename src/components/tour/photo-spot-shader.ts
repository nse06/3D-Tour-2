import * as THREE from "three";

/**
 * How the remastered model shows its photo spots (PhotoSpots.tsx): a spot's cube of photos is
 * projected onto the model from the spot. The photos sit on the model's shapes, which are only so
 * right (a painting leaning out from its wall, clutter the scan caught in pieces): seen from
 * elsewhere, whatever a shape has wrong shows displaced, by more the farther the viewer's line of
 * sight to it turns from the spot's. So the photo shows fully where the two nearly agree and gives
 * way to the model's own skins as they part (and two spots never show the same thing twice:
 * PhotoSpots shows one at a time). The edge of what a spot saw is soft.
 */

/** Distances are kept up to this far (meters). */
export const FAR = 40;
/** Pixels on a side of each face of a spot's cube of distances. */
export const DISTANCE_SIZE = 512;

export interface SpotUniforms {
  spotCube0: THREE.IUniform<THREE.Texture | null>;
  spotCube1: THREE.IUniform<THREE.Texture | null>;
  spotDist0: THREE.IUniform<THREE.Texture | null>;
  spotDist1: THREE.IUniform<THREE.Texture | null>;
  spotPos0: THREE.IUniform<THREE.Vector3>;
  spotPos1: THREE.IUniform<THREE.Vector3>;
  spotWeight0: THREE.IUniform<number>;
  spotWeight1: THREE.IUniform<number>;
  spotFar: THREE.IUniform<number>;
  [name: string]: THREE.IUniform;
}

export function makeSpotUniforms(): SpotUniforms {
  return {
    spotCube0: { value: null },
    spotCube1: { value: null },
    spotDist0: { value: null },
    spotDist1: { value: null },
    spotPos0: { value: new THREE.Vector3() },
    spotPos1: { value: new THREE.Vector3() },
    spotWeight0: { value: 0 },
    spotWeight1: { value: 0 },
    spotFar: { value: FAR },
  };
}

const PACK = /* glsl */ `
vec4 spotPack(float v) {
  vec4 enc = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);
  return enc - enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
float spotUnpack(vec4 v) { return dot(v, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0)); }
`;

/** Cosines of the angle between the viewer's and the spot's lines of sight to a point: the photo
 * shows fully within 6° (a shape 30 cm wrong in depth puts what it shows 3 cm off) and is gone by 20°. */
const COS_FULL = Math.cos((6 * Math.PI) / 180).toFixed(6);
const COS_ZERO = Math.cos((20 * Math.PI) / 180).toFixed(6);
/** A spot's distances are read this many texels to each side, for a soft edge. */
const SOFT = (1.5 * (2 / DISTANCE_SIZE)).toFixed(6);

const SPOT_PARS = /* glsl */ `
uniform samplerCube spotCube0;
uniform samplerCube spotCube1;
uniform samplerCube spotDist0;
uniform samplerCube spotDist1;
uniform vec3 spotPos0;
uniform vec3 spotPos1;
uniform float spotWeight0;
uniform float spotWeight1;
uniform float spotFar;
varying vec3 vSpotWorld;
${PACK}
// Whether the spot saw this point, 0-1: nothing nearer along the way (its cube of distances), read
// there and a little to each side.
float spotSeesAlong(samplerCube distances, vec3 n, float here) {
  return step(here, spotUnpack(textureCube(distances, n)) * spotFar + 0.04 + 0.02 * here);
}
float spotSees(samplerCube distances, vec3 d) {
  float here = length(d);
  vec3 n = d / here;
  vec3 a = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0))) * ${SOFT};
  vec3 b = cross(n, a);
  return (spotSeesAlong(distances, n, here) + spotSeesAlong(distances, n + a, here) + spotSeesAlong(distances, n - a, here)
    + spotSeesAlong(distances, n + b, here) + spotSeesAlong(distances, n - b, here)) / 5.0;
}
// How much the spot's photo shows at a point (d from the spot) the viewer sees along eye (unit).
float spotSay(vec3 d, vec3 eye) {
  return smoothstep(${COS_ZERO}, ${COS_FULL}, dot(normalize(d), eye));
}
`;

const SPOT_FRAGMENT = /* glsl */ `
{
  vec3 spotColor = vec3(0.0);
  float spotTotal = 0.0;
  vec3 spotEye = normalize(vSpotWorld - cameraPosition);
  if (spotWeight0 > 0.001) {
    vec3 d = vSpotWorld - spotPos0;
    float w = spotWeight0 * spotSees(spotDist0, d) * spotSay(d, spotEye);
    spotColor += w * textureCube(spotCube0, d).rgb;
    spotTotal += w;
  }
  if (spotWeight1 > 0.001) {
    vec3 d = vSpotWorld - spotPos1;
    float w = spotWeight1 * spotSees(spotDist1, d) * spotSay(d, spotEye);
    spotColor += w * textureCube(spotCube1, d).rgb;
    spotTotal += w;
  }
  if (spotTotal > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, spotColor / spotTotal, min(spotTotal, 1.0));
}
`;

/** Teach an (unlit) material of the remastered model to show the photo spots. */
export function withPhotoSpots(material: THREE.Material, uniforms: SpotUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSpotWorld;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvSpotWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SPOT_PARS}`)
      .replace("#include <map_fragment>", `#include <map_fragment>\n${SPOT_FRAGMENT}`);
  };
  material.customProgramCacheKey = () => "atrium-photo-spots-2";
  material.needsUpdate = true;
}

/** What a spot's distances are rendered with: every surface (either side) writes how far it is. */
export function spotDistanceMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { spotPos: { value: new THREE.Vector3() }, spotFar: { value: FAR } },
    vertexShader:
      "varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: `uniform vec3 spotPos; uniform float spotFar; varying vec3 vWorld; ${PACK} void main() { gl_FragColor = spotPack(clamp(length(vWorld - spotPos) / spotFar, 0.0, 0.9999)); }`,
    side: THREE.DoubleSide,
  });
}

/** Renders a spot's cube of distances from `scene` (drawn with `material`, a spotDistanceMaterial). */
export function renderSpotDistances(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  material: THREE.ShaderMaterial,
  position: THREE.Vector3,
): THREE.WebGLCubeRenderTarget {
  const target = new THREE.WebGLCubeRenderTarget(DISTANCE_SIZE, {
    type: THREE.UnsignedByteType,
    generateMipmaps: false,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  });
  const cubeCamera = new THREE.CubeCamera(0.03, FAR, target);
  cubeCamera.position.copy(position);
  material.uniforms.spotPos.value.copy(position);
  const clear = gl.getClearColor(new THREE.Color());
  const alpha = gl.getClearAlpha();
  gl.setClearColor(0xffffff, 1);
  cubeCamera.update(gl, scene);
  gl.setClearColor(clear, alpha);
  return target;
}
