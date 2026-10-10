/**
 * 设计 token 表 —— **唯一事实源**（V3-PLAN §7 阶段 C1）。
 *
 * ## 为什么要有它
 *
 * 在它之前，`packages/client` 的每个 wxss 各自写死数字：间距出现过
 * 2/4/6/8/10/12/14/16/18/20/22/24/26/28/30/32/36/40/48/56 rpx 共 20 种取值，
 * 圆角 12 种，字号 10 种。**没有哪种是"设计决定"，全是"当时手写的数"。**
 * 后果不是不好看，而是**没法改**：想让卡片间距松一点，得去三个文件里改二十几处，
 * 而且没有任何东西告诉你改漏了。
 *
 * ## 三条纪律
 *
 * 1. **表是唯一来源**。`--drc-*` 只能由 `scripts/gen-mp-theme.mjs` 从本表生成，
 *    不许手改生成物（`theme/light.wxss` / `theme/dark.wxss` 的头注也写了）。
 *    `gen-mp-theme.mjs --check` 会比对生成物与本表。
 * 2. **几何量上 4px 网格**。间距与圆角的每个值都必须是 `8rpx` 的倍数
 *    （小程序 750rpx 设计稿 ⇒ `1px = 2rpx`，所以 `8rpx = 4px`）。
 *    这条由 `scripts/check-mp-tokens.mjs` 逐条验，不是靠自觉。
 * 3. **字号有自己的阶梯**（`4rpx = 2px` 一档）。
 *    ⚠️ 这不是对第 2 条的破例：字号从来不跟间距共用网格 —— 11px、13px 这类
 *    半档在小屏上是必要的（正文与次要文字差 2px 就能分层，差 4px 就断层了）。
 *    把字号硬塞进 4px 网格只会得到"要么太大要么太小"的两档。
 *
 * ## 迁移的棘轮
 *
 * 各页 wxss 里**裸写**的数字不要求一夜之间清完（那是 C3–C6 的事），
 * 但**只许减少不许增加**：`check-mp-tokens.mjs` 里有一个实测基线，
 * 多了就红，少了就逼你把基线降下来。**没有棘轮的迁移计划等于没写。**
 *
 * ## 命名
 *
 * `--drc-` 前缀：这一层是**本项目自己的**语义，与 TDesign 的 `--td-` 分开。
 * 语义 token（fg / surface / border）的值是 `var(--td-…)`——它们不复制颜色，
 * 只**起名字**：`--drc-fg-muted` 今天指向 `--td-text-color-placeholder`，
 * 明天换掉那一处就行，不用去二十几个类名里改。
 */

/** 几何网格：8rpx = 4px。间距与圆角必须是它的整数倍。 */
export const GRID_RPX = 8
/** 字号阶梯：4rpx = 2px（理由见上面第 3 条）。 */
export const TYPE_STEP_RPX = 4

/**
 * 全部 token。顺序 = 生成顺序（也决定了生成物里声明的先后）。
 *
 * `value` 要么是具体值（`8rpx` / `0` / `999rpx`），要么是对 `--td-*` 的引用。
 * ⚠️ 引用必须是 `var(--td-…)` **完整形态**，不能只写变量名 —— CSS 里
 * `--a: --b` 的意思是"把 `--a` 的值设成字符串 `--b`"，不是"取 `--b` 的值"。
 * 那是静默的：语法合法、解析成功、颜色变成无效的。这条由 check 脚本逐条验。
 */
