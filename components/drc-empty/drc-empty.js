/**
 * drc-empty —— 空态（阶段 C2）。
 *
 * ## 它替掉了什么
 *
 * 原来列表页的空态是 TDesign 的 `t-empty`（`icon="chat"` + 一句 description）。
 * 它够用于"这里没东西"，但**不够用于"这里没东西，而且你要知道下一步"**：
 *   · 描述里塞了三态文案（`archivedCount ? … : (status === 'online' ? … : …)`），
 *     一行 wxml 里写两个三元 —— 下次加一个状态就得再嵌一层；
 *   · **没有按钮位**："连上主机后这里会列出它的会话"这句之后没有动作可点，
 *     用户只能自己猜该怎么办（空态最常见的失败形态）。
 * 所以自建：文案由调用方给（组件不做业务判断），组件只保证**有标题、有说明、有动作位**。
 *
 * ## 为什么 `desc` 为空时不渲染那一行
 *
 * 空一行文字在视觉上是"一块空白"，看起来像样式 bug。不渲染才是对的。
 */
Component({
  options: { addGlobalClass: true, multipleSlots: true },
  properties: {
    /** 图标字符（不是图片）：保持零依赖，也免去深色下换图的麻烦。 */
    icon: { type: String, value: '' },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
  },
  methods: {
    /** 空态整体不可点：防止"点空白处触发了下面的列表行"（真机上摸不准的那一下）。 */
    noop: function () {},
  },
})
