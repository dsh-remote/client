#!/usr/bin/env node
/**
 * 设计 token 层的判据（V3-PLAN §7 阶段 C1）。
 *
 * ## 它守的四件事
 *
 * ① **表是唯一来源**：`theme/tokens.mjs` 里的每一项都必须出现在两份生成物里，
 *    且值逐字相等。少一项 ⇒ wxss 里那个 `var()` 取到空值（**静默**：不报错，
 *    只是那一处没有间距/没有圆角，界面上看成"忘了写"）。
 * ② **不许用表里没有的 `--drc-*`**：拼错一个名字同样静默失效。
 * ③ **几何量必须在网格上**（生成期已挡一次，这里挡的是"有人手改了生成物"）。
 * ④ **棘轮**：各页 wxss 里**裸写**的间距/圆角/字号字面量，数量只许降不许升。
 *
 * ## 为什么第 ④ 条是棘轮而不是"清零"
 *
 * C1 只负责**建立**这一层；把二十几个文件迁过去是 C3–C6 的事。
 * 如果这里直接要求"零裸值"，它会从落地的第一秒就红 —— 而一条一直红的判据
 * 等于没有判据（**红久了就没人看**，这是本项目栽过的）。
 * 所以：基线 = 落地时的实测值，**多了立刻红**（不许再新增手写的数），
 * **少了也红**（逼你把基线降下来，否则它会一直允许回到那个更高的数）。
 * ⇒ 迁移一步，就把这个数字拧一格。
 *
 * 用法：
 *   node --test scripts/check-mp-tokens.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TOKENS,
  GEOMETRY_GROUPS,
  TYPE_GROUPS,
  GRID_RPX,
  TYPE_STEP_RPX,
  PAIRS,
} from '../theme/tokens.mjs'

const MP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 裸值基线（**棘轮**）：落地时的实测处数。
 *
 * ⚠️ 改这个数的唯一正当理由：迁移了一处，实测变少了 —— 那就把它**降**下来。
 * 往上升等于"允许再手写几个数"，那正是这一层要消灭的东西。
 */
const RAW_BASELINE = 257

/** 受 token 约束的三类声明。 */
const GEOMETRY_PROPS = /(^|[\s;])(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?\s*:/m
const RADIUS_PROPS = /(^|[\s;])border(-(top|bottom|left|right))?-radius\s*:/m
const TYPE_PROPS = /(^|[\s;])font-size\s*:/m

/** 收集所有页面/全局 wxss（**不含 theme/**：那是生成物，裸值本来就该为 0）。 */
function wxssFiles() {
  const out = [path.join(MP, 'app.wxss')]
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.wxss')) out.push(full)
    }
  }
  walk(path.join(MP, 'pages'))
  return out.filter((f) => !f.includes(`${path.sep}theme${path.sep}`)).sort()
}

/** 抽出某个文件里 `--x: y` 的声明（生成物是一行，按 `;` 切）。 */
function declarationsOf(text) {
  const map = new Map()
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/g)) {
    map.set(m[1], m[2].trim())
  }
  return map
}

/** 某个属性声明里出现的 `Nrpx` 字面量（不含 0 与 var()）。 */
function rawRpxIn(text, propRe) {
  const out = []
  const re = new RegExp(propRe.source.replace('(^|[\\s;])', '(?:^|[\\s;{])'), 'gm')
  for (const m of text.matchAll(re)) {
    // 从声明起点吃到分号
    const start = m.index + m[0].length
    const end = text.indexOf(';', start)
    const decl = text.slice(start, end < 0 ? text.length : end)
    for (const n of decl.matchAll(/(-?\d+(?:\.\d+)?)rpx/g)) out.push(Number(n[1]))
  }
  return out
}

const light = readFileSync(path.join(MP, 'theme/light.wxss'), 'utf8')
const dark = readFileSync(path.join(MP, 'theme/dark.wxss'), 'utf8')
const sources = wxssFiles().map((f) => ({ file: path.relative(MP, f), text: readFileSync(f, 'utf8') }))

