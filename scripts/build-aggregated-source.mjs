/**
 * 聚合音源单文件构建器。
 *
 * 把多个洛雪 .js 音源“读出来合成一个”时，直接拼接是行不通的：每个脚本
 * 顶层都有同名声明（加载即报重复声明），且沙箱只取第一个 request 处理器，
 * 后注册的脚本会被静默丢弃。本构建器的做法与 PoC（~/workspace/lx-aggregate-poc/）
 * 一致：每个内嵌脚本包进独立 IIFE、拿到一个只拦截 on/send 的 lx 垫片，
 * 调度层一次注册，musicUrl 按表内顺序逐个试，返回第一个可用地址。
 *
 * 对原脚本的改动（全部显式断言，脚本改版导致断言失败时直接报错退出，
 * 绝不静默生成坏文件）：
 *   1. 每个脚本的 lx 解构行 `= globalThis.lx` 改为指向自己的垫片；
 *   2. 写死的后端端点密钥常量用正则置空（值从不写入任何文件；对应后端
 *      默认关闭，默认行为不变）。
 * 其余每一行逻辑、常量、开关默认值均未改动。
 *
 * 新增脚本时只需在 SOURCES 表里加一行，并先过一遍合规检查：普通脚本
 * （无 ESM import/export、无顶层 await）、只通过 globalThis.lx 解构拿 API、
 * 不依赖 lx.currentScriptInfo 做身份/版本逻辑、无与其它脚本同名的
 * globalThis.__xxx 共享状态、写死密钥个案处理；然后跑
 * node scripts/test-aggregated-source.mjs 做逐平台逐音质对照实测。
 *
 * 用法：node scripts/build-aggregated-source.mjs
 * 产物：public/aggregated-sources.js（确定性输出，不含时间戳；输入不变则输出不变）
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = path.join(REPO_ROOT, 'public', 'aggregated-sources.js')

/**
 * 内嵌源表。顺序即 musicUrl 兜底顺序。
 * - id: 短标识（仅用于日志与垫片命名）
 * - file: 仓库内相对路径
 * - shim: 垫片变量名（脚本内 lx 解构改指它）
 * - embedded: 垫片实例变量名（调度层用）
 * - destructure: 该脚本顶层的 lx 解构行原文（必须逐字匹配，否则报错）
 * - blankConstants: 需要置空的写死密钥常量，{ pattern, expect }，pattern 为
 *   正则源码（全局匹配），expect 为期望命中次数；值从不写入任何文件。
 */
const SOURCES = [
  {
    id: 'doubao',
    label: '豆包定制',
    file: 'sources/标准/lx-source.js',
    shim: '__shimDoubao',
    embedded: '__embeddedDoubao',
    destructure:
      'const { EVENT_NAMES, request, on, send, utils, env, version } = globalThis.lx;',
    blankConstants: [
      {
        names: 'SUYIN_QQ_KEY / HUIBQ_REQUEST_KEY',
        pattern: 'const (SUYIN_QQ_KEY|HUIBQ_REQUEST_KEY) = "[^"]*";',
        expect: 2,
      },
    ],
  },
  {
    id: 'xinghai',
    label: '星海音乐源 v3.2.20',
    file: 'sources/优质/xinghai-music-sourcev2.3.20.js',
    shim: '__shimXinghai',
    embedded: '__embeddedXinghai',
    destructure: 'const { EVENT_NAMES, request, on, send, env } = globalThis.lx;',
    blankConstants: [],
  },
]

