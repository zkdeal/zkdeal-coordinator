import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HOSTING_OPENAPI } from '../src/hosting-capabilities.js'

const target = resolve(import.meta.dirname, '../capabilities/hosting-v1.openapi.json')
const rendered = `${JSON.stringify(HOSTING_OPENAPI, null, 2)}\n`

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '')
  if (current !== rendered) {
    throw new Error('capabilities/hosting-v1.openapi.json is stale; run npm run generate:hosting-openapi')
  }
} else {
  await writeFile(target, rendered, 'utf8')
}
