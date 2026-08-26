/**
 * Public surface of the persistent local-demo control plane.
 *
 * The implementation lives in four cohesive modules - types, presets, request
 * validation, the persistent controller and the HTTP routes - and is re-exported
 * here so every existing import specifier keeps working unchanged.
 */
export type {
  AuthorizationMode,
  CheckpointOutcome,
  CheckpointPlan,
  CheckpointPolicyDocument,
  CheckpointTrigger,
  DemoAction,
  DemoCheckpoint,
  DemoCheckpointRecord,
  DemoCheckpointRequest,
  DemoCardRoom,
  DemoErc7540Room,
  DemoErc4626Room,
  DemoCheckpointStatus,
  DemoContractArtifact,
  DemoFailure,
  DemoJob,
  DemoPhase,
  DemoPreparedTemplate,
  DemoPreset,
  DemoPresetAction,
  DemoPresetPeer,
  DemoRoom,
  DemoRoomRequest,
  DemoRuntime,
  DemoSnapshot,
  DemoStateSelection,
  DemoSystemStatus,
  DemoTemplate,
  DemoTemplateRequest,
  ProvingSlotEntry,
  ProvingSlotStatus,
  StateMode,
} from './demo-types.js'

export {
  checkpointPolicyDocument,
  planCheckpoint,
  CHECKPOINT_BUDGET_BLOCKS,
  CHECKPOINT_INTERVAL_SECONDS,
  CHECKPOINT_MINIMUM_INTERVAL_SECONDS,
  CHECKPOINT_MOVE_THRESHOLD,
  CHECKPOINT_START_MARGIN_BLOCKS,
  DEFAULT_DEADLINE_BLOCKS_FROM_START,
} from './demo-checkpoint-policy.js'
export {
  defaultDeadlineBlocks,
  roomSettingsDocument,
  roomSettings,
  validateDeadlineBlocks,
  CARD_ROOM_DEADLINE_BLOCKS,
  CARD_ROOM_PROVING_HEADROOM_SECONDS,
  MAXIMUM_DEADLINE_BLOCKS,
  MAXIMUM_DEADLINE_SECONDS,
  MINIMUM_DEADLINE_BLOCKS,
} from './demo-room-settings.js'
export type { DemoRoomSettingsDocument, DemoRoomSettings } from './demo-room-settings.js'
export {
  cardRoomPublication,
  closedRoomExplanation,
  moveAcceptance,
  roomView,
} from './demo-room-view.js'
export type {
  DemoActionView,
  DemoCardRoomPublication,
  DemoDeploymentLink,
  DemoMoveAcceptance,
  DemoRoomView,
  DemoSettlementLink,
} from './demo-room-view.js'
export {
  roomNameSuffix,
  uniqueRoomName,
  withRoomSuffix,
  MAXIMUM_ROOM_NAME_LENGTH,
} from './demo-room-names.js'
export { ProvingSlot } from './demo-proving-queue.js'
export { checkpointPlan, pendingActions } from './demo-checkpoint-state.js'
export { DEMO_PRESETS } from './demo-presets.js'
export { validateTemplateRequest } from './demo-validation.js'
export { DemoController } from './demo-controller.js'
export { publicDemoView, registerDemoRoutes } from './demo-routes.js'
