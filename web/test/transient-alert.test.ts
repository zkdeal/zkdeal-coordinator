import { describe, expect, it, vi } from 'vitest'
import {
  createTransientAlertController,
  TRANSIENT_ALERT_MS,
} from '../lib/transient-alert'

describe('transient operational alerts', () => {
  it('stays visible before 3 seconds and disappears at exactly 3 seconds', () => {
    vi.useFakeTimers()
    const updates: Array<string | null> = []
    const alert = createTransientAlertController((message) => updates.push(message))

    alert.show('GPU queue updated')
    vi.advanceTimersByTime(TRANSIENT_ALERT_MS - 1)
    expect(updates.at(-1)).toBe('GPU queue updated')
    vi.advanceTimersByTime(1)
    expect(updates.at(-1)).toBeNull()

    alert.destroy()
    vi.useRealTimers()
  })

  it('resets the full lifetime when a newer message replaces the first', () => {
    vi.useFakeTimers()
    const updates: Array<string | null> = []
    const alert = createTransientAlertController((message) => updates.push(message))

    alert.show('first')
    vi.advanceTimersByTime(2_500)
    alert.show('replacement')
    vi.advanceTimersByTime(2_999)
    expect(updates.at(-1)).toBe('replacement')
    vi.advanceTimersByTime(1)
    expect(updates.at(-1)).toBeNull()

    alert.destroy()
    vi.useRealTimers()
  })

  it('does not let a repeated identical warning extend its lifetime', () => {
    vi.useFakeTimers()
    const updates: Array<string | null> = []
    const alert = createTransientAlertController((message) => updates.push(message))

    alert.show('backend reconnecting')
    vi.advanceTimersByTime(2_500)
    alert.show('backend reconnecting')
    vi.advanceTimersByTime(500)

    expect(updates).toEqual(['backend reconnecting', null])

    alert.destroy()
    vi.useRealTimers()
  })

  it('never clears persistent blocker state', () => {
    vi.useFakeTimers()
    const updates: Array<string | null> = []
    const persistentBlocker = {
      message: 'The prover artifact lock is unavailable.',
      failedLogEntry: 'artifact readiness failed',
    }
    const alert = createTransientAlertController((message) => updates.push(message))

    alert.show('GPU queue updated')
    vi.advanceTimersByTime(TRANSIENT_ALERT_MS)

    expect(updates.at(-1)).toBeNull()
    expect(persistentBlocker).toEqual({
      message: 'The prover artifact lock is unavailable.',
      failedLogEntry: 'artifact readiness failed',
    })

    alert.destroy()
    vi.useRealTimers()
  })
})
