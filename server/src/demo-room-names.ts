/**
 * Giving every room a name no other room has.
 *
 * WHY THIS EXISTS. Two demo rooms opened from the same cold template used to be
 * called the same thing, and the collision is not cosmetic: a room that is
 * mid-checkpoint refuses moves, so an operator opens "the room" again, gets a
 * SECOND room built from the same cold template, and plays into it - while the
 * moves already settled on L1 stay behind in the first one. Both rooms are
 * called "Card duel live", both are listed, and nothing on screen says which is
 * which. The duel looks like it restarted for no reason.
 *
 * A suffix fixes the naming half of that (`demo-room-view.ts` fixes the
 * silence half by publishing which room superseded which). It is deliberately
 * two short words rather than a uuid: an operator has to be able to say "the
 * brisk-heron one" out loud while looking at a projector, and
 * `room-4f3c8a91-...` is unsayable.
 *
 * The words are chosen with `crypto.randomInt`, and a candidate that is already
 * taken is redrawn, so two rooms created in the same second cannot collide.
 */

import { randomInt } from 'node:crypto'

/** Room names are stored and validated at this length; a suffix must fit. */
export const MAXIMUM_ROOM_NAME_LENGTH = 80

/** How the suffix is joined to the caller's own name. */
const OPEN = ' ('
const CLOSE = ')'

/**
 * 32 x 32 = 1,024 distinct suffixes. Every word is short, unambiguous when
 * spoken, and free of the letter pairs that make two names look alike in a list.
 */
const ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clever', 'copper', 'crisp', 'dusty', 'eager',
  'fleet', 'frosty', 'gentle', 'golden', 'hardy', 'ivory', 'jolly', 'keen',
  'lucky', 'merry', 'noble', 'olive', 'plucky', 'quiet', 'rapid', 'rusty',
  'sharp', 'silver', 'sturdy', 'sunny', 'tidy', 'velvet', 'witty', 'zesty',
] as const

const NOUNS = [
  'anchor', 'badger', 'beacon', 'cedar', 'comet', 'crane', 'dolphin', 'ember',
  'falcon', 'ferry', 'harbor', 'heron', 'ibex', 'jasper', 'kestrel', 'lantern',
  'lynx', 'marlin', 'meadow', 'otter', 'pelican', 'quartz', 'raven', 'ridge',
  'sable', 'summit', 'tundra', 'vulcan', 'walrus', 'willow', 'yarrow', 'zenith',
] as const

/** One `adjective-noun` pair, e.g. `brisk-heron`. */
export function roomNameSuffix(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`
}

/**
 * `base (suffix)`, with `base` trimmed - never the suffix - when the pair would
 * exceed the stored name length. Trimming the suffix would defeat its purpose;
 * trimming the base only shortens a label.
 */
export function withRoomSuffix(base: string, suffix: string): string {
  const tail = `${OPEN}${suffix}${CLOSE}`
  const room = MAXIMUM_ROOM_NAME_LENGTH - tail.length
  const head = base.length > room ? base.slice(0, Math.max(1, room)).trimEnd() : base
  return `${head}${tail}`
}

/**
 * A name built from `base` that no room in `taken` already carries.
 *
 * Falls back to a counted suffix when every drawn pair is somehow taken, so the
 * function is total: it never returns a duplicate and never loops forever.
 */
export function uniqueRoomName(base: string, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = withRoomSuffix(base, roomNameSuffix())
    if (!taken.has(candidate)) return candidate
  }
  for (let index = 2; ; index += 1) {
    const candidate = withRoomSuffix(base, `room-${index}`)
    if (!taken.has(candidate)) return candidate
  }
}
