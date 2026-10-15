import { Instance, Instances } from '@react-three/drei'
import { useMemo } from 'react'
import { labelTexture } from './labelTexture'
import { M } from './materials'
import { B, Cyl, Sticker } from './prim'
import { str, type PartProps } from './types'

function shortModel(model: string | undefined): [string, string] {
  if (!model) return ['PROCESSOR', '']
  const m = /(Xeon|EPYC)[^\d]*([A-Za-z]+\s*)?(\w*\d{4}\w*)/i.exec(model.replace(/\(R\)|\(TM\)/g, ''))
  if (m) return [m[1].toUpperCase(), `${(m[2] ?? '').trim()} ${m[3]}`.trim().toUpperCase()]
  return [model.split(' ')[0].toUpperCase(), '']
}

export function Cpu({ size, component, present }: PartProps) {
  const [w, h, d] = size
  const base = -h / 2
  const [family, sku] = shortModel(str(component?.summary.model) ?? component?.name)
  const label = useMemo(
    () => labelTexture([family, sku], { width: 512, height: 256, background: '#e7e8e6', accent: '#0b64c0' }),
    [family, sku],
  )
  const fins = Math.floor(w / 2.4)

  if (!present)
    return (
      <group>
        <B p={[0, base + 2, 0]} s={[w * 0.78, 4, d * 0.82]} m={M.plastic} />
        <B p={[0, base + 5, 0]} s={[w * 0.6, 2, d * 0.62]} m={M.plasticGrey} />
      </group>
    )

  const finH = h - 14
  return (
    <group>
      {/* socket frame + copper base plate */}
      <B p={[0, base + 2, 0]} s={[w * 0.82, 4, d * 0.86]} m={M.plastic} />
      <B p={[0, base + 7, 0]} s={[w * 0.9, 6, d * 0.92]} m={M.copper} />
      <Instances limit={fins} castShadow receiveShadow material={M.aluminum}>
        <boxGeometry args={[0.5, finH, d]} />
        {Array.from({ length: fins }, (_, i) => (
          <Instance key={i} position={[-w / 2 + 1.2 + i * 2.4, base + 10 + finH / 2, 0]} />
        ))}
      </Instances>
      {/* heat pipes along the fin stack */}
      {[-0.3, 0, 0.3].map((f) => (
        <Cyl key={f} p={[f * w, base + 14, 0]} d={6} h={d + 4} m={M.copper} rotation={[Math.PI / 2, 0, 0]} />
      ))}
      {/* top cover with sticker */}
      <B p={[0, base + h - 2, 0]} s={[w, 2, d]} m={M.brushed} />
      <Sticker p={[0, base + h - 0.9, 0]} w={w * 0.55} h={d * 0.32} face="top" map={label} />
      {/* captive screws */}
      {[-1, 1].flatMap((sx) =>
        [-1, 1].map((sz) => (
          <Cyl
            key={`${sx}${sz}`}
            p={[sx * (w / 2 - 5), base + h - 0.5, sz * (d / 2 - 5)]}
            d={6}
            h={3}
            m={M.touchBlue}
          />
        )),
      )}
    </group>
  )
}
