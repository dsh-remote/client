/**
 * toast —— **唯一的**轻提示入口（V3-PLAN §7 阶段 C2）。
 *
 * ## 它替掉了什么
 *
 * 改之前，两个页面里有 **40 多处**各自手写 `wx.showToast({ title: …, icon: 'none' })`。
 * 分散本身不是问题，**分散的是"这条约束"**才是问题：
 *
 *   ① `icon: 'none'` 要**每一处都记得写**。漏了就是默认 `icon: 'success'`，
 *      于是"主机没能完成这条指令"前面挂一个**对勾** —— 这条真的发生过；
 *   ② `.slice(0, 40)` 抄了二十遍，而**没人知道 40 是怎么来的**（见下面 TOAST_MAX）；
 *   ③ **空文案照弹**：`String(evt.message || '').slice(0, 40)` 在 message 为空时
 *      弹出一个**空的黑框**。用户看见一个空白提示，比什么都看不见更困惑
 *      —— 他会以为界面坏了，而不是"这条没有附加信息"。
 *
 * 所以收口成一个入口：调用方只给**一句人话**，长度、图标、时长都在这里兜。
 *
 * ## ⚠️ 它**刻意不做的**三件事
 *
 * 1. **不自建 DOM toast**。e2e 断言的是 `wx.showToast` 被调到与它的 `title`
 *    （`mp-chat-blocks` / `mp-sessions-list` / `mp-audit-20261007` 等多处），
 *    换成自建组件等于把那些判据一次性废掉。而且原生 toast 在真机上的层级、
 *    防连点、键盘避让都是白拿的，自己做得再画一遍。
 * 2. **不去重**。流式失败会在一帧里连着报，看起来像刷屏——但"去重"会吃掉
 *    "确实发生了两次"这个信息，也会让按次数断言的判据失准。**该修的是上报频率，
 *    不是提示层。**
 * 3. **不接管 `showModal`**。模态是"要用户决策"，toast 是"告诉用户一声"，
 *    两者语义不同，合成一个入口反而更容易选错。
 */

/**
 * 小程序 toast 能完整显示的字符数上限。
 *
 * 这不是拍的：微信的 toast 最多两行，超出的部分**静默截断**（不报、不换行、
 * 也不加省略号），表现是"话说到一半就没了"。40 是两行在 14px 下的经验值。
 *
 * ⚠️ 判据 `check-mp-components.mjs` 会断言"超过上限的文案**被截断且带省略号**"，
 * 所以这个数与截断逻辑都在这里，不在调用方。
 */
var TOAST_MAX = 40

/** 长文案的展示时长（毫秒）。微信默认 1500ms —— 读不完 40 个字。 */
var LONG_MS = 2500
/** 短文案的展示时长。与微信默认一致。 */
var SHORT_MS = 1500

/**
 * 弹一条轻提示。
 *
 * @param {string} text 一句人话。可以是任意类型（会 String() 化）。
 * @param {Object} [opts]
 * @param {number} [opts.duration] 显式时长；不给时按长度自动选（长文案给 LONG_MS）。
 * @param {'none'|'success'|'error'|'loading'} [opts.icon] 默认 `'none'`。
 * @param {number} [opts.max] 覆盖截断上限（默认 TOAST_MAX）。
 * @returns {boolean} 真的弹了才返回 true。空文案/无 wx 时返回 false —— 调用方
 *   可以据此决定"要不要补一句别的"，但**大多数调用方不该关心返回值**。
 */
function toast(text, opts) {
  var o = opts || {}
  var title = normalize(text, o.max)
  // ⚠️ 空文案**不弹**（缺陷 ③）。返回 false 让调用方知道"这句没说出去"。
  if (!title) return false
  if (typeof wx === 'undefined' || !wx.showToast) return false

  var duration = o.duration
  if (typeof duration !== 'number' || !isFinite(duration)) {
    // 长文案给更久：40 个字按正常阅读速度要 2 秒以上，1500ms 一定读不完。
    duration = title.length > TOAST_MAX / 2 ? LONG_MS : SHORT_MS
  }
  wx.showToast({
    title: title,
    // ⚠️ 默认 'none' 而不是让微信给默认值（缺陷 ①）。
    icon: o.icon || 'none',
    duration: duration,
  })
  return true
}

/**
 * 归一化：去空白、压平换行、按上限截断并**补省略号**。
 *
 * ⚠️ 截断必须自己补 '…'：微信的静默截断不加省略号，用户看不出那是被截了，
 * 会以为本来就是这么一句。
 *
 * ⚠️ 换行要先压平成空格：toast 里出现换行会把它撑成三行然后被截掉一整行，
 * 而后台返回的 message 里带 `\n` 是常事。
 */
function normalize(raw, max) {
  var s = raw == null ? '' : String(raw)
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return ''
  var limit = typeof max === 'number' && max > 0 ? max : TOAST_MAX
  if (s.length <= limit) return s
  return s.slice(0, limit - 1) + '…'
}

module.exports = {
  toast: toast,
  normalize: normalize,
  // 这三个**导出给判据用**（`check-mp-components.mjs` 断言截断上限与时长选择），
  // 不是"顺手导出"：删掉它们会让那几条判据失去事实源，只能回头抄一份 40/2500/1500
  // —— 那就又是"没人知道 40 是怎么来的"那个坑。
  TOAST_MAX: TOAST_MAX,
  LONG_MS: LONG_MS,
  SHORT_MS: SHORT_MS,
}
