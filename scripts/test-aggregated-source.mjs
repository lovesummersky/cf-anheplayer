/**
 * 聚合音源测试门：先跑构建器生成 public/aggregated-sources.js，再用仓库
 * 自己的沙箱（scripts/lib/lx-sandbox.mjs）与检测器同一方法实测——同一固定
 * 测试歌曲（《海阔天空》，TEST_SONGS 从 scripts/check-sources.mjs 逐字复制，
 * 该文件未导出它，改动测试歌曲时须同步两处）、同一调用形状、同一 20 秒
 * 超时、同一 Range 拉流校验（verifyAudioUrl）。
 *
 * 对照组：两个原脚本在同一轮次里同样跑一遍。聚合文件任一必填单元格
 * （任一原脚本声明的平台 × 128k/320k）失败即退出码非零，CI 不提交。
 * 对照组自身的失败只记录、不直接判负（例如星海 QQ 无卡密授权失败是已知
 * 的上游限制，聚合文件由另一内嵌脚本兜底才算过）。
 *
 * 真实后端，无 mock。内嵌脚本的健康探测 setTimeout 链会让事件循环永不
 * 为空，故跑完后显式 process.exit()，否则进程挂起、CI 直到超时。
 *
 * 用法：node scripts/test-aggregated-source.mjs [--out results.json]
 */
import fs from 'node:fs/promises'
import { writeSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadLxSourceCode, withTimeout } from './lib/lx-sandbox.mjs'
import { verifyAudioUrl } from './check-sources.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_FILE = path.join(REPO_ROOT, 'public', 'aggregated-sources.js')
const PLATFORM_TIMEOUT = 20000
const QUALITIES = ['128k', '320k']

// 同步输出：stdout 被管道接管时是块缓冲，CI 里跑完直接 process.exit 会丢
// 尾部输出；改走同步写，保证日志完整落盘。
function log(...args) {
  writeSync(1, `${args.map(String).join(' ')}\n`)
}

// 逐字复制自 scripts/check-sources.mjs 的 TEST_SONGS（歌曲：海阔天空）。
const TEST_SONGS = {
  wy: [
    { songmid: 1357375695, id: 1357375695, name: '海阔天空', singer: 'Beyond', albumName: '乐与怒', interval: '05:25', source: 'wy' },
    { songmid: 347230, id: 347230, name: '海阔天空', singer: 'Beyond', albumName: '乐与怒', interval: '05:25', source: 'wy' },
  ],
  tx: [
    { songmid: '001yS0N33yPm1B', strMediaMid: '002MX8Ea4e5RDS', songId: '001yS0N33yPm1B', name: '海阔天空', singer: 'BEYOND', interval: '05:25', source: 'tx' },
    { songmid: '002rZjwv4ddzKt', strMediaMid: '002thQK83lEc2Q', songId: '002rZjwv4ddzKt', name: '海阔天空', singer: '信乐团', interval: '04:29', source: 'tx' },
  ],
  kw: [
    { songmid: 321946135, id: 321946135, hash: 'MUSIC_321946135', name: '海阔天空', singer: 'G.E.M.邓紫棋', interval: '04:23', source: 'kw' },
  ],
  kg: [
    { hash: 'C41E80A18D1448FA47086372999C7F43', FileHash: 'C41E80A18D1448FA47086372999C7F43', songmid: 3261014, id: 3261014, name: '海阔天空', singer: 'BEYOND', interval: '05:25', source: 'kg' },
    { hash: 'E5C40A31C3C16BA461F650035734C123', FileHash: 'E5C40A31C3C16BA461F650035734C123', songmid: 27359949, id: 27359949, name: '海阔天空', singer: 'BEYOND', interval: '05:25', source: 'kg' },
  ],
  mg: [
    { songmid: '6005752DXKE', copyrightId: '6005752DXKE', contentId: '600913000009337537', albumId: '1133556323', name: '海阔天空', singer: 'Beyond', interval: '05:25', source: 'mg' },
    { songmid: '1135162566', id: '1135162566', copyrightId: '6005752DXKE', albumId: '1133556323', name: '海阔天空', singer: 'Beyond', interval: '05:25', source: 'mg' },
  ],
  qs: [
    { id: '6705003948140398594', songmid: '6705003948140398594', name: '海阔天空', singer: 'Beyond', albumName: '华纳我爱经典系列 Beyond', interval: '03:59', source: 'qs' },
    { id: '7676337516358617115', songmid: '7676337516358617115', name: '晴天', singer: '晚风纯音', interval: '03:57', source: 'qs' },
  ],
}