export const TOKENS = [
  // ── 间距（4px 网格）─────────────────────────────────────────────────
  { group: 'space', name: '--drc-space-0', value: '0', why: '清零用显式 token：写 0 与写"没写"在 wxss 里看不出区别' },
  { group: 'space', name: '--drc-space-1', value: '8rpx', why: '图标与文字之间的最小呼吸（4px）' },
  { group: 'space', name: '--drc-space-2', value: '16rpx', why: '同一行内相邻元素的间距（8px）；也是密集列表的行间距' },
  { group: 'space', name: '--drc-space-3', value: '24rpx', why: '卡片内边距、常规块间距（12px）—— 用量最大的一档' },
  { group: 'space', name: '--drc-space-4', value: '32rpx', why: '分组之间的间距（16px）' },
  { group: 'space', name: '--drc-space-5', value: '40rpx', why: '大区块分隔（20px）' },
  { group: 'space', name: '--drc-space-6', value: '48rpx', why: '页面外边距、底部安全区之上的留白（24px）' },
  { group: 'space', name: '--drc-space-8', value: '64rpx', why: '空态与首屏的纵向留白（32px）' },
  { group: 'space', name: '--drc-space-10', value: '80rpx', why: '空态插画上下的大留白（40px）' },

  // ── 圆角（4px 网格）─────────────────────────────────────────────────
  { group: 'radius', name: '--drc-radius-none', value: '0', why: '通栏元素（分割线、列表行）不要圆角' },
  { group: 'radius', name: '--drc-radius-sm', value: '8rpx', why: '小控件：徽标、标签、小按钮（4px）' },
  { group: 'radius', name: '--drc-radius-md', value: '16rpx', why: '卡片与输入框（8px）' },
  { group: 'radius', name: '--drc-radius-lg', value: '24rpx', why: '弹层顶部圆角、气泡（12px）' },
  { group: 'radius', name: '--drc-radius-xl', value: '32rpx', why: '底部弹层的大圆角（16px）' },
  {
    group: 'radius',
    name: '--drc-radius-pill',
    value: '999rpx',
    // ⚠️ 刻意豁免网格：胶囊的意思是"取到最大"，不是网格上的某一档。
    // 给它一个 8rpx 倍数的值（比如 32rpx）会在高度变化时露出直边。
    grid: 'exempt',
    why: '胶囊：按钮、pill 指示灯。取极大值而不是 50% —— 后者在高度变化时会被压成椭圆',
  },

  // ── 字号（2px 阶梯，见纪律 3）───────────────────────────────────────
  { group: 'font', name: '--drc-font-xs', value: '20rpx', why: '角标、极小注释（10px）—— 再小在真机上就不成字了' },
  { group: 'font', name: '--drc-font-sm', value: '24rpx', why: '次要文字：时间戳、路径、占位符（12px）' },
  { group: 'font', name: '--drc-font-md', value: '28rpx', why: '正文（14px）—— 全局默认，与 app.wxss 的 page 一致' },
  { group: 'font', name: '--drc-font-lg', value: '32rpx', why: '小标题、强调行（16px）' },
  { group: 'font', name: '--drc-font-xl', value: '40rpx', why: '页面级标题、大数字（20px）' },
  { group: 'font', name: '--drc-font-display', value: '56rpx', why: '空态与首屏的主文案（28px）' },
  { group: 'font', name: '--drc-font-icon', value: '72rpx', why: '装饰性图标的字号（36px）—— 空态插画、大状态图标。⚠️ 它是字号组，走 4rpx 阶梯而不是几何网格' },

  // ── 语义：前景 ──────────────────────────────────────────────────────
  // ⚠️ 全部引用 `--td-*`：这里只起名，不复制颜色。
  { group: 'fg', name: '--drc-fg-primary', value: 'var(--td-text-color-primary)', why: '正文与主要读数：会话标题、消息正文、按钮文字' },
  { group: 'fg', name: '--drc-fg-secondary', value: 'var(--td-text-color-secondary)', why: '辅助说明：工具参数摘要、卡片副标题。比正文弱一档但仍要能读' },
  { group: 'fg', name: '--drc-fg-muted', value: 'var(--td-text-color-placeholder)', why: '时间戳、路径、占位符。⚠️ 深浅两套都做过可读性修正（见 gen-mp-theme.mjs），不要绕开它直接写 --td-text-color-placeholder' },
  { group: 'fg', name: '--drc-fg-anti', value: 'var(--td-text-color-anti)', why: '压在品牌色/深色底上的白字' },
  { group: 'fg', name: '--drc-fg-brand', value: 'var(--td-brand-color-on-tint)', why: '压在品牌浅底上的品牌字色。⚠️ 必须是 on-tint 而不是 --td-brand-color：后者要同时当底色（要够暗）与字色（要够亮），数学上无解' },
  { group: 'fg', name: '--drc-fg-danger', value: 'var(--td-error-color-6)', why: '错误与危险操作：失败的步骤、"拒绝"按钮、解配确认' },
  { group: 'fg', name: '--drc-fg-warning', value: 'var(--td-warning-color-6)', why: '提醒与等待：审批超时前的倒计时、需要注意但不致命的状态' },
  { group: 'fg', name: '--drc-fg-success', value: 'var(--td-success-color-6)', why: '完成与成功：步骤打勾、连接正常、归档完成' },

  // ── 语义：面 ────────────────────────────────────────────────────────
  { group: 'surface', name: '--drc-surface-page', value: 'var(--td-bg-color-page)', why: '页面底：最底那一层，卡片浮在它上面' },
  { group: 'surface', name: '--drc-surface-card', value: 'var(--td-bg-color-container)', why: '卡片底（浮起一层）' },
  { group: 'surface', name: '--drc-surface-sunken', value: 'var(--td-bg-color-secondarycontainer)', why: '陷入一层：代码块、引用块' },
  { group: 'surface', name: '--drc-surface-brand', value: 'var(--td-brand-color)', why: '品牌底：用户气泡、主按钮' },

  // ── 语义：线 ────────────────────────────────────────────────────────
  { group: 'border', name: '--drc-border', value: 'var(--td-border-level-1-color)', why: '一级分割线：列表行之间、卡片描边' },
  { group: 'border', name: '--drc-border-strong', value: 'var(--td-border-level-2-color)', why: '二级分割线：需要更重分隔的地方（分组标题下、输入区上边）' },
]

