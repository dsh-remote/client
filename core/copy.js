/**
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
var STATUS_ZH = {
  "online": "已连接",
  "connecting": "连接中",
  "offline": "已断开",
  "notLinked": "未连接",
  "pairing": "正在配对",
  "needsPair": "需要重新配对，请扫描主机状态栏那颗胶囊弹出的二维码",
  "relayReady": "已就绪"
}

/** 审批三键（id 是行为分支条件，label 才是文案）。 */
var APPROVAL_OPTIONS = [
  {
    "id": "approve",
    "label": "允许一次"
  },
  {
    "id": "approve-session",
    "label": "始终允许"
  },
  {
    "id": "reject",
    "label": "拒绝"
  }
]

/** 「始终允许」的边界说明 —— 按钮上只有四个字，边界必须另有承载。 */
var APPROVAL_SCOPE_HINT = "「始终允许」仅限本次会话内的同类操作，会话结束即失效"

/** pair-fail 四个 reason 的中文说法。 */
var PAIR_FAIL_ZH = {
  "_why": "F6 冻结的四个 reason 的中文说法。主机侧只把它们写进日志（英文 reason 是判据的锚），说给用户听的是小程序这一份。",
  "invalid_or_expired": "配对码无效或已过期",
  "already_used": "配对码已被使用",
  "host_offline": "主机不在线",
  "bad_token": "令牌错误"
}

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