function trimError(error) {
  const text = String((error && error.message) || error || '未知错误').replace(/\s+/g, ' ').trim()
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

function urlHost(url) {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

function cleanMusicInfo(song) {
  return Object.fromEntries(
    Object.entries(song).filter(([, value]) => value !== '' && value !== null && value !== undefined),
  )
}

async function testOne(handler, sourceKey, quality) {
  const candidates = TEST_SONGS[sourceKey] || []
  let lastError = null
  let totalMs = 0
  for (const song of candidates) {
    const started = Date.now()
    try {
      const result = await withTimeout(
        Promise.resolve(
          handler({ source: sourceKey, action: 'musicUrl', info: { type: quality, musicInfo: cleanMusicInfo(song) } }),
        ),
        PLATFORM_TIMEOUT,
        `请求超时（${Math.round(PLATFORM_TIMEOUT / 1000)} 秒）`,
      )
      const url = typeof result === 'string' ? result : result?.url
      if (!url || typeof url !== 'string') {
        lastError = '音源未返回播放地址'
        totalMs += Date.now() - started
        continue
      }
      const stream = await verifyAudioUrl(url)
      totalMs += Date.now() - started
      if (!stream.ok) {
        lastError = stream.error
        continue
      }
      return { ok: true, ms: totalMs, error: null, urlHost: urlHost(url) }
    } catch (error) {
      lastError = trimError(error)
      totalMs += Date.now() - started
    }
  }
  return { ok: false, ms: totalMs, error: lastError || '测试失败', urlHost: null }
}

async function testSubject(label, code, filename) {
  const startedAt = Date.now()
  const loaded = await loadLxSourceCode(code, filename, { initTimeout: 12000 })
  const record = {
    label,
    initOk: loaded.initOk,
    initError: loaded.initError ? trimError(loaded.initError) : null,
    declaredSources: loaded.inited?.sources
      ? Object.fromEntries(
          Object.entries(loaded.inited.sources).map(([k, v]) => [k, v.qualitys || []]),
        )
      : null,
    platforms: {},
    durationMs: 0,
  }
  log(`\n=== ${label} === initOk=${record.initOk}${record.initError ? ` initError=${record.initError}` : ''}`)
  log(`declared: ${JSON.stringify(record.declaredSources)}`)
  if (!record.initOk || typeof loaded.requestHandler !== 'function') {
    record.durationMs = Date.now() - startedAt
    return record
  }
  for (const key of Object.keys(record.declaredSources)) {
    if (!TEST_SONGS[key]) {
      log(`  ${key}: no test song defined, skipped`)
      continue
    }
    record.platforms[key] = {}
    for (const quality of QUALITIES) {
      if (!record.declaredSources[key].includes(quality)) {
        record.platforms[key][quality] = { tested: false, ok: false, ms: null, error: 'quality not declared', urlHost: null }
        continue
      }
      const res = await testOne(loaded.requestHandler, key, quality)
      record.platforms[key][quality] = { tested: true, ...res }
      log(`  ${key} ${quality}: ${res.ok ? 'PASS' : 'FAIL'} ${res.ms}ms ${res.error || ''} ${res.urlHost || ''}`)
    }
  }
  record.durationMs = Date.now() - startedAt
  log(`  (${label} took ${(record.durationMs / 1000).toFixed(1)}s)`)
  return record
}

function cellOf(record, platform, quality) {
  return record.platforms?.[platform]?.[quality] || null
}

async function main() {
  const outFlag = process.argv.indexOf('--out')
  const outPath = outFlag >= 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : null

  // 1. 构建（构建器失败则整个测试门失败）。
  log('--- 构建聚合音源 ---')
  const build = spawnSync(process.execPath, ['scripts/build-aggregated-source.mjs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60000,
  })
  if (build.stdout) log(build.stdout.trimEnd())
  if (build.stderr) log(build.stderr.trimEnd())
  if (build.status !== 0) {
    log('GATE FAILED: 构建器退出码非零')
    process.exit(1)
  }

  const results = { ranAt: new Date().toISOString(), subjects: [] }
  const aggregateCode = await fs.readFile(OUT_FILE, 'utf8')
  const doubaoCode = await fs.readFile(
    path.join(REPO_ROOT, 'sources/标准/lx-source.js'),
    'utf8',
  )
  const xinghaiCode = await fs.readFile(
    path.join(REPO_ROOT, 'sources/优质/xinghai-music-sourcev2.3.20.js'),
    'utf8',
  )

  // 2. 对照组 + 聚合文件，同一轮次顺序实测。
  const doubao = await testSubject('doubao-original', doubaoCode, 'lx-source.js')
  const xinghai = await testSubject('xinghai-original', xinghaiCode, 'xinghai.js')
  const aggregate = await testSubject('aggregate', aggregateCode, 'aggregated-sources.js')
  results.subjects = [doubao, xinghai, aggregate]

  // 3. 判定：聚合文件声明的平台必须是两原脚本的并集；每个必填单元格必须通过。
  const failures = []
  if (!aggregate.initOk) failures.push('聚合文件初始化失败')
  const union = {}
  for (const control of [doubao, xinghai]) {
    for (const [platform, qualitys] of Object.entries(control.declaredSources || {})) {
      union[platform] = [...new Set([...(union[platform] || []), ...qualitys])]
    }
  }
  const declared = aggregate.declaredSources || {}
  for (const platform of Object.keys(union)) {
    const missing = union[platform].filter((q) => !(declared[platform] || []).includes(q))
    if (missing.length) failures.push(`聚合文件未声明 ${platform} 的音质：${missing.join(', ')}`)
  }
  for (const platform of Object.keys(union)) {
    for (const quality of QUALITIES) {
      if (!union[platform].includes(quality)) continue
      const cell = cellOf(aggregate, platform, quality)
      if (!cell?.tested || !cell.ok) {
        failures.push(`${platform} ${quality}：${cell?.error || '未测试'}`)
      }
    }
  }

  // 4. 结果表。
  log('\n=== 结果表（PASS/FAIL） ===')
  const header = ['平台/音质', '豆包原版', '星海原版', '聚合文件']
  log(header.join(' | '))
  let passCount = 0
  let cellCount = 0
  for (const platform of Object.keys(union)) {
    for (const quality of QUALITIES) {
      if (!union[platform].includes(quality)) continue
      cellCount += 1
      const fmt = (record) => {
        const cell = cellOf(record, platform, quality)
        if (!cell?.tested) return '-'
        return cell.ok ? `PASS ${(cell.ms / 1000).toFixed(1)}s` : `FAIL ${cell.error || ''}`
      }
      const aggCell = cellOf(aggregate, platform, quality)
      if (aggCell?.tested && aggCell.ok) passCount += 1
      log(`${platform} ${quality} | ${fmt(doubao)} | ${fmt(xinghai)} | ${fmt(aggregate)}`)
    }
  }
  log(`\n聚合文件：${passCount}/${cellCount} 单元格通过`)

  if (outPath) {
    await fs.writeFile(outPath, JSON.stringify(results, null, 2), 'utf8')
    log(`结果已写入 ${outPath}`)
  }

  if (failures.length) {
    log(`\nGATE FAILED（${failures.length} 项）：`)
    for (const f of failures) log(`  - ${f}`)
    process.exit(1)
  }
  log('\nGATE PASSED')
  process.exit(0)
}

main().catch((err) => {
  log('HARNESS FAILED:', err?.stack || err)
  process.exit(2)
})
