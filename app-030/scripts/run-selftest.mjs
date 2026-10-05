/** 用 esbuild 把回贴核对自测打包成 ESM 后在 node 里执行（无测试框架依赖） */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const outfile = resolve('node_modules/.cache/recon.selftest.mjs')

await build({
  entryPoints: ['scripts/recon.selftest.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'warning'
})

await import(pathToFileURL(outfile).href)