test('① 表里的每一个 token 都在两份生成物里，且值逐字相等', () => {
  // ⚠️ 两份都要查：深色那份挂在 .theme-dark 上，**只有切到深色才会用到**。
  // 少在深色里声明一项的表现是"浅色下好好的、深色下那一处突然没间距"，
  // 而没人会在浅色下发现。
  const lightDecls = declarationsOf(light)
  const darkDecls = declarationsOf(dark)
  const missing = []
  const mismatched = []
  for (const t of TOKENS) {
    if (lightDecls.get(t.name) !== t.value) {
      missing.push(`${t.name} 不在 light.wxss 里或值不等于表里的 ${t.value}（实际 ${lightDecls.get(t.name) ?? '没有'}）`)
    }
    if (darkDecls.get(t.name) !== t.value) {
      mismatched.push(`${t.name} 不在 dark.wxss 里或值不等于表里的 ${t.value}（实际 ${darkDecls.get(t.name) ?? '没有'}）`)
    }
  }
  assert.deepEqual(
    [...missing.map((m) => `浅色：${m}`), ...mismatched.map((m) => `深色：${m}`)],
    [],
    '生成物与 token 表不一致 —— 跑一下 node scripts/gen-mp-theme.mjs；\n' +
      '   若你刚改了表，确认改的是 theme/tokens.mjs 而不是生成物（生成物改了会被覆盖，且没人会注意到）。',
  )
})

test('② wxss 里用到的每一个 --drc-* 都在表里（拼错名字是静默失效）', () => {
  const known = new Set(TOKENS.map((t) => t.name))
  const unknown = []
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/var\(\s*(--drc-[a-z0-9-]+)/g)) {
      if (!known.has(m[1])) unknown.push(`${file} 用了 ${m[1]}，而 token 表里没有这一项`)
    }
  }
  assert.deepEqual([...new Set(unknown)], [], '出现了表里没有的 --drc-*（var() 会取到空值，且不报错）')
})

test('③ 生成物里的几何量仍在网格上（挡"手改生成物"）', () => {
  // 生成期已经挡过一次表；这一条挡的是有人直接改了 theme/*.wxss
  // —— 生成物头注写了"不要手改"，但头注拦不住手。
  const problems = []
  for (const [label, text] of [['light.wxss', light], ['dark.wxss', dark]]) {
    for (const t of TOKENS) {
      if (!GEOMETRY_GROUPS.includes(t.group) && !TYPE_GROUPS.includes(t.group)) continue
      const m = new RegExp(`${t.name}\\s*:\\s*([^;{}]+)`).exec(text)
      const v = m ? m[1].trim() : ''
      const num = /^(\d+(?:\.\d+)?)rpx$/.exec(v)
      if (!num) continue // var() 引用或 0，不参与网格
      const n = Number(num[1])
      const step = GEOMETRY_GROUPS.includes(t.group) ? GRID_RPX : TYPE_STEP_RPX
      if (t.grid === 'exempt') continue
      if (n % step !== 0) problems.push(`${label} 的 ${t.name} = ${v}，不是 ${step}rpx 的整数倍`)
    }
  }
  assert.deepEqual(problems, [], '生成物被手改过（或表与生成物不同步）—— 重新生成，别手改')
})

test('④ 棘轮：各页裸写的间距/圆角/字号只许减少，不许增加', () => {
  const raw = []
  for (const { file, text } of sources) {
    for (const [kind, re] of [
      ['间距', GEOMETRY_PROPS],
      ['圆角', RADIUS_PROPS],
      ['字号', TYPE_PROPS],
    ]) {
      for (const n of rawRpxIn(text, re)) raw.push({ file, kind, n })
    }
  }
  assert.ok(
    raw.length <= RAW_BASELINE,
    `裸写的字面量从 ${RAW_BASELINE} 处涨到了 ${raw.length} 处 —— ` +
      `新增的这些应当用 --drc-* token（表在 theme/tokens.mjs）。\n` +
      `   明细：${raw.slice(0, 12).map((r) => `${r.file}:${r.kind}:${r.n}rpx`).join('、')}`,
  )
  assert.equal(
    raw.length,
    RAW_BASELINE,
    `裸写只剩 ${raw.length} 处，比基线 ${RAW_BASELINE} 少 —— 迁移了一处就把 RAW_BASELINE 降下来，` +
      '否则它会一直允许回到那个更高的数（棘轮只能往一个方向拧）。',
  )
})

