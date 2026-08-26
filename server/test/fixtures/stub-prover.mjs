#!/usr/bin/env node
// Stub zkVM prover for assist tests: reads {witnessB64,expectedJournal} on
// stdin, echoes a deterministic fake receipt. `STUB_FAIL=1` exits non-zero.
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (process.env.STUB_FAIL === '1') {
    console.error('stub prover forced failure')
    process.exit(3)
  }
  const job = JSON.parse(input)
  const receipt = Buffer.from(`receipt-for:${job.witnessB64.slice(0, 16)}`).toString('base64')
  process.stdout.write(
    JSON.stringify({
      receiptB64: receipt,
      journal: job.expectedJournal ?? { v: 1 },
      proveMs: 12,
    }),
  )
  process.exit(0)
})
