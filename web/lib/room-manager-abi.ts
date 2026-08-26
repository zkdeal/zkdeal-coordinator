/**
 * Scenario identifiers used by the web client.
 *
 * This module also carried a hand-written `ROOM_MANAGER_ABI` and `ROOM_STATE`
 * for the v3/v4 RoomManager. Both were removed: nothing in `web/` referenced
 * them, and they no longer described the deployed contract - `createRoom`,
 * `submitCheckpoint(… uint256[69] …)` and `getPendingExits` do not exist on
 * the router or its facets (`contracts/src/IRoomManager.sol`). A stale
 * but plausible ABI for a security-critical contract is what someone reaches
 * for when wiring a new call, and encoding against it produces the wrong
 * selector and argument layout. `@zkdeal/room-client` exports the maintained
 * copy for the packages that still need it.
 */

export const SCENARIO_IDS = {
  generic: 0,
  erc4626: 1,
  dvp: 2,
  /** Rooms configured by an explicit deployment manifest (no preset). */
  custom: 255,
} as const

export type ScenarioKey = keyof typeof SCENARIO_IDS
