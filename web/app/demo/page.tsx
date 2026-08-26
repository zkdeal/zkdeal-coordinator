import { LongRunningDemo } from '../../components/long-running-demo'
import { Suspense } from 'react'

export default function DemoPage() {
  return (
    <Suspense>
      <LongRunningDemo />
    </Suspense>
  )
}
