#!/usr/bin/env node
/**
 * Build-stage helper for the source-minimized runtime image. Two subcommands:
 *
 *   externals <packageDir>...
 *     Print one `--external:<name>` esbuild flag per third-party dependency
 *     declared by the listed first-party packages. The bundle inlines only
 *     first-party TypeScript; every declared third-party package keeps
 *     resolving from node_modules exactly as it does under tsx today.
 *
 *   link <destNodeModules> <packageDir>...
 *     The bundled entrypoints live under dist/, so the inlined first-party
 *     code now resolves its third-party imports from the bundle location
 *     instead of from each package directory. Symlink every declared
 *     third-party dependency of the listed packages into <destNodeModules>,
 *     each pointing at the exact pnpm store directory that package resolved
 *     at install time. Names already present in <destNodeModules> are kept
 *     (the destination package's own pins win, matching today's resolution
 *     order); two source packages resolving the same name to different store
 *     directories abort the build rather than silently picking one.
 *
 * This file is a build-stage input only; it never ships in the runtime image.
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

function thirdPartyDependencies(packageDir) {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  return Object.keys(manifest.dependencies ?? {}).filter((name) => !name.startsWith('@zkdeal/'))
}

const [command, ...args] = process.argv.slice(2)

if (command === 'externals') {
  const names = new Set()
  for (const packageDir of args) {
    for (const name of thirdPartyDependencies(packageDir)) names.add(name)
  }
  process.stdout.write([...names].sort().map((name) => `--external:${name}`).join(' '))
} else if (command === 'link') {
  const [destination, ...packageDirs] = args
  if (!destination || packageDirs.length === 0) {
    console.error('usage: runtime-bundle-helper.mjs link <destNodeModules> <packageDir>...')
    process.exit(2)
  }
  const linked = new Map()
  for (const packageDir of packageDirs) {
    for (const name of thirdPartyDependencies(packageDir)) {
      const target = realpathSync(join(packageDir, 'node_modules', name))
      const linkPath = join(destination, name)
      const previous = linked.get(name)
      if (previous !== undefined) {
        if (previous !== target) {
          throw new Error(`conflicting store directories for ${name}: ${previous} vs ${target}`)
        }
        continue
      }
      if (existsSync(linkPath)) {
        const existing = realpathSync(linkPath)
        if (existing !== target) {
          console.log(`keeping destination-pinned ${name} (${existing}) over ${target}`)
        }
        linked.set(name, existing)
        continue
      }
      mkdirSync(dirname(linkPath), { recursive: true })
      symlinkSync(target, linkPath)
      linked.set(name, target)
      console.log(`linked ${name} -> ${target}`)
    }
  }
} else {
  console.error('usage: runtime-bundle-helper.mjs externals|link ...')
  process.exit(2)
}
