import { ApplicationDemos } from '@/components/application-demos'
import { Suspense } from 'react'

export default function DemosPage() {
  return (
    <Suspense>
      <ApplicationDemos />
    </Suspense>
  )
}
