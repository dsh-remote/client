/**
 * drc-skeleton —— 加载态骨架（阶段 C2）。
 *
 * ## 为什么要有它（而不是一个"加载中…"）
 *
 * "加载中…"回答的是"在加载吗"，骨架回答的是"**加载出来会是什么样**"。
 * 后者才是小程序真正需要的：手机上首屏那 300ms 里，用户要看的是"下面会有一排会话"，
 * 而不是一行字。骨架还顺带解决了**跳版**——内容到达前后高度一致，列表不会抖一下。
 *
 * ## ⚠️ 骨架必须"长得像"它替的那个东西
 *
 * 这是它唯一容易做错的地方：一个 3 行的骨架放在"一会话两行"的列表前面，
 * 内容到达时高度差一半，抖得比没有骨架更厉害。所以：
 *   · `rows` 默认 3（一屏大约三条会话）；
 *   · 每行**两条**（标题条 + 副标题条），与列表行"标题一行、路径一行"对齐；
 *   · 最后一条的副标题是 60% 宽 —— 真列表的最后一行也常常是短路径。
 */
Component({
  options: { addGlobalClass: true },
  properties: {
    /** 几行。⚠️ 上限 6：再多就是"数据很多"的假象，而骨架不该撒谎。 */
    rows: {
      type: Number,
      value: 3,
      observer: function (v) {
        this.setData({ list: clampRows(v) })
      },
    },
    /** 是否在每行前面画一个圆形头像位（有头像的列表才开）。 */
    avatar: { type: Boolean, value: false },
  },
  data: { list: [0, 1, 2] },
  lifetimes: {
    attached: function () {
      this.setData({ list: clampRows(this.data.rows) })
    },
  },
})

/** 行数夹到 1..6。`NaN` 与非数字一律退回 3 —— 不许给一个"半坏"的骨架。 */
function clampRows(v) {
  var n = Number(v)
  if (!isFinite(n) || n < 1) n = 3
  n = Math.floor(n)
  if (n > 6) n = 6
  var out = []
  for (var i = 0; i < n; i += 1) out.push(i)
  return out
}
