/**
 * Scenario scripts for the /demo-studio replay.
 *
 * Data only: the six application demos, their per-step operator/counterparty
 * copy and metric tuples, plus the Kurtosis component path the step index
 * highlights. Split out of `components/demo-studio.tsx` so the component file
 * carries the rendering and this file carries the claims - every `caveat`
 * here is a published claim boundary and is reviewed as copy, not as JSX.
 */

import {
  BadgeCheck,
  Cpu,
  Landmark,
  Users,
  Waypoints,
  Zap,
} from 'lucide-react'

export type DemoId = 'dvp' | 'amm' | 'vault' | 'card' | 'auction' | 'shop'

export type ComponentId = 'clients' | 'sequencer' | 'runtime' | 'prover' | 'ethereum' | 'claims'

export type Step = {
  phase: string
  action: string
  result: string
  operator: string
  counterparty: string
  component: ComponentId
  metrics: [string, string, string, string, string, string]
}

export type Demo = {
  id: DemoId
  short: string
  title: string
  mode: string
  claim: string
  operatorRole: string
  counterpartyRole: string
  caveat: string
  steps: Step[]
}

export const demos: Demo[] = [
  {
    id: 'dvp',
    short: 'DvP',
    title: 'Delivery-versus-payment room',
    mode: 'UNANIMOUS_APPROVERS',
    claim: 'Both legs settle to one proof-bound allocation or the latest verified checkpoint remains.',
    operatorRole: 'Seller / asset owner',
    counterpartyRole: 'Buyer / cash owner',
    caveat: 'Application model and contract tests; production asset adapters remain required.',
    steps: [
      {
        phase: 'Fund',
        action: 'Buyer escrows the cash leg.',
        result: 'Cash is locked to this room and deadline.',
        operator: 'Seller sees funded consideration but cannot take it.',
        counterparty: 'Buyer retains a claim if the episode never completes.',
        component: 'clients',
        metrics: ['Cash locked', '100 units', 'Asset locked', '0 units', 'Checkpoint', 'Genesis'],
      },
      {
        phase: 'Match',
        action: 'Seller escrows ten tokenized units.',
        result: 'Both legs are now attributable to their owners.',
        operator: 'Seller commits the delivery leg.',
        counterparty: 'Buyer verifies the exact asset and quantity.',
        component: 'sequencer',
        metrics: ['Cash locked', '100 units', 'Asset locked', '10 units', 'Checkpoint', 'Open'],
      },
      {
        phase: 'Approve',
        action: 'Both approvers sign the exact episode.',
        result: 'Order, terminal allocation and deadline are bound.',
        operator: 'Seller signs the same journal as the buyer.',
        counterparty: 'Buyer signs only after local replay.',
        component: 'runtime',
        metrics: ['Approvals', '2 of 2', 'Asset locked', '10 units', 'Checkpoint', 'Pending'],
      },
      {
        phase: 'Prove',
        action: 'The room executes both legs and proves conservation.',
        result: 'No external transaction can enter the proved internal order.',
        operator: 'Seller awaits proof-backed cash allocation.',
        counterparty: 'Buyer awaits proof-backed asset allocation.',
        component: 'prover',
        metrics: ['Buyer receives', '10 units', 'Seller receives', '100 units', 'Checkpoint', 'Proving'],
      },
      {
        phase: 'Exit',
        action: 'Ethereum accepts the checkpoint and unlocks claims.',
        result: 'Buyer and seller can claim independently.',
        operator: 'Seller claims 100 payment units.',
        counterparty: 'Buyer claims ten tokenized units.',
        component: 'claims',
        metrics: ['Buyer claim', '10 units', 'Seller claim', '100 units', 'Checkpoint', 'Verified'],
      },
    ],
  },
  {
    id: 'amm',
    short: 'AMM',
    title: 'Bounded AMM execution room',
    mode: 'UNANIMOUS_APPROVERS',
    claim: 'A pinned swap episode preserves reserves and enforces the approved minimum output.',
    operatorRole: 'Liquidity operator',
    counterpartyRole: 'Trader / allocator',
    caveat: 'Certified room-local AMM demonstration; this is not private order flow or general MEV protection.',
    steps: [
      {
        phase: 'Seed',
        action: 'The operator funds two room-local reserves.',
        result: 'The preset binds token pair, fee and invariant.',
        operator: 'Liquidity owner sees both reserves controlled by the room.',
        counterparty: 'Trader can inspect the starting reserve commitment.',
        component: 'clients',
        metrics: ['Reserve A', '1,000', 'Reserve B', '1,000', 'Min output', '90'],
      },
      {
        phase: 'Intent',
        action: 'Trader signs a bounded 100-unit swap.',
        result: 'Input, minimum output, nonce and deadline are committed.',
        operator: 'Operator sees the bounded request, not discretionary routing.',
        counterparty: 'Trader receives an admission receipt.',
        component: 'sequencer',
        metrics: ['Input', '100 A', 'Quoted output', '90 B', 'Deadline', 'Open'],
      },
      {
        phase: 'Execute',
        action: 'The room executes the swap inside an ordered block.',
        result: 'The post-swap reserves are deterministic.',
        operator: 'LP reserve accounting updates in the room.',
        counterparty: 'Trader can observe provisional output.',
        component: 'runtime',
        metrics: ['Reserve A', '1,100', 'Reserve B', '909', 'Output', '91 B'],
      },
      {
        phase: 'Prove',
        action: 'The prover checks the call envelope and reserve invariant.',
        result: 'A sub-minimum output cannot advance the room.',
        operator: 'Operator receives proof of conserved pool accounting.',
        counterparty: 'Trader receives proof the bound was satisfied.',
        component: 'prover',
        metrics: ['Invariant', 'Preserved', 'Output', '91 B', 'Checkpoint', 'Proving'],
      },
      {
        phase: 'Claim',
        action: 'Ethereum accepts the checkpoint.',
        result: 'The trader output and LP reserves become exit-authoritative.',
        operator: 'Liquidity remains in the continuing room.',
        counterparty: 'Trader claims 91 token B.',
        component: 'claims',
        metrics: ['Trader claim', '91 B', 'LP reserves', 'Continuing', 'Checkpoint', 'Verified'],
      },
    ],
  },
  {
    id: 'vault',
    short: 'Vault',
    title: 'Multi-step ERC-4626 workflow',
    mode: 'UNANIMOUS_APPROVERS',
    claim: 'Approve, deposit, room-local rebalance and redeem are checked as one terminal accounting result.',
    operatorRole: 'Vault operator',
    counterpartyRole: 'Depositor / allocator',
    caveat: 'Funded demo workflow; it does not simulate organic yield or a production vault integration.',
    steps: [
      {
        phase: 'Deposit',
        action: 'Depositor funds the room and approves the vault.',
        result: 'Underlying assets are bound to the episode.',
        operator: 'Operator sees funded, attributable input.',
        counterparty: 'Depositor sees the exact maximum spend.',
        component: 'clients',
        metrics: ['Underlying', '100', 'Shares', '0', 'Liability', '100'],
      },
      {
        phase: 'Mint',
        action: 'The vault mints shares in the first room block.',
        result: 'Share ownership stays attributable to the depositor.',
        operator: 'Operator sees new vault liabilities.',
        counterparty: 'Depositor sees provisional shares.',
        component: 'runtime',
        metrics: ['Underlying', '0', 'Shares', '100', 'Liability', '100'],
      },
      {
        phase: 'Rebalance',
        action: 'A funded room-local AMM step changes the allocation.',
        result: 'Every movement remains inside the proved episode.',
        operator: 'Operator checks the approved call set.',
        counterparty: 'Depositor sees updated share-value inputs.',
        component: 'sequencer',
        metrics: ['Calls', '3 approved', 'Shares', '100', 'Liability', '100'],
      },
      {
        phase: 'Prove',
        action: 'The terminal accounting and exit allocation are proven.',
        result: 'Assets, shares and liabilities must reconcile.',
        operator: 'Operator cannot publish an inconsistent terminal root.',
        counterparty: 'Depositor receives a proof-bound redemption amount.',
        component: 'prover',
        metrics: ['Accounting', 'Reconciled', 'Redeemable', '100', 'Checkpoint', 'Proving'],
      },
      {
        phase: 'Redeem',
        action: 'Ethereum accepts the checkpoint and withdrawal root.',
        result: 'The depositor can redeem without closing every room workflow.',
        operator: 'Operator retains only the proved remaining liabilities.',
        counterparty: 'Depositor claims 100 underlying units.',
        component: 'claims',
        metrics: ['User claim', '100', 'Shares burned', '100', 'Checkpoint', 'Verified'],
      },
    ],
  },
  {
    id: 'card',
    short: 'Card game',
    title: 'Server-blind turn-based card room',
    mode: 'VALIDITY_ONLY + INNER PROOFS',
    claim: 'Hidden deck and hand witnesses stay client-side while public game state advances through proved turns.',
    operatorRole: 'Game operator',
    counterpartyRole: 'Player A / Player B',
    caveat: 'Demo proving keys and fixed catalog; fair entropy, random shuffle and production privacy are not claimed.',
    steps: [
      {
        phase: 'Commit',
        action: 'Each browser derives its deck from seed, account and first game block.',
        result: 'Only deck commitments leave the client.',
        operator: 'Server receives commitments, never the unrevealed deck.',
        counterparty: 'Each player sees only their own hand.',
        component: 'clients',
        metrics: ['Private hands', '2', 'Public health', '20 / 20', 'Round', '1'],
      },
      {
        phase: 'Turn',
        action: 'Player A chooses a card within the six-second window.',
        result: 'A hidden-state proof binds the legal draw and play.',
        operator: 'Operator admits the signed public transition.',
        counterparty: 'Player B sees only the revealed card and public effect.',
        component: 'sequencer',
        metrics: ['Decision window', '6 seconds', 'Revealed card', 'Ember Wolf', 'Mana', '2'],
      },
      {
        phase: 'React',
        action: 'Player B sends a predefined reaction and response.',
        result: 'Chat and reaction messages are bounded room transactions.',
        operator: 'Operator orders the response but cannot forge its signature.',
        counterparty: 'Both players observe the same public turn history.',
        component: 'runtime',
        metrics: ['Reaction', 'Shield!', 'Public health', '20 / 18', 'Round', '1'],
      },
      {
        phase: 'Prove',
        action: 'Inner card proofs enter the outer room transition.',
        result: 'The outer prover advances only the committed public state.',
        operator: 'Prover never receives salts, deck order or Merkle paths.',
        counterparty: 'Players verify the public result and proof binding.',
        component: 'prover',
        metrics: ['Hidden witnesses', 'Client-side', 'Public state', 'Bound', 'Checkpoint', 'Proving'],
      },
      {
        phase: 'Checkpoint',
        action: 'Ethereum records the proof-bound game checkpoint.',
        result: 'The game can continue or settle from the latest verified state.',
        operator: 'Operator remains responsible for ordering and liveness.',
        counterparty: 'Players retain an Ethereum-verifiable exit anchor.',
        component: 'ethereum',
        metrics: ['Round', '1 complete', 'Next player', 'B', 'Checkpoint', 'Verified'],
      },
    ],
  },
  {
    id: 'auction',
    short: 'Auction',
    title: 'Commit-reveal uniform-price auction',
    mode: 'VALIDITY_ONLY',
    claim: 'Hidden commitments reveal into one deterministic marginal-price allocation with conserved inventory.',
    operatorRole: 'Seller / auction owner',
    counterpartyRole: 'Bidders',
    caveat: 'Contract-tested model and real CUDA transition proof; the UI replay is not a live customer deployment.',
    steps: [
      {
        phase: 'Open',
        action: 'Seller escrows five tokenized items and sets the reserve.',
        result: 'Cancellation is disabled after the first commitment.',
        operator: 'Seller sees five units locked to the auction.',
        counterparty: 'Bidders inspect supply, reserve and deadlines.',
        component: 'clients',
        metrics: ['Supply', '5 items', 'Reserve', '$6', 'Commitments', '0'],
      },
      {
        phase: 'Commit',
        action: 'Three bidders submit price-and-quantity commitments.',
        result: 'Prices and quantities remain hidden before reveal.',
        operator: 'Seller sees commitment IDs, not prices.',
        counterparty: 'Each bidder receives an admission receipt.',
        component: 'sequencer',
        metrics: ['Commitments', '3', 'Visible prices', '0', 'Reveal bonds', 'Locked'],
      },
      {
        phase: 'Reveal',
        action: 'Bidders reveal signed bids and salts.',
        result: 'Two bids tie at $8; commitment ID resolves priority.',
        operator: 'Seller sees a deterministic revealed book.',
        counterparty: 'Bidders can verify ordering and eligibility.',
        component: 'runtime',
        metrics: ['Top bid', '$10 x 3', 'Tie bids', '$8', 'Supply', '5'],
      },
      {
        phase: 'Clear',
        action: 'The proof computes the marginal price and partial fill.',
        result: 'Three plus two units clear at $8.',
        operator: 'Seller receives a $40 proof-bound allocation.',
        counterparty: 'Winners receive three and two tokenized items.',
        component: 'prover',
        metrics: ['Clearing price', '$8', 'Units filled', '5', 'Proceeds', '$40'],
      },
      {
        phase: 'Claim',
        action: 'Ethereum accepts the clearing checkpoint.',
        result: 'Inventory, proceeds and refunds become independently claimable.',
        operator: 'Seller claims $40.',
        counterparty: 'Bidders claim items and unused escrow.',
        component: 'claims',
        metrics: ['Inventory', 'Conserved', 'Seller claim', '$40', 'Checkpoint', 'Verified'],
      },
    ],
  },
  {
    id: 'shop',
    short: 'Shop',
    title: 'Always-online tokenized shop',
    mode: 'VALIDITY_ONLY',
    claim: 'A customer can sign one bounded purchase, disconnect, and later receive a proof-backed allocation.',
    operatorRole: 'Seller / shop owner',
    counterpartyRole: 'Transient customer',
    caveat: 'Tokenized digital delivery only; physical fulfillment remains outside the guarantee.',
    steps: [
      {
        phase: 'Stock',
        action: 'Seller keeps ten tokenized items in a persistent room.',
        result: 'The shop can continue across many proof checkpoints.',
        operator: 'Seller controls price and inventory policy.',
        counterparty: 'Customer can inspect available inventory.',
        component: 'clients',
        metrics: ['Inventory', '10 items', 'Unit price', '$4', 'Room', 'Online'],
      },
      {
        phase: 'Register',
        action: 'Customer registers a session key and spending limit.',
        result: 'Registration does not add the customer as a checkpoint approver.',
        operator: 'Seller sees a bounded buyer session.',
        counterparty: 'Customer retains a narrow authorization.',
        component: 'clients',
        metrics: ['Spending limit', '$8', 'Quantity cap', '2', 'Approvals needed', '0'],
      },
      {
        phase: 'Admit',
        action: 'Customer submits one signed two-item purchase.',
        result: 'A bonded admission receipt commits an outcome deadline.',
        operator: 'Seller sees admission A-104 queued.',
        counterparty: 'Customer can leave with the receipt.',
        component: 'sequencer',
        metrics: ['Admission', 'A-104', 'Quantity', '2', 'Maximum price', '$8'],
      },
      {
        phase: 'Disconnect',
        action: 'The customer process goes offline; the operator proves the checkpoint.',
        result: 'Correctness no longer depends on the customer staying connected.',
        operator: 'Operator owes include, revert or deterministic rejection.',
        counterparty: 'Customer can recover through receipt challenge or L1 force.',
        component: 'prover',
        metrics: ['Customer', 'Offline', 'Inventory after', '8 items', 'Checkpoint', 'Proving'],
      },
      {
        phase: 'Settle',
        action: 'Ethereum accepts buyer allocation and seller proceeds.',
        result: 'The seller claims $8 and the shop admits the next customer.',
        operator: 'Seller receives proof-backed proceeds.',
        counterparty: 'Customer receives two tokenized items.',
        component: 'claims',
        metrics: ['Buyer claim', '2 items', 'Seller claim', '$8', 'Shop', 'Still online'],
      },
    ],
  },
]

export const topology: Array<{ id: ComponentId; label: string; detail: string; icon: typeof Users }> = [
  { id: 'clients', label: 'USERS', detail: 'Signed inputs', icon: Users },
  { id: 'sequencer', label: 'SEQUENCER', detail: 'Order + admission', icon: Waypoints },
  { id: 'runtime', label: 'ROOM EVM', detail: 'State transition', icon: Cpu },
  { id: 'prover', label: 'CUDA PROVER', detail: 'Validity receipt', icon: Zap },
  { id: 'ethereum', label: 'ETHEREUM', detail: 'Verify + checkpoint', icon: Landmark },
  { id: 'claims', label: 'OUTPUTS', detail: 'Claims / continue', icon: BadgeCheck },
]
