#!/usr/bin/env node
/**
 * gen-mp-copy — 从**共享文案表**生成小程序的 `core/copy.js`。
 *
 * ## 为什么是"生成"而不是"直接 require"
 *
 * 小程序没有构建步骤（`core/` 里的文件原样打进包），而事实源在宿主插件包里
 * （`packages/plugin/copy/zh-cn.json`，V3-PLAN §7 阶段 F2：宿主侧中文与 mp 侧共用一份）。
 * 这与设计 token 的处境**完全一样**，所以照抄 `gen-mp-theme.mjs` 那套形状：
 * 一份事实源 + 一个生成器 + 一道 `--check` 闸。抄形状不抄规模（§3.2）。
 *
 * ## 只生成 `ends` 含 client 的条目 —— 这条规则本身就是判据
 *
 * 表里标 `ends: "host"` 的词条（中继未启动 / 手机离线 / 已就绪 …）是宿主独有的界面文案，
 * 它们**一个字都不许进小程序包**：进了就说明小程序界面开始说宿主那侧的话，
 * 而两端对同一语义说两套话正是 F2 要消灭的东西。
 * `e2e/shared-copy.test.mjs` 按这条规则反向验：往小程序里塞一句宿主专有文案就红。
 *
 * 用法：
 *   node scripts/gen-mp-copy.mjs            # 重新生成
 *   node scripts/gen-mp-copy.mjs --check    # 只校验新鲜度（闸门用这个）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 事实源在宿主插件包里（单仓相对路径；拆仓后本脚本与那份 JSON 要一起搬）。 */
const SOURCE = path.resolve(MP, '..', 'plugin', 'copy', 'zh-cn.json')
const TARGET = path.join(MP, 'core', 'copy.js')

const table = JSON.parse(readFileSync(SOURCE, 'utf8'))

/** 只有这两端会说出口的词条才进小程序。 */
function forClient(entries) {
  const out = {}
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.ends === 'host') continue
    out[id] = entry.zh
  }
  return out
}

const status = forClient(table.status)

const body = `/**
 * copy — **生成物，不许手改**（V3-PLAN §7 阶段 F2）。
 *
 * 事实源：packages/plugin/copy/zh-cn.json（宿主侧中文，与宿主插件共用一份）。
 * 重新生成：node packages/client/scripts/gen-mp-copy.mjs
 * 校验：    node packages/client/scripts/gen-mp-copy.mjs --check
 *
 * ⚠️ 这张表里**只有两端都会说出口的词条**（表里 ends 含 client 的那些）。
 * 宿主独有的界面文案（"中继未启动" / "手机离线" / "已就绪"）一个字都不在这里——
 * 小程序界面不许替宿主说话，两端各说各的那一套正是这张表要消灭的东西。
 *
 * ⚠️ 取不到时返回 undefined 而不是兜底串：界面上"显示成另一句话"比"不显示"更难查。
 */

/** 状态词条：语义 id → 给用户看的那句中文。 */
var STATUS_ZH = ${JSON.stringify(status, null, 2).replace(/\n/g, '\n')}

/** 审批三键（id 是行为分支条件，label 才是文案）。 */
var APPROVAL_OPTIONS = ${JSON.stringify(table.approval.options, null, 2)}

/** 「始终允许」的边界说明 —— 按钮上只有四个字，边界必须另有承载。 */
var APPROVAL_SCOPE_HINT = ${JSON.stringify(table.approval.scopeHint)}

/** pair-fail 四个 reason 的中文说法。 */
var PAIR_FAIL_ZH = ${JSON.stringify(table.pairFail, null, 2)}

function statusText(id) {
  return STATUS_ZH[id]
}

/** 唯一一个带占位符的词条（ends: host，所以本包用不到；留着是为了形状一致）。 */
function waitingText(n) {
  var tpl = '等 {{n}} 件事'
  return tpl.replace('{{n}}', String(n))
}

function pairFailText(reason) {
  return PAIR_FAIL_ZH[reason]
}

module.exports = {
  STATUS_ZH: STATUS_ZH,
  APPROVAL_OPTIONS: APPROVAL_OPTIONS,
  APPROVAL_SCOPE_HINT: APPROVAL_SCOPE_HINT,
  PAIR_FAIL_ZH: PAIR_FAIL_ZH,
  statusText: statusText,
  waitingText: waitingText,
  pairFailText: pairFailText,
}
`

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(TARGET, 'utf8')
  } catch {
    /* 文件不存在 = 没生成过，下面当不一致处理 */
  }
  if (current !== body) {
    process.stderr.write(
      'core/copy.js 与事实源 packages/plugin/copy/zh-cn.json 不一致。\n' +
        '重新生成：node packages/client/scripts/gen-mp-copy.mjs\n',
    )
    process.exit(1)
  }
  process.stdout.write(`[gen-mp-copy] core/copy.js 与事实源一致（${Object.keys(status).length} 个词条）\n`)
} else {
  writeFileSync(TARGET, body)
  process.stdout.write(`[gen-mp-copy] 已生成 core/copy.js（${Object.keys(status).length} 个词条）\n`)
}