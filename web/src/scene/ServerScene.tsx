import { CameraControls, ContactShadows, Environment, Grid, Lightformer, useTexture } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { Bloom, EffectComposer, N8AO, ToneMapping } from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { Suspense, useEffect } from 'react'
import * as THREE from 'three'
import { Chassis } from '../parts'
import { useExplorer, type ViewPreset } from '../ui/store'
import { PerfProbe, perfEnabled } from './PerfProbe'
import { objectRegistry } from './registry'
import { sceneChanged } from './demand'
import { SlotView } from './SlotView'

const SCALE = 0.01 // mm → scene units

// [camera position, target] per preset, in scene units. Front of the server faces -z.
const VIEWS: Record<ViewPreset, [number, number, number, number, number, number]> = {
  iso: [6.2, 5.6, -8.2, -0.6, 0, 0.6],
  front: [0, 1.4, -10.8, 0, 0.35, 0],
  rear: [0, 1.6, 10.8, 0, 0.35, 0],
  top: [0, 11.5, 0.01, 0, 0, 0],
}

function CameraRig() {
  const controls = useExplorer((s) => s.controls)
  const view = useExplorer((s) => s.view)
  const selectedId = useExplorer((s) => s.selectedId)

  useEffect(() => {
    if (!controls) return
    const [px, py, pz, tx, ty, tz] = VIEWS[view.preset]
    void controls.setLookAt(px, py, pz, tx, ty, tz, view.nonce > 1)
  }, [controls, view])

  useEffect(() => {
    const obj = selectedId ? objectRegistry.get(selectedId) : undefined
    if (!controls || !obj) return
    obj.updateWorldMatrix(true, true) // on a deep link nothing has rendered yet; include the parents' mm scale
    const box = new THREE.Box3().setFromObject(obj)
    const center = box.getCenter(new THREE.Vector3())
    const radius = box.getSize(new THREE.Vector3()).length() / 2
    void controls.moveTo(center.x, center.y, center.z, true)
    void controls.dollyTo(THREE.MathUtils.clamp(radius * 6, 1.4, 6), true)
  }, [controls, selectedId])

  return null
}

// Shift the rendered view right so the model is centred in the area not covered by the sidebar.
function SidebarOffset() {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const shift = size.width >= 1024 ? 180 : 0
    camera.setViewOffset(size.width, size.height, -shift, 0, size.width, size.height)
    invalidate()
    return () => camera.clearViewOffset()
  }, [camera, size, invalidate])
  return null
}

// Photo backdrop (public/backgrounds/datacenter.jpg, CC0 — "Front of server racks at NERSC",
// Derrick Coetzee, Wikimedia Commons), darkened and blurred so the model stays readable.
const BACKDROP_URL = `${import.meta.env.BASE_URL}backgrounds/datacenter.jpg`

/** Scene background image, cropped to cover the canvas like CSS `background-size: cover`. */
function Backdrop() {
  const texture = useTexture(BACKDROP_URL)
  const scene = useThree((s) => s.scene)
  const size = useThree((s) => s.size)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const { width, height } = texture.image as {
      width: number
      height: number
    }
    const imageAspect = width / height
    const canvasAspect = size.width / size.height
    texture.colorSpace = THREE.SRGBColorSpace
    if (canvasAspect > imageAspect) texture.repeat.set(1, imageAspect / canvasAspect)
    else texture.repeat.set(canvasAspect / imageAspect, 1)
    texture.offset.set((1 - texture.repeat.x) / 2, (1 - texture.repeat.y) / 2)
    texture.needsUpdate = true
    scene.background = texture
    invalidate()
    return () => {
      scene.background = null
    }
  }, [texture, scene, size, invalidate])
  return null
}

