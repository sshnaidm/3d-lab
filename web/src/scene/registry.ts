import type * as THREE from 'three'

/** Selection id → scene object, used to frame the camera on a selected part. */
export const objectRegistry = new Map<string, THREE.Object3D>()
