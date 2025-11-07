export const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    darkness: { value: 1.5 },
    offset: { value: 0.4 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float darkness;
    uniform float offset;
    uniform sampler2D tDiffuse;

    varying vec2 vUv;

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float dist = distance(vUv, vec2(0.5));
      color.rgb *= smoothstep(0.8, offset * 0.799, dist * (darkness + offset));
      gl_FragColor = color;
    }
  `,
}