function Lights() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight
        position={[3, 8, -4]}
        intensity={2.4}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-5}
        shadow-camera-right={5}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
      />
      <Environment resolution={256} frames={1} environmentIntensity={1.5}>
        <color attach="background" args={['#0b0e12']} />
        <Lightformer form="rect" intensity={3} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[10, 6, 1]} />
        <Lightformer form="rect" intensity={1.6} position={[-6, 2, -3]} rotation-y={Math.PI / 2} scale={[8, 2, 1]} />
        <Lightformer form="rect" intensity={1.2} position={[6, 2, 3]} rotation-y={-Math.PI / 2} scale={[8, 2, 1]} />
        <Lightformer form="ring" color="#6fd6ff" intensity={2} position={[0, 3, -8]} scale={3} />
        <Lightformer
          form="rect"
          color="#ffd9b0"
          intensity={0.8}
          position={[0, 1, 8]}
          rotation-y={Math.PI}
          scale={[10, 2, 1]}
        />
      </Environment>
    </>
  )
}

/** Shadows are static unless parts move, so the shadow map is refreshed on scene changes only. */
function ShadowSync() {
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)
  const scene = useExplorer((s) => s.scene)
  const hideEmpty = useExplorer((s) => s.hideEmpty)
  const colorMode = useExplorer((s) => s.colorMode)
  const lidOn = useExplorer((s) => s.lidOn)
  const exploded = useExplorer((s) => s.exploded)
  useEffect(() => {
    gl.shadowMap.autoUpdate = false
    return () => {
      gl.shadowMap.autoUpdate = true
    }
  }, [gl])
  // The store values are triggers only: any of them changes what casts shadows.
  // oxlint-disable-next-line react/exhaustive-effect-dependencies
  useEffect(() => sceneChanged({ gl, invalidate }), [gl, invalidate, scene, hideEmpty, colorMode, lidOn, exploded])
  return null
}

function Server() {
  const topology = useExplorer((s) => s.topology)
  const scene = useExplorer((s) => s.scene)
  const lidOn = useExplorer((s) => s.lidOn)
  const exploded = useExplorer((s) => s.exploded)
  if (!topology || !scene) return null
  return (
    <group scale={SCALE}>
      <Chassis layout={scene.layout} model={topology.system.model} lidOn={lidOn} exploded={exploded} />
      {scene.placements.map((p) => (
        <SlotView key={`${topology.server_id}:${p.anchor.slot_key}`} placement={p} />
      ))}
    </group>
  )
}

export function ServerScene() {
  const setControls = useExplorer((s) => s.setControls)
  const select = useExplorer((s) => s.select)
  const backdrop = useExplorer((s) => s.backdrop)
  const serverId = useExplorer((s) => s.serverId)

  return (
    <Canvas
      shadows
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ antialias: false }}
      camera={{
        position: VIEWS.iso.slice(0, 3) as [number, number, number],
        fov: 32,
        near: 0.05,
        far: 200,
      }}
      onPointerMissed={() => select(null)}
    >
      {backdrop ? (
        <Suspense fallback={null}>
          <Backdrop />
        </Suspense>
      ) : (
        <color attach="background" args={['#07090c']} />
      )}
      <fog attach="fog" args={['#07090c', 14, 34]} />
      <Lights />
      <Server />
      <EffectComposer autoClear={false} multisampling={4}>
        <N8AO halfRes aoRadius={0.18} intensity={2.2} distanceFalloff={0.6} />
        <Bloom mipmapBlur luminanceThreshold={1.1} intensity={0.9} radius={0.5} />
        <ToneMapping mode={ToneMappingMode.AGX} />
      </EffectComposer>
      <ContactShadows
        key={serverId ?? ''}
        frames={1}
        position={[0, -0.002, 0]}
        scale={[9, 11]}
        blur={2.4}
        opacity={0.75}
        far={2}
        resolution={1024}
      />
      {!backdrop && (
        <Grid
          position={[0, -0.004, 0]}
          infiniteGrid
          cellSize={0.25}
          sectionSize={1}
          cellColor="#141b22"
          sectionColor="#1e2934"
          fadeDistance={26}
          fadeStrength={1.6}
        />
      )}
      <CameraControls ref={setControls} makeDefault minDistance={0.6} maxDistance={18} dollySpeed={0.6} />
      <CameraRig />
      <SidebarOffset />
      <ShadowSync />
      {perfEnabled && <PerfProbe />}
    </Canvas>
  )
}
