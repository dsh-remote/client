/**
 * theme — 小程序的主题（浅色 / 深色）。
 *
 * ── 为什么不用 prefers-color-scheme ───────────────────────────────────
 * 那条 media 查询是**系统**的意思，跟"用户在 App 里点了一下"是两件事。本项目要的是
 * 手动切：默认浅色，切了之后即使系统是浅色也保持深色，反之亦然。所以
 * `app.json` 写 `"darkmode": false`，两张变量表都从 @media 里解放出来（见
 * `scripts/gen-mp-theme.mjs`），用 class 决定用哪一套。
 *
 * ── 切换时必须一并改的三个地方 ────────────────────────────────────────
 * ① **页面根容器加 `theme-dark` class** —— 变量挂在这个 class 上，靠继承铺满整页。
 *    注意必须挂在**根 view** 上而不是 `page`：变量表里写的是 `.theme-dark`，
 *    挂在子树任何一个元素上都只染到那一片。
 * ② **导航栏** —— 它是原生组件，不吃 CSS 变量，也不受 `page` 上的变量影响，
 *    只能 `wx.setNavigationBarColor`。不改的话深色页面上方会留一条白顶栏。
 * ③ **下拉回弹区**（`backgroundColor` / `backgroundColorTop`）—— iOS 上把页面
 *    往下拉会露出它，深色下是刺眼的白。
 *
 * 只做 ① 的话，深色页面会有白顶栏 + 白回弹区，这是"切了但没切干净"最常见的形态。
 */
'use strict'

/** 存储键。带 v1 是为了以后改默认值时不误读旧值（见 `themeName` 的归一化）。 */
var KEY_THEME = 'drc.theme.v1'

/** 合法取值只有这两个。`light` 是默认 —— 用户没选过就是浅色。 */
var LIGHT = 'light'
var DARK = 'dark'

/** 根容器上要加的 class（空串 = 浅色，不要留一个空 class 名在标记里） */
var DARK_CLASS = 'theme-dark'

/**
 * 归一化：只认 'dark'，其余一律当浅色。
 *
 * 为什么要这么"死"：存储里的值可能是旧版本写的、也可能被人手动改过
 * （wx.getStorageSync 在开发者工具里就能改）。落到一个不认识的类名上，
 * 页面上就会是"深色变量没生效"的样子 —— 也就是切了没反应。
 */
function themeName(v) {
  return v === DARK ? DARK : LIGHT
}

/** 读当前主题。读不到、写坏了、值不认识，一律浅色。 */
function current() {
  try {
    return themeName(wx.getStorageSync(KEY_THEME))
  } catch (e) {
    return LIGHT
  }
}

/** 落盘。返回是否成功 —— 存不下时不能静默（下次启动会跳回浅色，用户以为没生效）。 */
function persist(name) {
  try {
    /**
     * ⚠️ **不许丢掉 `setStorageSync` 的返回值**（2026-10-08 补，阶段 C6 建设置页时抓到）。
     *
     * 原来这里是 `wx.setStorageSync(KEY_THEME, name); return true` —— 于是
     * "没存住"这条路**永远走不到**：配额满时它**返回 false 而不抛异常**
     * （`core/session-store.js` 的 nonce 那次审计是同一个形状），catch 抓不到，
     * 函数照样返回 true，调用方因此不提示。
     * 后果正是这个函数自己注释里写的那一句"最坏的形态"：界面已经变了，
     * 下次启动跳回浅色，而用户一句提示都没收到。
     *
     * 正常情况下它返回 `undefined`，所以判"不等于 false"而不是判"等于 true"。
     */
    return wx.setStorageSync(KEY_THEME, name) !== false
  } catch (e) {
    return false
  }
}