function fail(message) {
  throw new Error(`[build-aggregated-source] ${message}`)
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

function assertNoEsm(entry, code) {
  for (const line of code.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
    if (/^import\s+[\w*{]/.test(trimmed)) {
      fail(`${entry.id}: 含 ESM import 语句，无法以 IIFE 方式内嵌: ${trimmed.slice(0, 80)}`)
    }
    if (/^export\s+(default|const|let|var|function|class|\{)/.test(trimmed)) {
      fail(`${entry.id}: 含 ESM export 语句，无法以 IIFE 方式内嵌: ${trimmed.slice(0, 80)}`)
    }
  }
}

async function prepareSource(entry) {
  const absPath = path.join(REPO_ROOT, entry.file)
  let code
  try {
    code = await fs.readFile(absPath, 'utf8')
  } catch {
    fail(`${entry.id}: 读不到 ${entry.file}`)
  }
  assertNoEsm(entry, code)
  if (code.includes(entry.shim) || code.includes(entry.embedded) || code.includes('__createShim')) {
    fail(`${entry.id}: 脚本已含聚合包装层标识符，拒绝内嵌（疑似重复构建输入）`)
  }
  if (countOccurrences(code, entry.destructure) !== 1) {
    fail(
      `${entry.id}: lx 解构行未精确命中 1 次（脚本改版？）: ${entry.destructure}`,
    )
  }
  code = code.replace(
    entry.destructure,
    entry.destructure.replace('= globalThis.lx;', `= ${entry.shim};`),
  )
  const blanked = []
  for (const rule of entry.blankConstants) {
    const re = new RegExp(rule.pattern, 'g')
    const matches = [...code.matchAll(re)].map((m) => m[1])
    if (matches.length !== rule.expect) {
      fail(
        `${entry.id}: 密钥常量期望命中 ${rule.expect} 处（${rule.names}），实际 ${matches.length} 处（脚本改版？）`,
      )
    }
    code = code.replace(re, 'const $1 = "";')
    blanked.push(...matches)
  }
  return { entry, code, blanked }
}

function wrapperHeader() {
  const labels = SOURCES.map((s) => s.label).join(' + ')
  return `/*!
 * @name 聚合音源
 * @description 单注册聚合：内部嵌入 ${labels} 的解析逻辑（各自独立作用域），musicUrl 按顺序兜底，返回第一个可用地址。由 scripts/build-aggregated-source.mjs 生成，请勿手工编辑。
 * @version 1.0.0
 * @author cf-anheplayer
 */

// ---------------- 聚合包装层（本文件唯一新增逻辑） ----------------
// 每个内嵌脚本拿到一个 lx 垫片：request/utils/env/version 全部来自真实 lx，
// 只有 on/send 被拦截——on 捕获它注册的 request 处理器，send 捕获它的
// inited 上报。内嵌脚本的其余代码（包括直接读 globalThis.lx.utils 处）
// 走的都是真实 lx，与单独加载时一致。
function __createShim() {
  const handlers = new Map()
  const shim = {}
  for (const key of Object.keys(globalThis.lx)) shim[key] = globalThis.lx[key]
  shim.on = (name, handler) => {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(handler)
    return Promise.resolve()
  }
  let initedData = null
  shim.send = (name, data) => {
    if (name === 'inited') initedData = data
    return Promise.resolve()
  }
  return { shim, handlers, getInited: () => initedData }
}
`
}

function wrapperFooter() {
  const embeddedList = SOURCES.map((s) => s.embedded).join(', ')
  const handlerList = SOURCES.map(
    (s) => `...(${s.embedded}.handlers.get('request') || [])`,
  ).join(',\n  ')
  return `
// ---------------- 聚合调度层 ----------------
const __QUALITY_ORDER = ['128k', '192k', '320k', 'flac', 'flac24bit', 'hires', 'atmos', 'atmos_plus', 'master', 'spatial']

function __mergeSources() {
  const merged = {}
  for (const embedded of [${embeddedList}]) {
    const sources = (embedded.getInited() && embedded.getInited().sources) || {}
    for (const [key, cfg] of Object.entries(sources)) {
      if (!merged[key]) {
        merged[key] = { name: cfg.name, type: 'music', actions: [...(cfg.actions || ['musicUrl'])], qualitys: [] }
      }
      const qs = new Set([...merged[key].qualitys, ...(cfg.qualitys || [])])
      merged[key].qualitys = __QUALITY_ORDER.filter((q) => qs.has(q)).concat([...qs].filter((q) => !__QUALITY_ORDER.includes(q)))
      merged[key].actions = [...new Set([...merged[key].actions, ...(cfg.actions || [])])]
    }
  }
  return merged
}

const __embeddedHandlers = [
  ${handlerList},
]

const { EVENT_NAMES: __EVENT_NAMES, on: __on, send: __send } = globalThis.lx

__on(__EVENT_NAMES.request, async (payload) => {
  const action = payload && payload.action
  let lastError = null
  for (const handler of __embeddedHandlers) {
    try {
      const result = await handler(payload)
      if (action === 'musicUrl') {
        const url = typeof result === 'string' ? result : result && result.url
        if (typeof url === 'string' && /^https?:\\/\\//i.test(url.trim())) return result
        lastError = new Error('embedded source returned no usable url')
        continue
      }
      return result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('all embedded sources failed')
})

__send(__EVENT_NAMES.inited, { status: true, openDevTools: false, sources: __mergeSources() })
`
}

export async function buildAggregatedSource() {
  const prepared = []
  for (const entry of SOURCES) {
    prepared.push(await prepareSource(entry))
  }
  const shimDecls = SOURCES.map(
    (s) => `const ${s.embedded} = __createShim()\nconst ${s.shim} = ${s.embedded}.shim`,
  ).join('\n')
  const parts = [wrapperHeader(), `${shimDecls}\n`]
  for (const { entry, code } of prepared) {
    parts.push(
      `\n// ============ 内嵌脚本：${entry.label}（独立作用域，见 SOURCES 表） ============\n;(function () {\n${code}\n})();\n`,
    )
  }
  parts.push(wrapperFooter())
  const out = parts.join('\n')
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true })
  await fs.writeFile(OUT_PATH, out, 'utf8')
  return {
    outPath: OUT_PATH,
    bytes: Buffer.byteLength(out, 'utf8'),
    sources: prepared.map((p) => ({ id: p.entry.id, file: p.entry.file, blanked: p.blanked })),
  }
}

async function main() {
  const result = await buildAggregatedSource()
  console.log(`聚合音源已生成：public/aggregated-sources.js（${result.bytes} 字节）`)
  for (const s of result.sources) {
    console.log(`  内嵌：${s.id}（${s.file}）${s.blanked.length ? `，已置空密钥常量：${s.blanked.join(', ')}` : ''}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('BUILD FAILED:', err.message)
    process.exit(1)
  })
}
