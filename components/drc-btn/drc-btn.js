/**
 * drc-btn —— 主按钮 / 危险按钮（阶段 C2）。
 *
 * ## 为什么自己画一个，而不是继续用 `t-button`
 *
 * TDesign 的 `t-button` 有 `theme="danger"`，但它**没有"加载中"与"禁用"同时成立**
 * 的形状（`loading` 与 `disabled` 会互相盖掉样式），而本项目这两个状态是要一起用的
 * （"正在连接…"既要 loading 也要 disabled，否则连点会发两次配对）。
 * 更要紧的是：TDesign 裁到只剩 6 个包（button/empty/icon/image/loading/common），
 * 每多依赖一个组件就要多维护一份"它内部到底用了哪些 --td-* 变量"的心智负担
 * —— 而那些变量在深色下是我们自己逐个修正过的（见 `gen-mp-theme.mjs`）。
 *
 * ## ⚠️ "危险"必须是**形状上的差异**，不是换个文案
 *
 * 判据 `check-mp-components.mjs` 会断言 danger 与 primary 的**底色不是同一个值**。
 * 理由：色觉障碍用户区分不了"红"与"蓝"，而危险操作（解配、拒绝、删除草稿）
 * 必须能被一眼认出来。这里的差异是**底色 + 字色 + 一条更重的描边**三处一起变。
 *
 * ## 为什么不用 `<button>` 而用 `<view>`
 *
 * 小程序的 `<button>` 自带一套样式与 open-type 语义，要清干净得覆盖十几条属性；
 * 而这里的按钮不需要任何 open-type（没有分享/客服/授权）。
 * 代价是**失去了默认的可点击语义**，所以组件自己带 `hover-class` 与 `aria-role`。
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    text: { type: String, value: '' },
    /** 'primary' | 'danger' | 'light' | 'plain'。非法值退回 primary。 */
    variant: {
      type: String,
      value: 'primary',
      observer: function (v) {
        this.setData({ cls: VARIANTS[v] ? v : 'primary' })
      },
    },
    /** 'large' | 'medium' | 'small' */
    size: { type: String, value: 'large' },
    loading: { type: Boolean, value: false },
    disabled: { type: Boolean, value: false },
    /** 撑满一行。表单里的提交键基本都要它。 */
    block: { type: Boolean, value: false },
  },
  data: { cls: 'primary' },
  lifetimes: {
    attached: function () {
      this.setData({ cls: VARIANTS[this.data.variant] ? this.data.variant : 'primary' })
    },
  },
  methods: {
    onTap: function (e) {
      // ⚠️ loading 与 disabled 都要拦：loading 时点第二下会发第二次请求，
      // 而那次请求与第一次是同一个 cmdId 之外的另一条 —— 幂等台账按 cmdId 去重
      // 挡不住"同一个动作发两遍"（那是两条命令）。
      if (this.data.loading || this.data.disabled) return
      this.triggerEvent('tap', e)
    },
  },
})

/** 合法变体表。判据会读它，所以不能只是一个字符串比较。 */
var VARIANTS = {
  primary: true,
  danger: true,
  light: true,
  plain: true,
}
