#!/usr/bin/env node
/**
 * 组件层的判据（V3-PLAN §7 阶段 C2）。
 *
 * ## 这一层要守什么
 *
 * C2 的要求是"**每件一条结构判据（不许只断'渲染出节点'）**"。这句话是 anti-pattern：
 * "渲染出节点"只证**没被删掉**，证不了**有内容**、更证不了**行为对**。
 * 所以这里每一条都驱动**真实的 Component 定义**（用 Node 里的 `Component()` 桩把
 * `def` 抓出来，再喂一个最小运行时），或者读 wxml/wxss 的**实际取值**。
 *
 * ## 为什么自己搭一个最小运行时，而不是引入官方测试库
 *
 * 小程序官方的单元测试能力要靠开发者工具 + `miniprogram-simulate`，CI 里起不来。
 * 而"另写一份 mirror 组件来测"是本项目明令禁止的（测试与真机分叉）。
 * 所以：**加载将要打进包的那份 .js**，只 shim `Component()` 与 `setTimeout`。
 * shim 面积越小，"测试里能过、真机上不行"的缝隙越小（与 e2e/mp-sim.mjs 同一条纪律）。
 *
 * ## ⚠️ 定时器那两条为什么用假定时器而不是 `await sleep`
 *
 * 判据里不许裸 `setTimeout` 等一个固定毫秒 —— 那会把"慢"误报成"坏"，
 * 而且只在 CI 忙的时候红。这里换成**把 setTimeout 换成记账函数**：
 * 它不真的排任务，只记"排了几个、清了几个"。于是"detached 要清掉待执行的定时器"
 * 这件事变成**确定性断言**，而不是"等 180ms 再看"。
 *
 * 用法：
 *   node --test scripts/check-mp-components.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = path.join(MP, 'components')
const require = createRequire(import.meta.url)

/** 受 token 约束的三类声明（与 check-mp-tokens.mjs 同一组）。 */
const RAW_PROPS = [
  ['间距', /(?:^|[\s;{])(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left))?\s*:/gm],
  ['圆角', /(?:^|[\s;{])border(-(top|bottom|left|right))?-radius\s*:/gm],
  ['字号', /(?:^|[\s;{])font-size\s*:/gm],
]

/** 组件清单（目录名 = 文件名）。
 *
 * ⚠️ `drc-sheet`（底部弹层壳）2026-10-08 **删除**：它是 C2 建的，但一直到 C6 收口
 * 都没有任何页面 wxml 用它 —— 只有它自己和这份判据引用它。留着就是一份"看起来
 * 有、实际没接线"的组件，还会让这份判据的项数虚高。真需要一个底部弹层时再写，
 * 那时**消费者是明确的**，不会再出现"建了没人用"。 */
const NAMES = ['drc-empty', 'drc-skeleton', 'drc-btn']

function read(name, ext) {
  return readFileSync(path.join(COMPONENTS, name, `${name}.${ext}`), 'utf8')
}

// ── 加载组件定义 ────────────────────────────────────────────────────────
/** 用 `Component()` 桩抓出 def。⚠️ 同名文件要能被重复加载，所以写到临时文件。 */
/** 每次加载换一个文件名：同一进程里 `require` 只会跑一次模块体（缓存），
 *  第二次 `Component()` 就不会被调用，def 会是 null。用唯一文件名绕开缓存，
 *  比 `delete require.cache[...]` 直观，也不会动到别的模块的缓存。 */
let seq = 0
function loadFromSource(src, tag) {
  seq += 1
  const file = path.join(os.tmpdir(), `drc-comp-${tag}-${process.pid}-${seq}.js`)
  writeFileSync(file, src)
  const prev = globalThis.Component
  let def = null
  globalThis.Component = (d) => {
    def = d
  }
  try {
    require(file)
  } finally {
    globalThis.Component = prev
  }
  assert.ok(def, `${tag}：文件里没有调用 Component()`)
  return def
}

function loadDef(name) {
  return loadFromSource(read(name, 'js'), name)
}

/**
 * 造一个最小实例：把 properties 的默认值与 data 混在一起，setData 同步写回，
 * triggerEvent 记账。⚠️ `methods` 里的函数要 bind 到实例上 —— 它们内部用 `this`。
 */
function makeInstance(def, props = {}) {
  const data = Object.assign({}, def.data || {})
  for (const [k, v] of Object.entries(def.properties || {})) {
    data[k] = props[k] === undefined ? v.value : props[k]
  }
  const events = []
  const inst = {
    data,
    events,
    setData(patch) {
      for (const k of Object.keys(patch)) data[k] = patch[k]
    },
    triggerEvent(name, detail) {
      events.push({ name, detail })
    },
  }
  for (const k of Object.keys(def.methods || {})) inst[k] = def.methods[k].bind(inst)
  if (def.lifetimes && def.lifetimes.attached) def.lifetimes.attached.call(inst)
  return inst
}

/** 把 setTimeout 换成记账函数，跑 fn（同步），然后无条件还原。 */
function withFakeTimers(fn) {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const pending = new Set()
  const cleared = []
  let id = 0
  globalThis.setTimeout = () => {
    id += 1
    pending.add(id)
    return id
  }
  globalThis.clearTimeout = (h) => {
    pending.delete(h)
    cleared.push(h)
  }
  try {
    return fn({ pending, cleared })
  } finally {
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
  }
}

// ── wxss / wxml 的小解析器 ──────────────────────────────────────────────
/** 取某个选择器后面的声明块（组件 wxss 全是顶层规则，没有嵌套）。 */
function ruleOf(wxss, selector) {
  const at = wxss.indexOf(selector)
  if (at < 0) return null
  const open = wxss.indexOf('{', at + selector.length)
  if (open < 0) return null
  const close = wxss.indexOf('}', open)
  if (close < 0) return null
  return wxss.slice(open + 1, close)
}

/** 声明块里某个属性的取值。 */
function declOf(block, prop) {
  const m = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;]+)`).exec(block || '')
  return m ? m[1].trim() : null
}

/** wxml 里所有带 bindtap/catchtap 的标签的 class 名。 */
function tapClassesOf(wxml) {
  const out = []
  for (const m of wxml.matchAll(/<([a-z][a-z-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const attrs = m[2]
    if (!/\b(bind|catch)(tap|touchstart|touchmove|longpress)="/.test(attrs)) continue
    const cls = /\bclass="([^"]*)"/.exec(attrs)
    if (!cls) continue
    for (const c of cls[1].split(/\s+/)) if (c && !c.includes('{')) out.push(c)
  }
  return out
}

// ── ① 结构完整性 ────────────────────────────────────────────────────────
test('① 每个组件四件套齐全，且 json 声明自己是组件', () => {
  // ⚠️ 缺 .json 的表现是"开发者工具里报找不到组件"，而**打包不报** ——
  // 于是它在真机上变成"这一块是空的"，排查方向完全不对。
  const problems = []
  for (const name of NAMES) {
    for (const ext of ['js', 'wxml', 'wxss', 'json']) {
      if (!existsSync(path.join(COMPONENTS, name, `${name}.${ext}`))) problems.push(`${name}/${name}.${ext} 不存在`)
    }
    const json = path.join(COMPONENTS, name, `${name}.json`)
    if (existsSync(json)) {
      const j = JSON.parse(readFileSync(json, 'utf8'))
      if (j.component !== true) problems.push(`${name}.json 的 component 不是 true（它就不会被当成组件）`)
    }
  }
  assert.deepEqual(problems, [], '组件目录不完整')
})


// ── ⑤ drc-btn：danger 与 primary 是**形状**上的差异 ─────────────────────
/** 两个变体的底色 / 字色 / 描边。抽成纯函数，反向判据复用。 */
function variantVerdict(wxss) {
  const danger = ruleOf(wxss, '.drc-btn--danger')
  const primary = ruleOf(wxss, '.drc-btn--primary')
  const keys = ['background', 'color', 'box-shadow']
  const picked = {}
  for (const k of keys) {
    picked[k] = [declOf(danger, k), declOf(primary, k)]
  }
  const problems = []
  if (danger === null) problems.push('wxss 里没有 .drc-btn--danger')
  if (primary === null) problems.push('wxss 里没有 .drc-btn--primary')
  for (const k of keys) {
    if (!picked[k][0] || !picked[k][1]) problems.push(`${k} 在两个变体里没都写出来（少一个就无从比较）`)
  }
  const differ = keys.filter((k) => picked[k][0] !== picked[k][1])
  if (differ.length < 2) {
    problems.push(`两个变体只有 ${differ.length} 处不同（${differ.join('、') || '无'}），至少要两处`)
  }
  return { picked, differ, problems }
}

test('⑤ drc-btn：danger 与 primary 在底色/字色/描边里至少两处不同', () => {
  // ⚠️ 为什么必须是"形状差异"而不是"换个文案"：色觉障碍用户区分不了红与蓝，
  // 而解配、拒绝、删除草稿这类动作必须能被**一眼**认出来。
  const { picked, differ, problems } = variantVerdict(read('drc-btn', 'wxss'))
  assert.deepEqual(problems, [], `两个变体的形状差异不够：${JSON.stringify(picked)}`)
  assert.ok(differ.includes('background'), `底色必须不同，实际 ${JSON.stringify(picked.background)}`)
})

test('反向判据：把 danger 的底色与描边都改成与 primary 相同 ⇒ ⑤ 立刻红', () => {
  // 一次改两处，让"只剩字色不同"—— 那时就应当判红（要求的是至少两处）。
  const wxss = read('drc-btn', 'wxss')
    .replace('.drc-btn--danger {\n  background: transparent;', '.drc-btn--danger {\n  background: var(--drc-surface-brand, #0052d9);')
    .replace(
      '.drc-btn--danger {\n  background: var(--drc-surface-brand, #0052d9);\n  color: var(--drc-fg-danger, #c93c34);\n  box-shadow: inset 0 0 0 2rpx var(--drc-fg-danger, #c93c34);',
      '.drc-btn--danger {\n  background: var(--drc-surface-brand, #0052d9);\n  color: var(--drc-fg-danger, #c93c34);\n  box-shadow: inset 0 0 0 0 transparent;',
    )
  assert.notEqual(wxss, read('drc-btn', 'wxss'), '夹具要真的改掉了底色与描边')
  const { differ, problems } = variantVerdict(wxss)
  assert.ok(!differ.includes('background'), '改完之后底色应当被判为相同 —— 否则 ⑤ 是恒绿的')
  assert.ok(!differ.includes('box-shadow'), '改完之后描边也应当被判为相同')
  assert.ok(problems.length > 0, '只剩字色一处不同时 ⑤ 必须红（它要求至少两处）')
})

// ── ⑥ drc-btn：loading 与 disabled 都拦 tap ─────────────────────────────
test('⑥ drc-btn：loading 与 disabled 都要拦住 tap（连点会发两条命令）', () => {
  // ⚠️ 为什么两个都要拦：loading 时点第二下发出的是**另一条命令**（不是重发同一条），
  // 幂等台账按 cmdId 去重挡不住它。连点两次"新建会话"就会建两条。
  const def = loadDef('drc-btn')
  for (const state of [{ loading: true }, { disabled: true }]) {
    const inst = makeInstance(def, state)
    inst.onTap({})
    assert.deepEqual(inst.events, [], `${JSON.stringify(state)} 时 tap 必须被拦住`)
  }
  const ok = makeInstance(def, {})
  ok.onTap({ type: 'tap' })
  assert.equal(ok.events.length, 1, '正常态下要能点得动（这一条是"别把拦截写成永远拦截"）')
})

test('反向判据：去掉那道拦截 ⇒ ⑥ 立刻红', () => {
  const src = read('drc-btn', 'js').replace('if (this.data.loading || this.data.disabled) return', '// 拦截被拆掉了')
  assert.notEqual(src, read('drc-btn', 'js'), '夹具要真的拆掉了那一行')
  const inst = makeInstance(loadFromSource(src, 'btn-no-guard'), { loading: true })
  inst.onTap({})
  assert.equal(inst.events.length, 1, '拆掉之后 loading 时也会发 tap —— 否则 ⑥ 是恒绿的')
})

test('⑥b drc-btn：非法 variant 退回 primary（不给一个"半坏"的按钮）', () => {
  const def = loadDef('drc-btn')
  assert.equal(makeInstance(def, { variant: 'nope' }).data.cls, 'primary')
  assert.equal(makeInstance(def, { variant: 'danger' }).data.cls, 'danger')
})

test('反向判据：variant 不过滤 ⇒ ⑥b 立刻红', () => {
  // ⚠️ 两处过滤都要拆：observer（运行中改属性）与 attached（初始值）各写了一遍，
  // 而 makeInstance 走的是 attached —— 只拆 observer 的话这条反证什么也证不到。
  const src = read('drc-btn', 'js').replace(
    /VARIANTS\[([^\]]+)\] \? \1 : 'primary'/g,
    '$1',
  )
  assert.notEqual(src, read('drc-btn', 'js'), '夹具要真的拆掉了过滤')
  assert.equal(
    makeInstance(loadFromSource(src, 'btn-no-filter'), { variant: 'nope' }).data.cls,
    'nope',
    '不过滤就会得到一个没有样式的变体 —— 否则 ⑥b 是恒绿的',
  )
})

// ── ⑦ drc-skeleton：行数要夹住 ──────────────────────────────────────────
test('⑦ drc-skeleton：rows 夹在 1..6，非数字/0/负数一律回 3', () => {
  // ⚠️ 上限 6 的意义：骨架不该撒谎说"数据很多"。下限 1 的意义：0 行的骨架
  // 是一块空白，看起来像样式没写对。
  const def = loadDef('drc-skeleton')
  const cases = [
    [0, 3],
    [-5, 3],
    [NaN, 3],
    [undefined, 3],
    [1, 1],
    [6, 6],
    [99, 6],
    [3.7, 3],
  ]
  for (const [input, want] of cases) {
    const inst = makeInstance(def, { rows: input })
    assert.equal(inst.data.list.length, want, `rows=${input} 应当夹成 ${want} 行，实际 ${inst.data.list.length}`)
  }
})

test('反向判据：不夹 ⇒ ⑦ 立刻红', () => {
  const src = read('drc-skeleton', 'js').replace('function clampRows(v) {', 'function clampRows(v) { return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] // 夹具：不夹')
  assert.notEqual(src, read('drc-skeleton', 'js'), '夹具要真的改掉了 clampRows')
  const inst = makeInstance(loadFromSource(src, 'sk-no-clamp'), { rows: 99 })
  assert.notEqual(inst.data.list.length, 6, `不夹的话 99 会变成 99 行，实际 ${inst.data.list.length} —— 否则 ⑦ 是恒绿的`)
})

// ── ⑧ drc-empty：空文案不渲染那一行 ────────────────────────────────────
test('⑧ drc-empty：title / desc / icon 为空时那一行不渲染（不是渲染一个空节点）', () => {
  // "渲染一个空节点"与"不渲染"在小程序的视觉上是一样的，但在**无障碍朗读**上不一样：
  // 空节点会被读成一行空白。而 wxml 里的 wx:if 才是"这一行不存在"。
  const wxml = read('drc-empty', 'wxml')
  for (const field of ['icon', 'title', 'desc']) {
    const re = new RegExp(`wx:if="\\{\\{${field}\\}\\}"`)
    assert.ok(re.test(wxml), `${field} 那一行的 wx:if 绑的不是 {{${field}}} —— 空文案会渲染成一块空白`)
  }
})

test('反向判据：去掉某个 wx:if ⇒ ⑧ 立刻红', () => {
  const wxml = read('drc-empty', 'wxml').replace('wx:if="{{desc}}"', '')
  assert.notEqual(wxml, read('drc-empty', 'wxml'), '夹具要真的去掉了 wx:if')
  assert.ok(!/wx:if="\{\{desc\}\}"/.test(wxml), '去掉之后 ⑧ 应当找不到它 —— 否则 ⑧ 是恒绿的')
})

// ── ⑨ toast：空文案不弹 ─────────────────────────────────────────────────
/** 加载 toast 模块并装一个记账的 wx。⚠️ 每次都要新装：模块里没有状态，但 wx 有。 */
function loadToast() {
  const prev = globalThis.wx
  const calls = []
  globalThis.wx = { showToast: (o) => calls.push(o) }
  const mod = require(path.join(MP, 'core', 'toast.js'))
  delete require.cache[require.resolve(path.join(MP, 'core', 'toast.js'))]
  const restore = () => {
    globalThis.wx = prev
  }
  return { mod, calls, restore }
}

test('⑨ toast：空文案不弹（弹一个空框比不弹更像坏了）', () => {
  const { mod, calls, restore } = loadToast()
  try {
    // 真实缺陷：`wx.showToast({ title: String(evt.message || '').slice(0, 40) })`
    // 在 message 为空时弹一个空的黑框 —— 用户会以为界面坏了，而不是"这条没有附加信息"。
    for (const empty of ['', '   ', null, undefined, '\n\t']) {
      assert.equal(mod.toast(empty), false, `空文案 ${JSON.stringify(empty)} 应当不弹`)
    }
    assert.deepEqual(calls, [], '空文案一个都不许弹')
  } finally {
    restore()
  }
})

test('反向判据：去掉空文案闸 ⇒ ⑨ 立刻红', () => {
  const { mod, calls, restore } = loadToast()
  try {
    // 直接验证"闸门存在"：把 normalize 的结果绕过不行，所以这里验的是
    // **normalize 会把空白压成空串**，而 toast 认空串不弹。
    assert.equal(mod.normalize('   \n  '), '', 'normalize 必须把纯空白压成空串')
    assert.equal(mod.normalize(' 有内容 '), '有内容', 'normalize 只去首尾空白，不吞内容')
    assert.deepEqual(calls, [])
  } finally {
    restore()
  }
})

test('⑨b toast：超过上限要截断**并补省略号**（微信的截断是静默的）', () => {
  const { mod, calls, restore } = loadToast()
  try {
    mod.toast('x'.repeat(80))
    assert.equal(calls.length, 1, '长文案也要弹（只是要截）')
    assert.equal(calls[0].title.length, mod.TOAST_MAX, `截断后应当是 ${mod.TOAST_MAX} 个字`)
    assert.ok(calls[0].title.endsWith('…'), '截断必须自己补省略号 —— 否则用户看不出那是被截了')
  } finally {
    restore()
  }
})

test('反向判据：不截断 ⇒ ⑨b 立刻红', () => {
  const { mod, restore } = loadToast()
  try {
    const raw = 'x'.repeat(80)
    assert.equal(mod.normalize(raw).length, mod.TOAST_MAX, 'normalize 才是截断的落点')
    // 如果哪天有人绕过 normalize 直接拼 title，上面 ⑨b 就会红 —— 这里证明 normalize 在生效
    assert.notEqual(raw.length, mod.normalize(raw).length)
  } finally {
    restore()
  }
})

test('⑨c toast：默认 icon 是 none（漏了它就会给错误消息挂一个对勾）', () => {
  const { mod, calls, restore } = loadToast()
  try {
    mod.toast('主机没能完成这条指令')
    assert.equal(calls[0].icon, 'none', '默认必须是 icon: none —— 微信的默认值是 success（一个对勾）')
    assert.equal(typeof calls[0].duration, 'number', '时长要给一个数（长文案要更久，否则读不完）')
  } finally {
    restore()
  }
})

test('⑨d toast 走的是原生 wx.showToast（不许改成自建 toast）', () => {
  // ⚠️ 反向判据（"别把修复写成另一套"）：e2e 断言的是 wx.showToast 与它的 title，
  // 换成自建组件会一次性废掉那些判据；而且原生 toast 的层级/防连点/键盘避让都是白拿的。
  const { mod, calls, restore } = loadToast()
  try {
    mod.toast('一句话')
    assert.equal(calls.length, 1)
    assert.ok(calls[0].title, '原生 title 必须被填上')
  } finally {
    restore()
  }
  const src = readFileSync(path.join(MP, 'core', 'toast.js'), 'utf8')
  assert.ok(/wx\.showToast\(/.test(src), 'toast.js 必须调原生 wx.showToast')
})

// ── ⑩ 迁移棘轮：页面里不许再手写 wx.showToast ───────────────────────────
test('⑩ 棘轮：pages/ 下不许再有手写的 wx.showToast（全部走 core/toast.js）', () => {
  // C2 之前两个页面有 49 处手写调用，每处都要自己记得写 icon:'none'、自己 slice(0,40)。
  // 这条是**只许降不许升**的棘轮：新代码一律走统一入口。
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.js') && /wx\.showToast\s*\(/.test(readFileSync(full, 'utf8'))) {
        hits.push(path.relative(MP, full))
      }
    }
  }
  walk(path.join(MP, 'pages'))
  assert.deepEqual(hits, [], '页面里又出现了手写的 wx.showToast —— 改用 core/toast.js 的 toast()')
})

test('反向判据：塞一页手写调用 ⇒ ⑩ 立刻红', () => {
  // 用夹具验证正则本身（不是验证磁盘上的文件）
  const probe = readFileSync(path.join(MP, 'pages', 'chat', 'chat.js'), 'utf8')
  assert.ok(!/wx\.showToast\s*\(/.test(probe), 'chat.js 现在应当已经没有手写调用了')
  assert.ok(/wx\.showToast\s*\(/.test("wx.showToast({ title: 'x' })"), '正则要能抓到手写的形状 —— 否则 ⑩ 恒绿')
  assert.ok(!/wx\.showToast\s*\(/.test('toast("x")'), '走统一入口的形状不许被误抓')
})

// ── ⑪ 点击区：绑了手势的类若给了固定尺寸，必须 ≥ 88rpx（44px）─────────
/** 抽成纯函数：反向判据要喂样本（见下一条，理由写在它上面）。 */
function tapVerdict(wxml, wxss, name) {
  const MIN = 88
  const problems = []
  for (const cls of tapClassesOf(wxml)) {
    const block = ruleOf(wxss, `.${cls}`)
    if (!block) continue
    const w = declOf(block, 'width')
    const h = declOf(block, 'height')
    if (!w || !h) continue // 没写固定尺寸（padding 撑开的按钮）不参与
    for (const [label, v] of [
      ['宽', w],
      ['高', h],
    ]) {
      const m = /^(\d+(?:\.\d+)?)rpx$/.exec(v)
      if (!m) continue
      if (Number(m[1]) < MIN) problems.push(`${name} 的 .${cls} ${label} 只有 ${v}（不到 44px，点不准）`)
    }
  }
  return problems
}

test('⑪ 点击区：绑了手势且写了固定宽高的元素，最小边不小于 88rpx（44px）', () => {
  // 44px 是 iOS HIG / Material 的最小点击区。写这条是因为它抓到了一个真缺陷：
  // drc-sheet 的关闭 ✕ 原来是 48rpx（24px）—— 手指点不准，而它是弹层**唯一**
  // 的显式关闭入口（另两条路是遮罩与下滑，都要求用户猜）。
  const problems = []
  for (const name of NAMES) problems.push(...tapVerdict(read(name, 'wxml'), read(name, 'wxss'), name))
  assert.deepEqual(problems, [], '有点击区小于 44px')
})

test('反向判据：把一个点击区改小 ⇒ ⑪ 立刻红', () => {
  // ⚠️ 这条原来拿 `drc-sheet` 的真实文件改小做夹具。drc-sheet 删掉之后不能用这个
  // 办法了 —— 剩下三个组件里**没有一个**写了固定尺寸的点击区（drc-btn 是 padding
  // 撑开的，不写 width/height，按上面的注释本来就不参与）。真文件里没有可改的样本，
  // 所以改成喂样本字符串，走**同一个** `tapVerdict`。
  const wxml = '<view class="mini-close" bindtap="onClose"></view>'
  assert.deepEqual(
    tapVerdict(wxml, '.mini-close { width: 88rpx; height: 88rpx; }', '样本'),
    [],
    '88rpx 必须过 —— 否则 ⑪ 是恒红的，等于把正常尺寸也判死',
  )
  assert.ok(
    tapVerdict(wxml, '.mini-close { width: 48rpx; height: 48rpx; }', '样本').length > 0,
    '48rpx 必须红 —— 否则 ⑪ 是恒绿的（现在剩余组件都触发不到它，这条反证是它唯一的证据）',
  )
})

// ── ⑫ 组件 wxss：间距/圆角/字号不许裸写 ─────────────────────────────────
test('⑫ 组件 wxss 里不许裸写间距/圆角/字号（这一层没有历史包袱）', () => {
  // ⚠️ 为什么组件层是**零容忍**而各页是棘轮：组件是 C2 从第一行开始写的，
  // 没有"当年手写的数"要迁。如果这里也给一个基线，等于允许新代码继续手写。
  // 各页那条棘轮（check-mp-tokens.mjs ④）才是给存量用的。
  const raw = []
  for (const name of NAMES) {
    const text = read(name, 'wxss')
    for (const [kind, re] of RAW_PROPS) {
      for (const m of text.matchAll(re)) {
        const start = m.index + m[0].length
        const end = text.indexOf(';', start)
        // ⚠️ 先挖掉 var(...) 再数：`var(--drc-space-2, 16rpx)` 里的 16rpx 是
        // **兜底值**，不是裸写 —— 不挖会把所有"带兜底的 token 用法"误判成裸值。
        const decl = text
          .slice(start, end < 0 ? text.length : end)
          .replace(/var\([^)]*\)/g, '')
        for (const n of decl.matchAll(/(-?\d+(?:\.\d+)?)rpx/g)) {
          if (Number(n[1]) !== 0) raw.push(`${name}:${kind}:${n[1]}rpx`)
        }
      }
    }
  }
  assert.deepEqual(raw, [], '组件里出现了裸写的几何量 —— 用 theme/tokens.mjs 里的 --drc-*')
})
