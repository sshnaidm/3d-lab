import type { RootState } from '@react-three/fiber'

/**
 * The canvas renders on demand. Call this while something moves: it schedules another frame and,
 * because the shadow map only refreshes on request, marks shadows stale too.
 */
export function sceneChanged(state: Pick<RootState, 'gl' | 'invalidate'>) {
  state.gl.shadowMap.needsUpdate = true
  state.invalidate()
}

/** Frame delta for animations; after idling, the first on-demand frame reports the whole idle gap. */
export const frameDelta = (dt: number) => Math.min(dt, 0.1)
