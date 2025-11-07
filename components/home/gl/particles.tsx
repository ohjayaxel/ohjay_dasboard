import * as THREE from 'three'
import { useMemo, useState, useRef } from 'react'
import { createPortal, useFrame } from '@react-three/fiber'
import { useFBO } from '@react-three/drei'
import * as easing from 'maath/easing'

import { DofPointsMaterial } from './shaders/pointMaterial'
import { SimulationMaterial } from './shaders/simulationMaterial'

type ParticlesProps = {
  speed: number
  aperture: number
  focus: number
  size: number
  noiseScale?: number
  noiseIntensity?: number
  timeScale?: number
  pointSize?: number
  opacity?: number
  planeScale?: number
  useManualTime?: boolean
  manualTime?: number
  introspect?: boolean
}

export function Particles({
  speed,
  aperture,
  focus,
  size = 512,
  noiseScale = 1,
  noiseIntensity = 0.5,
  timeScale = 0.5,
  pointSize = 2,
  opacity = 1,
  planeScale = 1,
  useManualTime = false,
  manualTime = 0,
  introspect = false,
  ...props
}: ParticlesProps) {
  const revealStartTime = useRef<number | null>(null)
  const [isRevealing, setIsRevealing] = useState(true)
  const revealDuration = 3.5

  const simulationMaterial = useMemo(() => new SimulationMaterial(planeScale), [planeScale])

  const target = useFBO(size, size, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType,
  })

  const dofPointsMaterial = useMemo(() => {
    const material = new DofPointsMaterial()
    material.uniforms.positions.value = target.texture
    material.uniforms.initialPositions.value = simulationMaterial.uniforms.positions.value
    return material
  }, [simulationMaterial, target.texture])

  const [scene] = useState(() => new THREE.Scene())
  const [camera] = useState(
    () => new THREE.OrthographicCamera(-1, 1, 1, -1, 1 / Math.pow(2, 53), 1),
  )
  const [positions] = useState(
    () =>
      new Float32Array([
        -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0,
      ]),
  )
  const [uvs] = useState(() => new Float32Array([0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0]))

  const particles = useMemo(() => {
    const length = size * size
    const data = new Float32Array(length * 3)
    for (let i = 0; i < length; i++) {
      const i3 = i * 3
      data[i3 + 0] = (i % size) / size
      data[i3 + 1] = i / size / size
    }
    return data
  }, [size])

  useFrame((state, delta) => {
    if (!dofPointsMaterial || !simulationMaterial) return

    state.gl.setRenderTarget(target)
    state.gl.clear()
    // @ts-expect-error
    state.gl.render(scene, camera)
    state.gl.setRenderTarget(null)

    const currentTime = useManualTime ? manualTime : state.clock.elapsedTime

    if (revealStartTime.current === null) {
      revealStartTime.current = currentTime
    }

    const revealElapsed = currentTime - revealStartTime.current
    const revealProgress = Math.min(revealElapsed / revealDuration, 1.0)
    const easedProgress = 1 - Math.pow(1 - revealProgress, 3)
    const revealFactor = easedProgress * 4.0

    if (revealProgress >= 1.0 && isRevealing) {
      setIsRevealing(false)
    }

    dofPointsMaterial.uniforms.uTime.value = currentTime
    dofPointsMaterial.uniforms.uFocus.value = focus
    dofPointsMaterial.uniforms.uBlur.value = aperture

    easing.damp(dofPointsMaterial.uniforms.uTransition, 'value', introspect ? 1.0 : 0.0, introspect ? 0.35 : 0.2, delta)

    simulationMaterial.uniforms.uTime.value = currentTime
    simulationMaterial.uniforms.uNoiseScale.value = noiseScale
    simulationMaterial.uniforms.uNoiseIntensity.value = noiseIntensity
    simulationMaterial.uniforms.uTimeScale.value = timeScale * speed

    dofPointsMaterial.uniforms.uPointSize.value = pointSize
    dofPointsMaterial.uniforms.uOpacity.value = opacity
    dofPointsMaterial.uniforms.uRevealFactor.value = revealFactor
    dofPointsMaterial.uniforms.uRevealProgress.value = easedProgress
  })

  return (
    <>
      {createPortal(
        // @ts-expect-error
        <mesh material={simulationMaterial}>
          <bufferGeometry>
            <bufferAttribute attach="attributes-position" args={[positions, 3]} />
            <bufferAttribute attach="attributes-uv" args={[uvs, 2]} />
          </bufferGeometry>
        </mesh>,
        // @ts-expect-error
        scene,
      )}

      {/* @ts-expect-error */}
      <points material={dofPointsMaterial} {...props}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[particles, 3]} />
        </bufferGeometry>
      </points>
    </>
  )
}