/**
 * 切换导航栏与回弹区配色。
 *
 * 取值来自两套主题的变量表（`--td-bg-color-container` 容器底作导航栏、
 * `--td-bg-color-page` 页面底作回弹区），不是随手挑的灰 ——
 * 挑错了导航栏和页面底色之间会出现一条能看出来的接缝。
 * 这里写死而不去读 CSS 变量：小程序没有"读 CSS 自定义属性值"的 API。
 *
 * ⚠️ **写死的代价就是会漂**，而且**两个主题都漂过**：
 *   · 2026-10-09 深色换成"深空墨蓝"：这里的 `#242424` / `#181818` 没跟着改；
 *   · 2026-10-10 浅色换成冷调浅色：`top` 还留着旧的 `#f3f3f3`。
 * 两次的症状一样 —— 页面上方（或 iOS 下拉回弹时）露出一条**比页面更浅**的边，
 * 而 CSS 一行都不用动、编译不报错、`check-mp-contrast` 也扫不到（它不是 page 上的元素）。
 *
 * ⇒ `e2e/mp-theme.test.mjs` 从 `theme/{light,dark}.wxss` 里**解出**这几个值来断言
 * （两套主题**都**验），改色阶忘了改这里，那条判据直接红。
 */
function applySystemBars(isDark) {
  var bar = isDark
    ? { front: '#ffffff', bg: '#141822', top: '#0a0b10' }
    : { front: '#000000', bg: '#ffffff', top: '#eff2f7' }
  try {
    wx.setNavigationBarColor({
      frontColor: bar.front,
      backgroundColor: bar.bg,
      success: function () {},
      fail: function () {},
    })
  } catch (e) {
    /* 老基础库没有这个 API：深色下顶栏会留白，但页面本身是对的，不该因此报错。 */
  }
  try {
    // 页面底色给 top（滚动时露出的那段），容器色给背景 —— 与 theme-dark 变量一致
    wx.setBackgroundColor({
      backgroundColor: bar.bg,
      backgroundColorTop: bar.top,
      success: function () {},
      fail: function () {},
    })
  } catch (e) {
    /* 同上 */
  }
}

/**
 * 把主题落到一个页面上。
 *
 * @param {object} page 小程序页面实例（需要 setData）
 * @param {string} [name] 指定主题；不给就用当前存储值
 * @returns {string} 实际生效的主题名
 *
 * 页面 `onLoad` 里调它就能完成首屏上色。**不要只在 onShow 里设 CSS**：首屏已经
 * 用浅色渲染过一次，用户会看到一闪的白底。
 */
function applyTo(page, name) {
  var resolved = name ? themeName(name) : current()
  applySystemBars(resolved === DARK)
  if (page && typeof page.setData === 'function') {
    page.setData({ themeName: resolved, themeClass: resolved === DARK ? DARK_CLASS : '' })
  }
  return resolved
}

/**
 * 切到**指定**主题并立刻生效（阶段 C6 的设置页要它）。
 *
 * ⚠️ 为什么另开一个函数而不是让设置页去调 `toggle()`：只有两个取值时
 * "再翻一次"确实能到想去的那一边，但那要**先读当前值再决定翻不翻**，
 * 于是"点深色"这个动作的正确性依赖于"它当时是浅色"——两个入口（列表页那颗
 * 快捷开关与设置页）就可能互相踩。指定目标值的函数没有这个耦合。
 *
 * @param {object} page 页面实例
 * @param {string} name 'light' | 'dark'；不认识的值按浅色处理
 * @returns {{name: string, dark: boolean, saved: boolean, changed: boolean}}
 *   `changed:false` = 本来就是这个主题（设置页据此不弹"已切换"那句）
 */
function choose(page, name) {
  var next = themeName(name)
  var changed = next !== current()
  var saved = persist(next)
  applyTo(page, next)
  return { name: next, dark: next === DARK, saved: saved, changed: changed }
}

/**
 * 在浅色 / 深色之间切换并立刻生效。
 *
 * @returns {{name: string, dark: boolean, saved: boolean, changed: boolean}}
 *   `saved:false` 表示存储写失败 —— 界面已经变了，但下次启动会回浅色，
 *   调用方应该提示一句，别让用户以为设置没生效。
 */
function toggle(page) {
  return choose(page, current() === DARK ? LIGHT : DARK)
}

module.exports = {
  current: current,
  applyTo: applyTo,
  choose: choose,
  toggle: toggle,
}
