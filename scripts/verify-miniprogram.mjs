/**
 * verify-miniprogram — 不需要微信开发者工具就能做的静态自检。
 *
 * 这个仓库交付的是**小程序源码**，真正的编译与真机行为只有开发者工具能验。
 * 但有一类错误可以在 CI 里零成本拦住：路径写错、JSON 写坏、组件名打错、
 * 破坏了按需注入的前提。它们的共同点是"开发者工具里可能看起来没事，
 * 真机/上传时才炸"，而且全部**静默**——所以值得在这里机械地守一道。
 *
 * 检查项（全部只读，不改任何文件）：
 *   1. 仓库内所有 JSON 能解析（排除 node_modules 与本机私有的 project.private.config.json）；
 *   2. project.config.json 的 miniprogramRoot 指向真实目录；
 *   3. app.json 里的每个页面对应的 .js/.json/.wxml/.wxss 四件套都在；
 *   4. app.json 开着按需注入（lazyCodeLoading=requiredComponents），且**不声明**全局 usingComponents；
 *   5. 每个页面 usingComponents 里的组件路径能解析到文件；
 *   6. 非第三方的小程序 JS 通过 `node --check`（语法级）；
 *   7. **每个 .wxml 的标签配对**（2026-10-08 用户报编译错误后补）。
 *
 * ## 为什么第 7 条是这一天最值钱的
 *
 * 我把一段 wxml 从页面中间挪进另一个容器时，把一句 `<!-- …` 的注释**漏了闭合**，
 * 于是下一个 `<view>` 被吞进注释，标签总数少了一个。
 * 开发者工具报的是 `get tag end without start, near '</view>'` —— 而
 * **前面六条检查全绿**：JSON 能解析、四件套都在、组件路径能解析、JS 语法也对。
 * 也就是说"编译不过"这一整类错误，此前**没有任何一道闸**在看。
 *
 * 只做"能确定对错"的判定。样式、真机交互、主题生效这类只能靠截图与探针的事，
 * 不在这里假装覆盖。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const MP_ROOT = ROOT
const problems = []

/** 只报"断言不成立"，不抛异常——一次跑完把所有问题列清楚。 */
const check = (ok, message) => {
  if (!ok) problems.push(message)
}

// ── 1. 所有 JSON 能解析 ────────────────────────────────────────────────
function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue
      walk(full, onFile)
    } else {
      onFile(full)
    }
  }
}

let jsonCount = 0
walk(ROOT, (file) => {
  if (!file.endsWith('.json')) return
  if (file.endsWith('project.private.config.json')) return // 本机私有，不入库也不检查
  jsonCount += 1
  try {
    JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`${path.relative(ROOT, file)} 不是合法 JSON：${error.message}`)
  }
})

// ── 2. miniprogramRoot ──────────────────────────────────────────────────
const projectConfigPath = path.join(ROOT, 'project.config.json')
let projectConfig = {}
try {
  projectConfig = JSON.parse(readFileSync(projectConfigPath, 'utf8'))
} catch {
  // 已在第 1 项报过
}
const declaredRoot = projectConfig.miniprogramRoot
// v3 起小程序项目根就是包根（与微信默认模板一致），`miniprogramRoot` 为空即包根。
const effectiveRoot = typeof declaredRoot === 'string' && declaredRoot.length > 0 ? declaredRoot : '.'
check(
  existsSync(path.join(ROOT, effectiveRoot)),
  `project.config.json 的 miniprogramRoot (${JSON.stringify(effectiveRoot)}) 指向的目录不存在`,
)

// ── 3/4. app.json ───────────────────────────────────────────────────────
const appJson = JSON.parse(readFileSync(path.join(MP_ROOT, 'app.json'), 'utf8'))
check(
  appJson.lazyCodeLoading === 'requiredComponents',
  'app.json 未开启按需注入（lazyCodeLoading 应为 requiredComponents）——TDesign 全量注入会让首屏多跑上百个组件',
)
check(
  appJson.usingComponents === undefined || Object.keys(appJson.usingComponents).length === 0,
  'app.json 声明了全局 usingComponents——那会让按需注入失效，组件应逐页声明',
)

const PAGE_PIECES = ['.js', '.json', '.wxml', '.wxss']
for (const page of appJson.pages ?? []) {
  for (const ext of PAGE_PIECES) {
    const file = path.join(MP_ROOT, page + ext)
    check(existsSync(file), `app.json 里的页面 ${page} 缺少 ${path.basename(page + ext)}`)
  }
}
check((appJson.pages ?? []).length > 0, 'app.json 的 pages 为空')

// ── 5. 每页 usingComponents 可解析 ──────────────────────────────────────
/** 小程序组件路径：以 `/` 开头是相对项目根的绝对路径，否则是相对本文件。 */
function resolveComponent(pageDir, ref) {
  const base = ref.startsWith('/')
    ? path.join(MP_ROOT, ref.slice(1))
    : path.resolve(pageDir, ref)
  return [`${base}.js`, `${base}.json`].every((f) => existsSync(f))
}

