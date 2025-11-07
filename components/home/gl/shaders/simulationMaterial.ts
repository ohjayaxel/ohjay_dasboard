import * as THREE from 'three'

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform sampler2D positions;
  uniform float uTime;
  uniform float uNoiseScale;
  uniform float uNoiseIntensity;
  uniform float uTimeScale;

  float hash(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    vec2 u = f * f * (3.0 - 2.0 * f);

    return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
  }

  void main() {
    vec4 positionData = texture2D(positions, vUv);
    vec3 pos = positionData.xyz;

    float time = uTime * uTimeScale;

    vec3 velocity = vec3(0.0);
    velocity.x += noise((pos.xy + time) * uNoiseScale) * uNoiseIntensity;
    velocity.y += noise((pos.yz - time) * uNoiseScale) * uNoiseIntensity;
    velocity.z += noise((pos.zx + time * 0.5) * uNoiseScale) * uNoiseIntensity;

    pos += velocity;

    pos.x = mod(pos.x + 10.0, 20.0) - 10.0;
    pos.y = mod(pos.y + 10.0, 20.0) - 10.0;
    pos.z = mod(pos.z + 10.0, 20.0) - 10.0;

    gl_FragColor = vec4(pos, 1.0);
  }
`

export class SimulationMaterial extends THREE.ShaderMaterial {
  constructor(scale = 1) {
    const size = 512
    super({
      uniforms: {
        positions: { value: new THREE.DataTexture(new Float32Array(size * size * 4), size, size, THREE.RGBAFormat, THREE.FloatType) },
        uTime: { value: 0 },
        uNoiseScale: { value: 1 },
        uNoiseIntensity: { value: 0.5 },
        uTimeScale: { value: 1 },
      },
      vertexShader,
      fragmentShader,
    })

    const data = new Float32Array(size * size * 4)
    for (let i = 0; i < size * size; i++) {
      const stride = i * 4
      const x = (i % size) / size
      const y = Math.floor(i / size) / size

      data[stride] = (x - 0.5) * scale * 10
      data[stride + 1] = (Math.random() - 0.5) * scale * 5
      data[stride + 2] = (y - 0.5) * scale * 10
      data[stride + 3] = 1
    }

    const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType)
    texture.needsUpdate = true
    this.uniforms.positions.value = texture
  }
}