/**
 * 合法的前景 × 底色搭配（**对比度闸会逐条验**）。
 *
 * ⚠️ 这张表的价值在于"**不是所有组合都合法**"：写进来的每一对都必须过阈值，
 * 没写进来的组合不许在 wxss 里出现（否则就是"又一个没人算过的搭配"）。
 * 阶段 C1 之前，配色组合是从各页 CSS 里**事后**抽出来算的 —— 抽得到才算得到，
 * 抽不到的（文字与底色分处两条规则）只能靠手工登记。这里把它反过来：
 * **先声明允许的搭配，再让闸去验**。
 */
export const PAIRS = [
  ['--drc-fg-primary', '--drc-surface-page'],
  ['--drc-fg-primary', '--drc-surface-card'],
  ['--drc-fg-primary', '--drc-surface-sunken'],
  ['--drc-fg-secondary', '--drc-surface-page'],
  ['--drc-fg-secondary', '--drc-surface-card'],
  ['--drc-fg-secondary', '--drc-surface-sunken'],
  ['--drc-fg-muted', '--drc-surface-page'],
  ['--drc-fg-muted', '--drc-surface-card'],
  ['--drc-fg-muted', '--drc-surface-sunken'],
  ['--drc-fg-brand', '--drc-surface-card'],
  ['--drc-fg-danger', '--drc-surface-card'],
  ['--drc-fg-warning', '--drc-surface-card'],
  ['--drc-fg-success', '--drc-surface-card'],
  ['--drc-fg-anti', '--drc-surface-brand'],
]

/** 几何组（要上 4px 网格的那些）。 */
export const GEOMETRY_GROUPS = ['space', 'radius']
/** 字号组（2px 阶梯）。 */
export const TYPE_GROUPS = ['font']

/** 拼出 CSS 声明串（`--a:b;--c:d;`），供生成器塞进选择器。 */
export function tokenDecls() {
  return TOKENS.map((t) => `${t.name}:${t.value};`).join('')
}