let componentCount = 0
for (const page of appJson.pages ?? []) {
  const pageJsonPath = path.join(MP_ROOT, page + '.json')
  if (!existsSync(pageJsonPath)) continue
  const pageJson = JSON.parse(readFileSync(pageJsonPath, 'utf8'))
  const pageDir = path.dirname(pageJsonPath)
  for (const [name, ref] of Object.entries(pageJson.usingComponents ?? {})) {
    componentCount += 1
    check(resolveComponent(pageDir, ref), `${page}.json 的组件 ${name} → ${ref} 解析不到文件`)
  }
  // 占位组件必须是内置组件名，不能又是自定义组件（否则等于没占位）
  for (const [name, ref] of Object.entries(pageJson.componentPlaceholder ?? {})) {
    check(
      !ref.includes('/'),
      `${page}.json 的 componentPlaceholder[${name}] = ${JSON.stringify(ref)} 不是内置组件名`,
    )
    check(name in (pageJson.usingComponents ?? {}), `${page}.json 给未声明的组件 ${name} 配了占位符`)
  }
}

// ── 6. 非第三方 JS 语法检查 ─────────────────────────────────────────────
let jsCount = 0
walk(MP_ROOT, (file) => {
  if (!file.endsWith('.js')) return
  const rel = path.relative(MP_ROOT, file)
  // miniprogram_npm/ 是第三方预构建产物，语法由上游负责。
  if (rel.startsWith('miniprogram_npm' + path.sep)) return
  jsCount += 1
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    const detail = error.stderr?.toString().trim().split('\n').slice(-3).join(' ') ?? error.message
    problems.push(`${rel} 语法检查未通过：${detail}`)
  }
})

// ── 7. wxml 标签配对 ───────────────────────────────────────────────────
/**
 * 数标签的配对。
 *
 * ⚠️ **先剥注释**：一段没闭合的 `<!--` 会把后面所有内容都算成注释，
 * 而它的后果恰恰是标签对不上 —— 不剥的话这里既报不出错、又会误报。
 * 先剥一次，再数，才能让"少了一个 `</view>`"这种错露出来。
 *
 * ⚠️ 自闭合标签（`<view ... />`、`input` 这类）不压栈；`textarea` 在小程序里
 * 是**显式闭合**的（`<textarea …></textarea>`），所以它按普通标签算。
 */
function tagBalance(text) {
  // ⚠️ **没闭合的注释要单独报**（2026-10-08 补，而且是实测出来的）：
  // 一个 `<!--` 少了 `-->`，正则 `/<!--[\s\S]*?-->/` 会从它一路吃到**下一个** `-->`，
  // 于是中间整段（包括若干标签）都被当成注释剥掉 —— 标签数**恰好配平**，
  // 这条检查于是报"OK"。而开发者工具报的是 `get tag end without start`。
  // ⇒ 先数开合：开多于闭就是没闭合，那一段后面的所有内容都不可信。
  const opens = (text.match(/<!--/g) ?? []).length
  const closes = (text.match(/-->/g) ?? []).length
  if (opens > closes) {
    return { unclosed: [], mismatch: { tag: '!--', top: `注释没闭合（开了 ${opens} 个，闭了 ${closes} 个）`, line: text.indexOf('<!--') ? text.slice(0, text.lastIndexOf('<!--')).split('\n').length + 1 : 1 } }
  }
  const code = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE[^>]*>/gi, '')
  const stack = []
  let mismatch = null
  const VOID_SELF_CLOSED = /\/>\s*$/
  for (const m of code.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [full, close, tag, , selfClose] = m
    if (VOID_SELF_CLOSED.test(full)) continue
    const line = code.slice(0, m.index).split('\n').length
    if (close) {
      const top = stack.pop()
      if (top !== tag && !mismatch) mismatch = { tag, top, line }
    } else {
      stack.push(tag)
    }
  }
  return { unclosed: stack, mismatch }
}

let wxmlCount = 0
walk(ROOT, (file) => {
  const rel = path.relative(MP_ROOT, file)
  if (rel.startsWith('miniprogram_npm' + path.sep) || rel.startsWith('node_modules')) return
  if (!file.endsWith('.wxml')) return
  wxmlCount += 1
  const { unclosed, mismatch } = tagBalance(readFileSync(file, 'utf8'))
  if (mismatch) {
    problems.push(
      `${rel}:${mismatch.line} 标签配对错位：遇到 </${mismatch.tag}>，但栈顶是 <${mismatch.top ?? '(空)'}> —— ` +
        '这一类错误开发者工具才会报，别的检查一条都查不出来',
    )
  } else if (unclosed.length > 0) {
    problems.push(`${rel} 有没闭合的标签：<${unclosed.join('> <')}>`)
  }
})

// ── 汇总 ────────────────────────────────────────────────────────────────
const summary =
  `检查了 ${jsonCount} 个 JSON、${(appJson.pages ?? []).length} 个页面、` +
  `${componentCount} 个组件引用、${jsCount} 个自研 JS、${wxmlCount} 个 wxml 标签配对`
if (problems.length > 0) {
  console.error(`[verify-miniprogram] ${problems.length} 个问题（${summary}）：`)
  for (const problem of problems) console.error(`  ✗ ${problem}`)
  process.exit(1)
}
console.log(`[verify-miniprogram] OK —— ${summary}`)
