import { cardRoomPreset } from './card-room.js'
import { erc7540Preset } from './erc7540-room.js'
import { ammPreset } from './amm-room.js'
import { naiveAmmPreset } from './naive-amm-room.js'
import { erc4626Preset } from './erc4626-room.js'
import type { DemoPreset } from './demo-types.js'

export const DEMO_PRESETS: readonly DemoPreset[] = [
  {
    id: 'dvp',
    name: 'Atomic DvP',
    summary: 'Two counterparties approve a delivery-versus-payment episode and settle one proof-bound result.',
    workload: 'storage',
    authorizationMode: 'UNANIMOUS_APPROVERS',
    participantCapacity: 128,
    activeApprovers: 2,
    allowedSelectors: ['0x12345678'],
    actions: [
      { id: 'seller-lock', label: 'Seller locks asset', actor: 'seller', calldata: '0x12345678' + '0'.repeat(63) + '9', recommendedBlock: 1 },
      { id: 'buyer-pay', label: 'Buyer authorizes payment', actor: 'buyer', calldata: '0x12345678' + '0'.repeat(63) + 'a', recommendedBlock: 2 },
    ],
    initialStorage: [{ label: 'settlement state', slot: '0', value: '0', mode: 'ROOM_LOCAL' }],
  },
  erc4626Preset(),
  erc7540Preset(),
  {
    id: 'auction',
    name: 'Commit-reveal auction',
    summary: 'Commit in one room block and clear conserved inventory and payment outputs in the next.',
    workload: 'auction-demo',
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 32_768,
    activeApprovers: 0,
    allowedSelectors: ['0x12345678'],
    actions: [
      { id: 'commit-bid', label: 'Commit sealed bid', actor: 'bidder-a', calldata: '0x12345678' + '0'.repeat(63) + '9', recommendedBlock: 1 },
      { id: 'clear-auction', label: 'Reveal and clear', actor: 'auctioneer', calldata: '0x12345678' + '0'.repeat(63) + 'a', recommendedBlock: 2 },
    ],
    initialStorage: [
      { label: 'commitment count', slot: '0', value: '0', mode: 'ROOM_LOCAL' },
      { label: 'seller inventory', slot: '1', value: '4', mode: 'ROOM_LOCAL' },
      { label: 'seller proceeds', slot: '2', value: '0', mode: 'ROOM_LOCAL' },
      { label: 'winner inventory', slot: '3', value: '0', mode: 'ROOM_LOCAL' },
    ],
  },
  {
    id: 'shop',
    name: 'Persistent tokenized shop',
    summary: 'A customer registers, purchases once, disconnects, and receives proof-backed delivery.',
    workload: 'shop-demo',
    authorizationMode: 'VALIDITY_ONLY',
    participantCapacity: 32_768,
    activeApprovers: 0,
    allowedSelectors: ['0x12345678'],
    actions: [
      { id: 'register-session', label: 'Register customer session', actor: 'buyer', calldata: '0x12345678' + '0'.repeat(63) + '9', recommendedBlock: 1 },
      { id: 'buy-item', label: 'Purchase and disconnect', actor: 'buyer', calldata: '0x12345678' + '0'.repeat(63) + 'a', recommendedBlock: 2 },
    ],
    initialStorage: [
      { label: 'session active', slot: '0', value: '0', mode: 'ROOM_LOCAL' },
      { label: 'inventory', slot: '1', value: '8', mode: 'ROOM_LOCAL' },
      { label: 'price', slot: '2', value: '5', mode: 'INITIAL_WITNESS' },
      { label: 'seller proceeds', slot: '3', value: '0', mode: 'ROOM_LOCAL' },
      { label: 'buyer inventory', slot: '4', value: '0', mode: 'ROOM_LOCAL' },
    ],
  },
  ammPreset(),
  naiveAmmPreset(),
  // Replaces a placeholder that claimed to be a card game while running the
  // generic `storage` workload with dummy 0x12345678 calldata. The real
  // declaration is derived from contracts/src/l2/v5/HiddenCardDuel.sol via
  // @zkdeal/protocol; see card-room.ts for why it is capability-gated.
  cardRoomPreset(),
]
