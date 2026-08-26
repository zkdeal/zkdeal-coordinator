'use client'

import { useEffect, useMemo, useState } from 'react'

export const TRANSIENT_ALERT_MS = 3_000

export interface TransientAlertController {
  readonly show: (message: string) => void
  readonly dismiss: () => void
  readonly destroy: () => void
}

type Timer = ReturnType<typeof globalThis.setTimeout>

/**
 * One shared timer policy for operational notices.
 *
 * Calling `show` with a newer message cancels the previous timer before
 * starting a fresh three-second lifetime, so the replacement is never removed
 * by the older message's timeout. Repeated identical notices keep the original
 * deadline. Persistent blockers and failure logs use separate state and
 * deliberately do not pass through this controller.
 */
export function createTransientAlertController(
  publish: (message: string | null) => void,
  schedule: (callback: () => void, delayMs: number) => Timer = globalThis.setTimeout,
  cancel: (timer: Timer) => void = globalThis.clearTimeout,
): TransientAlertController {
  let timer: Timer | null = null
  let currentMessage: string | null = null

  const dismiss = () => {
    if (timer !== null) cancel(timer)
    timer = null
    currentMessage = null
    publish(null)
  }

  return {
    show(message) {
      // A repeating transport error is still the same notice, not a newer
      // message. Let its original lifetime expire instead of keeping the
      // banner alive forever by restarting the timer on every retry.
      if (timer !== null && currentMessage === message) return
      if (timer !== null) cancel(timer)
      currentMessage = message
      publish(message)
      timer = schedule(() => {
        timer = null
        currentMessage = null
        publish(null)
      }, TRANSIENT_ALERT_MS)
    },
    dismiss,
    destroy() {
      if (timer !== null) cancel(timer)
      timer = null
      currentMessage = null
    },
  }
}

export function useTransientAlert() {
  const [message, setMessage] = useState<string | null>(null)
  const controller = useMemo(() => createTransientAlertController(setMessage), [])

  useEffect(() => () => controller.destroy(), [controller])

  return useMemo(
    () => ({
      message,
      show: controller.show,
      dismiss: controller.dismiss,
    }),
    [controller, message],
  )
}
