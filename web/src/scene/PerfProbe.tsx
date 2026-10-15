import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'

interface PerfStats {
  frames: number
  calls: number
  triangles: number
  meshes: () => number
  shadowUpdates: number
}

declare global {
  interface Window {
    __perf?: PerfStats
  }
}

/** Opt-in render statistics (`?perf` in the URL) exposed on `window.__perf` for profiling. */
export function PerfProbe() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    gl.info.autoReset = false
    const meshes = () => {
      let n = 0
      scene.traverseVisible((o) => {
        if ((o as { isMesh?: boolean }).isMesh) n += 1
      })
      return n
    }
    window.__perf = { frames: 0, calls: 0, triangles: 0, meshes, shadowUpdates: 0 }
    return () => {
      gl.info.autoReset = true
    }
  }, [gl, scene])
  useFrame(() => {
    const stats = window.__perf
    if (!stats) return
    // info accumulates over every pass of the previous frame (scene, shadows, effects).
    stats.frames += 1
    if (gl.shadowMap.needsUpdate) stats.shadowUpdates += 1
    stats.calls = gl.info.render.calls
    stats.triangles = gl.info.render.triangles
    gl.info.reset()
  })
  return null
}

export const perfEnabled = new URLSearchParams(window.location.search).has('perf')