test('⑤ 合法的前景 × 底色搭配都登记在 PAIRS 里，且没有重复的项', () => {
  // ⚠️ 这条的价值在于"不是所有组合都合法"：写进 PAIRS 的每一对都要过对比度闸，
  // 没写进来的不許在 wxss 里出现。所以这里要防的是 PAIRS 自己变松。
  const fgNames = new Set(TOKENS.filter((t) => t.group === 'fg').map((t) => t.name))
  const surfaceNames = new Set(TOKENS.filter((t) => t.group === 'surface').map((t) => t.name))
  const problems = []
  const seen = new Set()
  for (const [fg, bg] of PAIRS) {
    if (!fgNames.has(fg)) problems.push(`${fg} 不是 fg 组的 token（拼错名字 ⇒ 这一对永远不会被验）`)
    if (!surfaceNames.has(bg)) problems.push(`${bg} 不是 surface 组的 token`)
    const key = `${fg}|${bg}`
    if (seen.has(key)) problems.push(`${fg} × ${bg} 登记了两次`)
    seen.add(key)
  }
  assert.deepEqual(problems, [], 'PAIRS 有问题（它会让对比度闸少验或多验）')
  // 反向：每一对 fg 至少要有一个底色搭配，否则那个字色没有任何"合法落点"
  const covered = new Set(PAIRS.map(([fg]) => fg))
  const orphan = [...fgNames].filter((n) => !covered.has(n))
  assert.deepEqual(
    orphan,
    [],
    '这些前景色没有任何登记过的底色搭配 —— 要么补进 PAIRS（并让它过对比度闸），要么删掉这个 token',
  )
})

test('反向判据：表里有而生成物里没有 ⇒ ① 立刻红', () => {
  // 证明 ① 在比对，而不是恒绿
  // ⚠️ `{ ...map }` 展开 Map 得到的是空对象（Map 的条目不是自有可枚举属性）
  // —— 那样 fake 里什么都没有，这条反证会"通过"却什么也没证。
  const fake = new Map(declarationsOf(light))
  fake.delete('--drc-space-3')
  const stillMissing = TOKENS.filter((t) => fake.get(t.name) !== t.value)
  assert.ok(
    stillMissing.some((t) => t.name === '--drc-space-3'),
    '删掉一项之后它应当被判为缺失 —— 否则 ① 是恒绿的',
  )
})

test('反向判据：wxss 里拼错一个 --drc-* ⇒ ② 立刻红', () => {
  const known = new Set(TOKENS.map((t) => t.name))
  const typo = 'var(--drc-space-33)'
  const m = /var\(\s*(--drc-[a-z0-9-]+)/.exec(typo)
  assert.ok(m, '夹具本身要能被那条正则匹配到')
  assert.ok(!known.has(m[1]), '拼错的那个名字确实不在表里 —— 否则这条反证什么也没证')
})

test('反向判据：棘轮的两个方向都会红', () => {
  // 多一处 ⇒ 红；少一处 ⇒ 也红（逼人把基线降下来）
  const rawCount = sources.reduce(
    (sum, { text }) =>
      sum +
      rawRpxIn(text, GEOMETRY_PROPS).length +
      rawRpxIn(text, RADIUS_PROPS).length +
      rawRpxIn(text, TYPE_PROPS).length,
    0,
  )
  assert.equal(rawCount, RAW_BASELINE, `基线本身要等于实测（${rawCount}），否则上面 ④ 永远红或永远绿`)
  assert.ok(rawCount + 1 > RAW_BASELINE, '多一处就该超过基线（这是"只许降"那一半）')
  assert.notEqual(rawCount - 1, RAW_BASELINE, '少一处就该不等于基线（这是"降了要拧棘轮"那一半）')
})
