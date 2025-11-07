"use client"

import { useMemo } from 'react'

import { Effects } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'

import { Particles } from './particles'
import { VignetteShader } from './shaders/vignetteShader'

type GLProps = {
  hovering: boolean
}

export const GL = ({ hovering }: GLProps) => {
  const config = useMemo(
    () => ({
      speed: hovering ? 1.25 : 1,
      focus: 3.6,
      aperture: hovering ? 1.6 : 1.8,
      size: 512,
      noiseScale: hovering ? 0.75 : 0.6,
      noiseIntensity: hovering ? 0.65 : 0.52,
      timeScale: 1,
      pointSize: hovering ? 12 : 10,
      opacity: hovering ? 0.9 : 0.8,
      planeScale: 10,
      vignetteDarkness: 1.5,
      vignetteOffset: 0.4,
    }),
    [hovering],
  )

  return (
    <div id="webgl">
      <Canvas
        camera={{
          position: [1.2629783123314589, 2.664606471394044, -1.8178993743288914],
          fov: 50,
          near: 0.01,
          far: 300,
        }}
      >
        <color attach="background" args={[hovering ? '#050505' : '#000']} />
        <Particles
          speed={config.speed}
          aperture={config.aperture}
          focus={config.focus}
          size={config.size}
          noiseScale={config.noiseScale}
          noiseIntensity={config.noiseIntensity}
          timeScale={config.timeScale}
          pointSize={config.pointSize}
          opacity={config.opacity}
          planeScale={config.planeScale}
          useManualTime={false}
          manualTime={0}
          introspect={hovering}
        />
        <Effects multisamping={0} disableGamma>
          <shaderPass
            args={[VignetteShader]}
            uniforms-darkness-value={config.vignetteDarkness}
            uniforms-offset-value={config.vignetteOffset}
          />
        </Effects>
      </Canvas>
    </div>
  )
}

