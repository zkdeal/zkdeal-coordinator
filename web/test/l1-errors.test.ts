import { describe, expect, it } from 'vitest'
import { keccak256, toBytes } from 'viem'
import { errorMessage, isAlreadyMemberError } from '../lib/l1-errors'

const ALREADY_MEMBER = keccak256(toBytes('AlreadyMember()')).slice(0, 10)
const WRONG_DEPOSIT = keccak256(toBytes('WrongDeposit()')).slice(0, 10)

/**
 * M-04: joinRoom caught EVERY exception from joinRoomL1 and assumed "may
 * already be member", then marked the browser joined. Wrong deposit, full
 * room, passed deadline, rejected signature and RPC outage all became silent
 * successes for a non-member.
 */
describe('isAlreadyMemberError', () => {
  it('recognises the decoded custom error name', () => {
    expect(isAlreadyMemberError(new Error('execution reverted: AlreadyMember()'))).toBe(true)
  })

  it('recognises the raw revert-data selector when the ABI cannot decode it', () => {
    expect(isAlreadyMemberError({ data: ALREADY_MEMBER })).toBe(true)
  })

  it('recognises it through a viem-style nested cause/data shape', () => {
    expect(
      isAlreadyMemberError({
        shortMessage: 'The contract function reverted.',
        cause: { data: { errorName: 'AlreadyMember' } },
      }),
    ).toBe(true)
  })

  /* ---- everything else must NOT be swallowed ---- */

  it('does not match a wrong-deposit revert', () => {
    expect(isAlreadyMemberError(new Error('execution reverted: WrongDeposit()'))).toBe(false)
    expect(isAlreadyMemberError({ data: WRONG_DEPOSIT })).toBe(false)
  })

  it('does not match RoomFull / DeadlinePassed / WrongState', () => {
    for (const name of ['RoomFull()', 'DeadlinePassed()', 'WrongState()', 'BadParams()']) {
      expect(isAlreadyMemberError(new Error(`execution reverted: ${name}`))).toBe(false)
    }
  })

  it('does not match a user rejection or an RPC failure', () => {
    expect(isAlreadyMemberError(new Error('User rejected the request.'))).toBe(false)
    expect(isAlreadyMemberError(new Error('HTTP request failed: 502'))).toBe(false)
  })

  it('fails closed on undecodable / empty errors', () => {
    expect(isAlreadyMemberError(undefined)).toBe(false)
    expect(isAlreadyMemberError(null)).toBe(false)
    expect(isAlreadyMemberError({})).toBe(false)
    expect(isAlreadyMemberError(new Error(''))).toBe(false)
  })

  it('is not fooled by an unrelated message that merely mentions members', () => {
    expect(isAlreadyMemberError(new Error('room has 3 members'))).toBe(false)
  })

  it('does not recurse forever on a self-referencing cause', () => {
    const e: { message: string; cause?: unknown } = { message: 'boom' }
    e.cause = e
    expect(isAlreadyMemberError(e)).toBe(false)
  })

  /* L9: a self-cycle guard does not cover a two-node cycle. */
  it('does not recurse forever on a two-node cause cycle', () => {
    const a: { message: string; cause?: unknown } = { message: 'outer' }
    const b: { message: string; cause?: unknown } = { message: 'inner', cause: a }
    a.cause = b
    expect(isAlreadyMemberError(a)).toBe(false)
  })

  /* L10: the selector must BE the revert data, not appear anywhere in it. */
  it('does not match the selector embedded inside longer revert data', () => {
    expect(isAlreadyMemberError({ data: `${WRONG_DEPOSIT}${ALREADY_MEMBER.slice(2)}` })).toBe(false)
  })

  it('does not match the selector embedded in request bytes carried as text', () => {
    expect(
      isAlreadyMemberError(
        new Error(`HTTP request failed. Request body: {"data":"0xdeadbeef${ALREADY_MEMBER.slice(2)}"}`),
      ),
    ).toBe(false)
  })
})

describe('errorMessage', () => {
  it('prefers viem shortMessage', () => {
    expect(errorMessage({ shortMessage: 'reverted', message: 'long...' })).toBe('reverted')
  })
  it('falls back to message then String()', () => {
    expect(errorMessage(new Error('nope'))).toBe('nope')
    expect(errorMessage('plain')).toBe('plain')
  })
})
