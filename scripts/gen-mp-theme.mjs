#!/usr/bin/env node
/**
 * 生成 theme/ 下的主题变量表 —— `light.wxss`（默认）与 `dark.wxss`（切暗色时叠加）。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * TDesign 的 `common/style/theme/_index.wxss` 把浅色和深色**两套变量都包在
 * `@media (prefers-color-scheme)` 里**，跟随系统。本项目的主题是**用户手动切**的
 * （默认浅色，可切深色），不是跟随系统，所以两套都得能脱离 `@media` 独立生效。
 *
 * 做法：把两段分支各自抽出来、剥掉 `@media` 外壳，交给 `app.wxss` 叠加使用：
 *   · `light.wxss` 选择器保持 `.page,page` —— **无条件生效**，与 `page` 元素同源，
 *     任何页面不切主题时都是浅色（默认态）。
 *   · `dark.wxss` 选择器改成 `.theme-dark, .theme-dark page` —— **只挂在页面根容器上**。
 *     变量会向下继承给整棵子树，所以给根 view 加一个 class 就等于整页换肤。
 *
 * ── 为什么深色挂在 class 上而不是继续用「同特异性靠源码顺序压」──────────
 * 之前固定浅色就是靠「`app.wxss` 在 `_index.wxss` 之后 import，压掉深色分支」。
 * 但那是**单向**的：只能压深色、没法再切回来。要做双向切换，就必须让两套变量
 * 各自有独立的生效条件 —— class 是唯一能做到的（`prefers-color-scheme` 是系统的意思，
 * 与「用户点了按钮」无关）。所以浅色留在 `page`（默认）、深色挂 class（按需叠加），
 * 两者靠「深色类名存在与否」区分，互不覆盖。
 *
 * ── 为什么用脚本而不是手抄 ───────────────────────────────────────────
 * 那份变量表是几 KB 的单行 CSS，手抄必漏，漏掉的变量就会退回浅色值（深色下"某一块
 * 变成白底"就是这么来的）。TDesign 升级后重跑一次即可。`--check` 在 CI 里发现
 * "忘了重新生成"。
 *
 * ── 深色表缺的那两个变量 ─────────────────────────────────────────────
 * TDesign 的深色分支**没有** `--td-shadow-4` 与 `--td-scrollbar-hover-color`
 * （实测 2026-10-02，136 个浅色变量 vs 140 个深色变量，这 2 个只在浅色里）。
 * 不补的话，深色下用到它们的地方会退回**继承浅色时的值**（因为浅色表挂在 `page` 上，
 * 仍会继承下来），表现为"深色里有一块浅色阴影"。这里按深色的观感补齐。
 *
 * ── 深色"可读性修正"（DARK_READABILITY）─────────────────────────────
 * TDesign 的深色表是给**大屏 Web** 调的，底色更浅（它的 `--td-bg-color-page`
 * 在深色分支下相当于中灰）。本项目是小屏手机屏，字号本来就小、深色底本来就
 * 更深，于是几个关键变量在真机上明显偏暗。实测（见 scripts/check-mp-contrast.mjs）：
 *
 *   变量                            浅色 →  压 #242424   深色原值 → 压 #242424
 *   --td-text-color-placeholder      #000/.4 →  2.81:1     #fff/.35  →  3.16:1
 *   --td-text-color-disabled         #000/.26 →  2.10:1     #fff/.22  →  2.51:1
 *   --td-brand-color                 #0052d9 →  4.13:1(容器) #4582e6 →  4.13:1
 *   --td-error-color-6               #d54941 →  3.99:1(浅红底) #c64751 →  2.88:1
 *
 * 前两个是"次要文字"（时间戳、路径、占位符、note）—— 用量最大，深色下几乎
 * 靠猜。后三个是"彩色字压彩色底"，深色下两端的明度差都比浅色小。
 *
 * 修法是**只调 alpha / 只换更亮的同色系值**，不重排色阶：色阶一动，
 * 组件内部的搭配（t-button 各种 variant）就全乱了。要保住的是
 * "primary 比 secondary 亮、secondary 比 placeholder 亮"这个序。
 * `DARK_READABILITY_CHECK` 会在生成时验一遍这个序，破了就报错。
 *
 * 用法：
 *   node scripts/gen-mp-theme.mjs           # 写入
 *   node scripts/gen-mp-theme.mjs --check   # 只比对，不同步则退出码 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOKENS, GEOMETRY_GROUPS, TYPE_GROUPS, GRID_RPX, TYPE_STEP_RPX, tokenDecls } from '../theme/tokens.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(
  ROOT,
  'miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss',
)

/** TDesign 深色分支漏掉的变量。深色下必须给值，否则会继承浅色表的同名值。 */
const DARK_ONLY_FIXUPS = [
  // 深色底上的阴影要用更浅一点的**中性**阴影才看得出层次（黑上加黑等于没加）
  ['--td-shadow-4', '0 2px 8px 0 rgba(0, 0, 0, 0.35)'],
  ['--td-scrollbar-hover-color', 'rgba(255, 255, 255, 0.26)'],
]

/**
 * 深色"可读性修正"：TDesign 给的深色值在小屏手机上偏暗，压不住。
 *
 * 每一项都标了**实测对比度**（WCAG，正文阈值 4.5:1，底色取深色下真实会碰到的
 * 那几个：页面底 #181818 / 卡片底 #242424 / 组件底 #383838）。
 * 数字不是估的，是 `scripts/check-mp-contrast.mjs` 算出来的，改完请重跑它。
 *
 * 只调 alpha 或换同色系更亮的一档，**不重排色阶** —— 色阶一动，TDesign 组件
 * 内部的搭配（t-button 的各种 variant）就全乱了。要保住的序是
 * primary > secondary > placeholder > disabled，下面 `checkReadabilityOrder` 会验。
 */
const DARK_READABILITY = [
  // 次要文字：时间戳、路径、占位符、系统提示、note。这一档用量最大，
  // 深色下 0.35 压 #242424 只有 3.16:1，晚上基本靠猜 → 提到 0.5（4.96:1）
  ['--td-text-color-placeholder', 'rgba(255, 255, 255, 0.5)', '3.16 → 4.96'],
  // disabled：置灰的按钮与"没连上"状态。0.22 只有 2.06:1，看不出是"灰"还是"看不清"
  // → 0.4（3.70:1）。它本来就该弱于 placeholder，所以不追 4.5。
  ['--td-text-color-disabled', 'rgba(255, 255, 255, 0.4)', '2.06 → 3.70'],
  // ── 语义色的 -6 档作前景（.pill.danger / .act-danger / .step-tick.failed）──
  // 压自己的 -1 深底时两端都暗。逐个提到 ≥4.5。
  ['--td-error-color-6', '#e8757d', '2.88 → 4.74'],
  ['--td-warning-color-6', '#e8894d', '3.97 → 4.83'],
  ['--td-success-color-6', '#52c29d', '4.61 → 5.69'],
]

/**
 * 新增一个变量：`--td-brand-color-on-tint` —— **品牌色作为前景、且压在品牌浅底上**
 * 时该用的颜色。
 *
 * ── 为什么必须新开一个，不能直接调亮 `--td-brand-color` ──────────────
 * `--td-brand-color` 在本项目扛**两个互斥的角色**：
 *   · 当**底色**（用户气泡、t-button--primary、DSH 徽标）→ 要**够暗**，
 *     压 `--td-text-color-anti` 的白字才够 4.5:1；
 *   · 当**字色**（.pill.primary、.section-action、.sess-badge.primary）→
 *     压在 `--td-brand-color-1` 浅底上，要**够亮**。
 * 这两个要求在数学上无解（实测：作底色需亮度 ≤0.163，作字需 ≥0.304，
 * 没有任何一个蓝色同时满足）。中途试过直接把它调亮到 #6b9dec ——
 * 字色那侧修好了，底色那侧白字从 3.43:1 掉到 2.51:1，用户气泡直接看不清。
 *
 * 所以拆开：底色那一侧继续用 `--td-brand-color`（TDesign 原值 #4582e6，
 * 白字 3.43:1 —— 见 `DARK_BRAND_BG`，那个要单独修），字色这一侧改用本变量。
 * 浅色主题里两者同值（#0052d9），所以 wxss 里换过去不影响浅色观感。
 */
const BRAND_ON_TINT = '--td-brand-color-on-tint'

/**
 * 深色下 `--td-brand-color` 作**底色**时的取值。
 *
 * TDesign 的深色品牌色 #4582e6 亮度偏高，白字压它只有 3.43:1 —— 这是本项目
 * 自己的问题（TDesign 面向大屏，字号大、对比要求低），必须压暗。
 * 往下调到 #2667d4（primary-color-7）：白字 4.83:1 达标，且仍是明确的蓝。
 *
 * 注意这会让 t-button--primary 的底色变深一点：深色下按钮本来就是深底，
 * 再深一档不影响观感，但**白字更清楚了**，这才是要的。
 */
/**
 * 深色下 `--td-brand-color` 作**底色**时的取值。**单元素数组**而不是裸三元组 ——
 * 形状与 `DARK_READABILITY` 保持一致，两边就能用同一个 `[...A, ...B]` 展开。
 * （曾经写成裸三元组，展开时被摊平成三个字符串，产出的 CSS 整条作废。）
 *
 * TDesign 的深色品牌色 #4582e6 亮度偏高，白字压它只有 3.43:1 —— 这是本项目
 * 自己的问题（TDesign 面向大屏，字号大、对比要求低），必须压暗。
 * 往下调到 #2667d4（primary-color-7）：白字 4.83:1 达标，且仍是明确的蓝。
 * 深色下按钮本来就是深底，再深一档不影响观感，但**白字更清楚了**。
 *
 * ⚠️ **2026-10-09 改到 #3f5bf6**：主题从"能用的深灰"改成"深空墨蓝"之后，
 * #2667d4 在新底（#141822）上显得又暗又旧——它是为 TDesign 原底 #242424 挑的。
 * #3f5bf6 白字 **5.20:1**（比旧值还高），色相从"企业蓝"偏到"靛蓝"，
 * 与下面 `DARK_PAINT` 的渐变另一端 #6d5cf0 同一族 ⇒ 渐变看不出来是接缝。
 */
const DARK_BRAND_BG = [['--td-brand-color', '#3f5bf6', '4.83 → 5.20（压白字）']]
/**
 * `${BRAND_ON_TINT}` 在深色下的取值。浅色那边同值（#0052d9），所以 wxss 里
 * 无条件用这个变量、浅色观感不变。实测：压 brand-1 浅底 4.87:1、压卡片底 5.66:1。
 *
 * ⚠️ 2026-10-09 改到 #8aa4ff：`DARK_BRAND_BG` 亮了一档之后，字色这一侧必须跟着亮，
 * 否则「品牌字压品牌浅底」会掉到 4.5 以下。实测压 brand-1（#1b2550）**6.19:1**。
 */
const DARK_BRAND_ON_TINT = '#8aa4ff'

/**
 * ── 深色「表面色阶」：从中性灰换成冷调墨蓝（2026-10-09）─────────────────
 *
 * ## 为什么这一层是整轮改动里最要紧的一条
 *
 * TDesign 的深色分支是一套**纯中性灰**（#181818 / #242424 / #2c2c2c / #383838）。
 * 它能用，但它是"默认深色"的样子：把界面调暗就结束了，**没有任何一处是为了
 * 让人愿意多看一眼而设计的**。本项目把深色做成**分享裂变的奖励**——
 * 奖励必须是"打开就想截图"的那一档，"功能一样只是颜色深"不算奖励。
 *
 * 换掉它的收益是**全局**的：这些变量同时喂给 `--td-bg-color-page/container/
 * secondarycontainer/component` 与两级描边，而本项目的 `--drc-surface-*`、
 * `--drc-border*` 语义 token 又指到它们上面 ⇒ 改这一处，四十多个类名一起变。
 *
 * ## 取值怎么挑的（不是"看着好看"，是三条算出来的）
 *
 * ① **色相统一偏冷**（蓝紫方向），最深一档压到 #0a0b10：中性灰的深色在 OLED 上
 *    会显得"发灰发脏"，冷调墨蓝在纯黑背景上更干净。
 * ② **相邻两档必须能看出差别**，实测各 1.11:1 —— 这是"层次"的下限：
 *    再接近，页面/卡片/代码块就糊成一片；再远，卡片会飘起来。
 * ③ **描边不能太亮**。TDesign 深色的 `--td-component-border` 是 gray-9 = #5e5e5e，
 *    那是**浅色档的描边**在深底上的样子，整屏卡片被一圈灰线框住、发灰。
 *    压到 #414b63（对卡片底 1.7:1）后，层次交给 `app.wxss` 的 `.card` 投影与内高光。
 *
 * ⚠️ gray-8..11 在 TDesign 深色分支里**只被当作底色与描边**（已逐个 grep 确认：
 * bg-color-component / secondarycomponent / border-level-1/2 / component-stroke），
 * 没有任何一处拿它们当前景 —— 所以整条色阶可以安全换掉，不会连带改掉文字色。
 */
const DARK_SURFACE = [
  ['--td-gray-color-14', '#0a0b10', '页面底。TDesign 原值 #181818 —— 在纯黑 OLED 上偏灰'],
  ['--td-gray-color-13', '#141822', '卡片底：与页面底差 1.11:1，卡片才"浮"得起来'],
  ['--td-gray-color-12', '#1c2130', '陷入一层：代码块、引用块'],
  ['--td-gray-color-11', '#242c3d', '组件底 + 一级分割线'],
  ['--td-gray-color-10', '#333c52', '组件底（按下态）/ 二级底'],
  ['--td-gray-color-9', '#414b63', '二级分割线 + 卡片描边。⚠️ TDesign 原值 #5e5e5e 是给浅底用的，深底上整屏发灰'],
  ['--td-gray-color-8', '#5a6480', '次级组件底（激活态）'],
]

/**
 * ── 深色「亮点」素材（2026-10-09）────────────────────────────────────
 *
 * 表面色阶把深色**做干净**了，但"干净"不等于"好看"—— 干净是及格线，好看要另外给。
 * 这一层是给 `app.wxss` / 各页 wxss 用的**效果素材**：极光、辉光、品牌渐变。
 *
 * ## 为什么不进 `theme/tokens.mjs`（那个表才是"设计 token 唯一事实源"）
 *
 * 表里的 token 值只能是 `0` / `Nrpx` / `var(--td-…)` 三种（`checkTokens` 逐条卡），
 * 而渐变是 `linear-gradient(...)` —— 塞进去会被生成期体检当场拒绝。
 * 另一条路是"表里写 `var(--td-brand-gradient)`、两套主题都声明那个 `--td-*`"，
 * 但本轮**刻意不做**：浅色主题的外观一个字都不该动（用户只点了深色），
 * 而为几个深色专属效果去动浅色，是拿"表的整齐"换"用户没要求的东西"。
 *
 * ⇒ 结论：这些是**深色主题专属的效果值**，定义在这一层（只在 `.theme-dark` 生效），
 * wxss 里直接 `var(--td-…)` 引用 —— 与现有三十多处 `var(--td-brand-color)` 同款写法。
 * 配套判据在 `e2e/mp-theme.test.mjs`（「深色效果素材不许悬空」）——
 * **引用一个不存在的变量是静默失效**：不报错，只是那一处什么效果都没有。
 *
 * ## 两端的对比度都算过，不是"看着配"
 *
 * `--td-brand-gradient` 的两端 #3f5bf6 / #6d5cf0 压白字分别是 5.20:1 与 4.73:1，
 * 都过 4.5 —— 用户气泡里的白字落在渐变哪一端都读得清。
 * ⚠️ 对比度闸读的是 `background-color`（#3f5bf6，5.20:1），**看不见 `background-image`**
 * ⇒ 渐变那一层是闸门的盲区，所以两端必须手工守住，理由写在这里而不是留在脑子里。
 */
const DARK_PAINT = [
  ['--td-brand-gradient', 'linear-gradient(135deg, #3f5bf6 0%, #6d5cf0 100%)', '品牌渐变：用户气泡与徽标'],
  ['--td-aurora-indigo', 'rgba(99, 102, 241, 0.20)', '极光·靛：列表页顶部环境光'],
  ['--td-aurora-cyan', 'rgba(34, 211, 238, 0.13)', '极光·青：叠在靛上，冷暖对冲'],
  ['--td-glow-brand', 'rgba(99, 102, 241, 0.42)', '品牌辉光：状态灯 / 主徽标的外圈'],
  ['--td-glow-success', 'rgba(31, 214, 153, 0.34)', '在线灯的呼吸辉光'],
  // ⚠️ 语义色的辉光**不**从 --td-error-color-6 之类派生：那些是"给字用的浅色值"，
  // 当辉光会亮得刺眼（它要的是"暗处的一圈光"，不是"看得清"）。这里各给一档更暗的。
  ['--td-glow-warning', 'rgba(240, 160, 90, 0.30)', '等待灯的辉光'],
  ['--td-glow-danger', 'rgba(255, 138, 146, 0.28)', '异常灯的辉光'],
  ['--td-card-sheen', 'rgba(255, 255, 255, 0.055)', '卡片顶边内高光（"玻璃浮起"那一线）'],
]

/**
 * ── 浅色「表面色阶 + 打断 secondarycontainer 的别名」（2026-10-10）─────
 *
 * ## 这一层修的是一个**被追了很久、但一直没找到根因**的缺陷
 *
 * `chat.wxss` 里有两段长注释（`.todo-bar` 与 `.composer-pill`）在讲同一件事：
 * 「浅色主题里 `--td-bg-color-page` 与 `--td-bg-color-secondarycontainer` 是同一个值，
 * 所以拿 secondarycontainer 做层次区分在这里**不产生任何区分**」，用户先后报过
 * 「待办条的背景也没了」「把文本框样式弄没了」，为此还把整页的层次退化成"只有两档"。
 *
 * **根因在 TDesign 的浅色分支里**（已 grep 确认，只有这两个变量）：
 *     --td-bg-color-page:            var(--td-gray-color-1)
 *     --td-bg-color-secondarycontainer: var(--td-gray-color-1)
 * 两者是**同一个别名的两份拷贝** —— 所以只改 gray-1 永远分不开它们，
 * 必须把 `--td-bg-color-secondarycontainer` **直接覆写**（下面那一行就是拆别名）。
 *
 * ## 拆掉之后，哪些地方会真的变好（不是"顺手改改"）
 *
 * | 位置 | 改之前 | 改之后 |
 * |---|---|---|
 * | `.demo-strip`（演示横幅，直接贴在页面上） | 与页面同色 ⇒ **底色等于没画** | 冷灰、看得出是一条横幅 |
 * | 代码块 / 引用块 / `.step-v` | 靠"卡片是白的"勉强有层次 | 有了真正的下沉档 |
 * | `.pill` 默认态、`.composer-pill` | 在**白卡上**才看得出灰 | 不变（仍比白深） |
 *
 * ⚠️ 两档的方向是**深**而不是**浅**：页面已经是浅灰、卡片是纯白，
 * 再往上没有空间了；而"次要容器"在 TDesign 的语义里本来就是**下沉**的那一档。
 *
 * ⚠️ 色相走冷（蓝灰）而不是中性灰：与深色主题的"深空墨蓝"同一族，
 * 两个主题切换时不会像换了一个 App。中性灰的浅色在手机屏上偏"脏"，冷灰更干净。
 */
const LIGHT_SURFACE = [
  ['--td-gray-color-1', '#eff2f7', '页面底。TDesign 原值 #f3f3f3（中性灰）'],
  // ⚠️⚠️ **这一行是整个浅色改版的核心**：它不是"再调一个灰"，
  // 而是把上面那个别名**拆开** —— 不拆的话 gray-1 改到哪儿它就跟到哪儿。
  ['--td-bg-color-secondarycontainer', '#e5ebf5', '下沉一层（代码块/横幅/胶囊）。**必须显式覆写以打断与 page 的别名**'],
  ['--td-gray-color-2', '#e9edf4', '组件禁用底'],
  ['--td-gray-color-3', '#e1e7f0', '组件底 + 一级分割线'],
  ['--td-gray-color-4', '#d3dae7', '二级分割线 + 卡片描边'],
]

/**
 * 浅色「品牌」：从 TDesign 的企业蓝 `#0052d9` 换成与深色同族的靛蓝。
 *
 * 为什么值得改：深色那侧已经定成 `#3f5bf6 → #6d5cf0` 的靛紫渐变，
 * 而浅色还是 TDesign 的 `#0052d9`（偏青的"企业蓝"）—— 两个主题放在一起
 * 像两个产品。换成 `#2f4bd6` 之后，浅色的品牌面与深色是**同一族的深浅两档**。
 *
 * ⚠️ 浅色**不需要**像深色那样把"底色"与"字色"拆成两个变量：`#2f4bd6` 够深，
 * 白字压它 6.78:1、它压白卡 6.78:1、压 brand-1 浅底 5.82:1 —— 一个值同时满足
 * 两个角色。深色那边是因为品牌色必须**变亮**才压得住深底，才被迫拆开。
 */
const LIGHT_BRAND = [['--td-brand-color', '#2f4bd6', '企业蓝 → 与深色同族的靛蓝']]

/**
 * 浅色「亮点素材」。与 `DARK_PAINT` 一一对应，但**物理不一样**：
 *
 * 深色底靠"发光"（在半透明里加亮），浅色底靠"加深/加阴影"（亮上加亮等于没加）。
 * 所以浅色这边的 `--td-wash-*` 是**品牌色的极低透明度**（页面顶部一层几乎看不见的
 * 冷调），`--td-ring-*` 是状态灯外面那圈**实色描边环**（不是辉光）。
 *
 * ⚠️ 命名与深色**故意不共用**（`--td-ring-*` vs `--td-glow-*`）：
 * 同名会让人以为可以把两套值互换，而它们在不同的底上起相反的作用。
 */
const LIGHT_PAINT = [
  ['--td-brand-gradient', 'linear-gradient(135deg, #2f4bd6 0%, #6d5cf0 100%)', '品牌渐变，与深色共用第二个色标'],
  // ⚠️ 名字要说**是什么色**，不要 a/b。深色那侧叫 aurora-indigo / aurora-cyan，
  // 浅色这侧第一批写成了 wash-a / wash-b —— 主题交叉对比时立刻显形：
  // "a" 与 "b" 什么也没说，改的时候没人知道该动哪一个。改成按色相命名。
  ['--td-wash-brand', 'rgba(47, 75, 214, 0.070)', '页面顶部一层极淡的品牌靛（浅色的"环境光"）'],
  ['--td-wash-violet', 'rgba(109, 92, 240, 0.055)', '叠在右侧的紫，冷暖对冲'],
  // 状态灯环：浅色下"发光"会糊成一团脏色，改成一圈比底色深一档的**实色环**。
  ['--td-ring-success', 'rgba(0, 122, 78, 0.16)', '在线灯外环'],
  ['--td-ring-brand', 'rgba(47, 75, 214, 0.16)', '品牌灯外环'],
  ['--td-ring-warning', 'rgba(168, 79, 0, 0.16)', '等待灯外环'],
  ['--td-ring-danger', 'rgba(201, 60, 52, 0.16)', '异常灯外环'],
]

/**
 * ── 浅色补齐：**TDesign 的深色分支定义了、浅色分支没有**的变量（2026-10-10）
 *
 * ## 这个缺口是怎么被发现的、以及它为什么真的要补
 *
 * 主题交叉对比（`node .tmp/theme-diff.mjs`）把两套表逐个变量并排，
 * 发现 TDesign 其实给了**两个** `@media (prefers-color-scheme:dark)`：
 * 第二段的九个变量**浅色那边一个都没有**。于是：
 *
 *   `_index.wxss` 的 `@media (prefers-color-scheme:dark)` 段在
 *   **系统是深色**时照样生效（media 查的是系统，与我们的 class 无关），
 *   而 `theme/light.wxss` 只覆写"浅色分支里有过的"那些 ⇒ 这几个变量
 *   **原样留着深色的值**。
 *
 * ⇒ 后果是：**浅色主题的渲染结果取决于用户的系统配色**。而本项目的整个前提
 * 恰恰是"主题只由用户那颗按钮决定，与系统无关"（`app.json` 写死 `darkmode:false`、
 * 两套变量都从 `@media` 里解放出来）。系统深色 + 应用浅色（**默认态**）
 * 这个组合下，浅色主题是"不完整"的。
 *
 * ## 实际影响有多大（**如实说，不夸大**）
 *
 * 六个变量里只有两个是**绝对色**（其余是 `var(--td-gray-color-N)` 这类主题相对引用，
 * 会自己解析成浅色的值，安全）：
 *   · `--td-button-primary-disabled-color` —— 真的被 `button.wxss` 用作**字色**：
 *     `color:var(--td-button-primary-disabled-color, …)`。泄漏时白字从"纯白"变成
 *     "40% 白"，而它压的是浅蓝的禁用底 ⇒ 那两个字更淡。**是缺陷，但很轻**
 *     （禁用态本来就该低对比）。
 *   · `--td-skeleton-animation-gradient` —— 绝对白 `rgba(255,255,255,.06)`，
 *     在浅色下等于没有。⚠️ 本项目**没有**用 t-skeleton（用自己的 `drc-skeleton`）
 *     ⇒ 目前不产生可见影响。
 *
 * ⇒ 所以这一条**不是**"修一个用户看得见的 bug"，而是**关掉一个"浅色依赖系统"的口子**：
 * 它今天很轻，但它会让"浅色主题到底是什么样"变成一个没有唯一答案的问题 ——
 * 而这正是这个文件存在的全部意义。补上之后，`theme/light.wxss` 变得**自足**。
 *
 * ## 取值
 *
 * 一律取"浅色分支里本来就该有的那个值"，而不是我为浅色另发明一个：
 *   · 前三个是 TDesign 深色分支里那些**主题相对引用**的原文 —— 抄过来，
 *     它们会各自解析成浅色的对应档，与"系统是浅色"时**逐字等价**（可对拍）；
 *   · `button-primary-disabled-color` 取 `--td-text-color-anti`，
 *     正是 TDesign 在 button.wxss 里写的那个兜底 —— 把不可达的兜底变成可达的声明；
 *   · skeleton 的微光在浅底上必须**加深**而不是加亮，换成 6% 的黑。
 */
const LIGHT_FIXUPS = [
  ['--td-button-primary-disabled-color', 'var(--td-text-color-anti)', '禁用主按钮的字色：把 button.wxss 里那个兜底显式化'],
  ['--td-skeleton-animation-gradient', 'rgba(0, 0, 0, 0.06)', '骨架屏微光：浅底上要加深（TDesign 给的是 6% 白，浅底上等于没有）'],
  ['--td-slider-dot-bg-color', 'var(--td-gray-color-4)', '与深色分支逐字相同 —— 主题相对引用，两套各自解析'],
  ['--td-slider-dot-disabled-bg-color', 'var(--td-gray-color-11)', '同上'],
  ['--td-slider-dot-disabled-border-color', 'var(--td-gray-color-12)', '同上'],
  // ⚠️ 深色分支里这个写的是 `var(--bg-color-page)` —— 少一个 `td-` 前缀，
  // 是 TDesign 自己的拼写事故（该引用解析不到，整条声明无效）。
  // 补的时候**不要照抄**，直接给正确的引用。
  ['--td-progress-circle-inner-bg-color', 'var(--td-bg-color-container)', '深色分支那句引用写错了（--bg-color-page 少了 td-），这里给正确值'],
]

/**
 * 浅色侧同样的可读性修正。
 *
 * 深色那侧的问题在深色更明显，但浅色**也不达标**：TDesign 的 placeholder 是
 * `rgba(0,0,0,.4)`，压页面底 `#f3f3f3` 只有 2.81:1。这一档是"次要文字"里用量最大的
 * —— 会话时间戳、工作区路径、占位符、系统 note、"已隐藏 N 个"，在户外阳光下
 * 基本看不清。提到 `rgba(0,0,0,.54)` → 4.48:1。
 *
 * disabled 提到 0.4（2.81:1）。它本来就该弱于 placeholder（"置灰"是语义），
 * 所以不追 4.5 —— 4.5 的正文阈值是用来判**能不能读**的，而 disabled 的意思
 * 恰恰是"现在不该读"。
 */
const LIGHT_READABILITY = [
  // 0.56 而不是更高的值：这是**三个底都过 4.5 的最小改动**
  // （压页面底 4.79 / 卡片底 4.94 / 下沉底 4.71）。再往上走会让这一档
  // 追上 secondary（0.6），"次要文字"与"辅助说明"就分不出层次了。
  // ⚠️ 数字跟着 `LIGHT_SURFACE` 的页面底走：2026-10-10 页面底从 #f3f3f3 换成
  // #eff2f7 之后，压页面那一档从 4.81 掉到 4.79（仍是三档里最紧的那个）。
  ['--td-text-color-placeholder', 'rgba(0, 0, 0, 0.56)', '2.81 → 4.79'],
  ['--td-text-color-disabled', 'rgba(0, 0, 0, 0.4)', '1.87 → 2.81'],
  // 语义色的 -6 档压自己的 -1 浅底（.pill.success / .step-tick.completed /
  // .act-danger / .sess-badge.warning）。TDesign 给的浅色值都只差一点：
  // 4.07 / 3.90 / 4.09。各调暗一档就到 4.5 以上，改动幅度小到看不出色相变化。
  ['--td-success-color-6', '#007a4e', '4.07 → 4.88'],
  // ⚠️ **这个红 2026-10-10 又动了一格**（#c93c34 → #c0342c，只差约 2% 亮度）：
  // 它在旧页面底 #f3f3f3 上是 4.53，换到新页底 #eff2f7 之后掉到 **4.48 —— 差 0.02 不达标**。
  // 这不是"顺手调一调"，是 `check-mp-contrast` 当场打红逼出来的：
  // `.panel-timer.urgent` 与 `.user-failed` 两处正文字色就压在页面底上。
  // ⇒ 0.02 的余量说明**原来的 4.53 本来就在刀尖上**，底一动就翻。
  // 新值在三个底上分别是 4.97 / 5.57（卡片）/ 5.03（-1 浅底），留出了余量。
  ['--td-error-color-6', '#c0342c', '3.90 → 4.97'],
  ['--td-warning-color-6', '#a84f00', '4.09 → 4.95'],
]

/** 把 `@media (prefers-color-scheme:<kind>){ … }` 的 body 逐个抠出来（按花括号配平） */
function extractBlocks(css, kind) {
  const blocks = []
  const re = new RegExp('@media\\s*\\(prefers-color-scheme\\s*:\\s*' + kind + '\\)\\s*\\{', 'g')
  let m
  while ((m = re.exec(css))) {
    let i = re.lastIndex
    let depth = 1
    const start = i
    while (i < css.length && depth > 0) {
      const ch = css[i]
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      i += 1
    }
    if (depth !== 0) throw new Error('花括号没有配平，TDesign 的产物结构变了？')
    const body = css.slice(start, i - 1).trim()
    if (body) blocks.push(body)
    re.lastIndex = i
  }
  return blocks
}

/** 把块里 `.page,page` 这个选择器换成别的（深色要挂到 class 上） */
function retarget(css, from, to) {
  return css.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to)
}

/** 收集块里定义过的变量名 */
function varNames(blocks) {
  const names = new Set()
  for (const b of blocks) for (const m of b.matchAll(/--td-[a-z0-9-]+(?=\s*:)/g)) names.add(m[0])
  return names
}

const src = fs.readFileSync(SRC, 'utf8')
const lightBlocks = extractBlocks(src, 'light')
const darkBlocks = extractBlocks(src, 'dark')
if (!lightBlocks.length) throw new Error(`没在 ${path.relative(ROOT, SRC)} 里找到浅色分支`)
if (!darkBlocks.length) throw new Error(`没在 ${path.relative(ROOT, SRC)} 里找到深色分支`)

// 深色补齐：TDesign 深色分支缺的变量，显式给值。
// 放在**所有深色块之后**的独立一段里，顺序上自然覆盖浅色表的继承值。
const darkFixupCss = `.theme-dark, .theme-dark page {${DARK_ONLY_FIXUPS.map(
  ([k, v]) => `${k}:${v};`,
).join('')}}`

// 深色可读性修正：同样放在最后，压过 TDesign 的深色原值。
//
// 三者形状一致（DARK_BRAND_BG / DARK_READABILITY / DARK_ONLY_FIXUPS 都是
// 「三元组数组」），所以 `[...A, ...B]` 是安全的。之前 `DARK_BRAND_BG` 是**裸三元组**，
// 展开时被摊平成三个字符串 → 模板拿到 '-:-' 当变量名 →
// 产出 `.theme-dark{-:-;#:2;3:.;…}`，这段非法声明让**整条规则作废**，
// 同规则里的 placeholder 与语义色修正跟着一起失效 —— 静默的，肉眼看不出来。
// 现在形状统一了；`checkCssSanity` 负责兜住这类事故。
const darkReadableCss = `/* 可读性修正（TDesign 深色值在小屏上偏暗，实测对比度见上） */
.theme-dark, .theme-dark page {${[...DARK_BRAND_BG, ...DARK_READABILITY]
  .map(([k, v]) => `${k}:${v};`)
  .join('')}${BRAND_ON_TINT}:${DARK_BRAND_ON_TINT};}`

/**
 * 深色「表面色阶 + 亮点素材」（2026-10-09）。
 *
 * ⚠️ **必须排在 `darkReadableCss` 之后**，两者改的是同一批变量：
 * `DARK_SURFACE` 动的是 gray-8..14（底色与描边），`DARK_READABILITY` 动的是
 * text-color-* 与语义色。写反了会让可读性修正里的 brand/语义色被下面的色阶盖掉
 * —— 而那种错**看不出来**（CSS 合法，只是结果与注释里写的不一样）。
 *
 * 单独成段而不是并进 `darkReadableCss`：那一段的语义是"修 TDesign 的可读性"，
 * 这一段是"换一整套深色风格"。混在一起，后来的人不敢动任何一行。
 */
const darkSurfaceCss = `/* 深空墨蓝：表面色阶 + 亮点素材（取代 TDesign 的纯中性灰深色） */
.theme-dark, .theme-dark page {${[...DARK_SURFACE, ...DARK_PAINT]
  .map(([k, v]) => `${k}:${v};`)
  .join('')}}`

/* ── 色阶序校验：primary > secondary > placeholder > disabled ──────────
   修正 alpha 时最容易犯的错是把某一档调得比上一档还亮，于是"占位符比正文还
   显眼"。这里在生成时就算一遍，破了直接报错 —— 靠肉眼看截图是看不出来的
   （两档都是灰白，差 5% 亮度在手机上几乎无法分辨）。

   浅色与深色**都要验**：两边的修正表是分开的，改了一边忘了另一边是很容易的。 */
function checkReadabilityOrder(blocks, fixups, bgHex, label) {
  const toRgb = (v) => {
    const s = String(v).trim()
    let m = s.match(/^#([0-9a-f]{3,8})$/i)
    if (m) {
      const h = m[1]
      if (h.length === 3 || h.length === 4) {
        const [r, g, b, a] = h.split('')
        return [r + r, g + g, b + b, a + a].map((x) => parseInt(x, 16) / 255)
      }
      return [
        parseInt(h.slice(0, 2), 16) / 255,
        parseInt(h.slice(2, 4), 16) / 255,
        parseInt(h.slice(4, 6), 16) / 255,
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ]
    }
    m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?\s*\)$/i)
    if (m) {
      let a = 1
      if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
      return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, a]
    }
    return null
  }
  const lum = ([r, g, b]) => {
    const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const bg = toRgb(bgHex)

  // 该主题分支的全部变量：TDesign 原值 + 本脚本的修正（修正在后，覆盖原值）
  const values = new Map()
  for (const b of blocks) {
    for (const m of b.matchAll(/(--td-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) values.set(m[1], m[2].trim())
  }
  for (const [k, v] of fixups) values.set(k, v)

  /** 把一层 var() 链解析到底；解析不出来返回 null（那就跳过这一档） */
  const resolve = (name, depth = 0) => {
    if (depth > 6) return null
    const raw = values.get(name)
    if (raw == null) return null
    const m = raw.match(/^var\(\s*(--td-[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/)
    if (!m) return toRgb(raw)
    if (m[2]) {
      const fb = toRgb(m[2])
      if (fb) return fb
    }
    return resolve(m[1], depth + 1)
  }

  // ── 判据用「对比度递减」，不是「亮度递增/递减」 ──────────────────────
  // 直觉上两个主题方向相反：深色白字越往后越**暗**（primary .9 → disabled .4），
  // 浅色黑字越往后越**亮**（primary .9 → disabled .4，压在浅底上亮度反而升）。
  // 两次都写错过判据（先写死"递减"→ 浅色报三条假错；改成"深色递增"→ 深色
  // 报三条假错）。**唯一两边都成立的是"正文比次要文字更醒目"**，也就是
  // 对比度递减 —— WCAG 本来就是用对比度衡量可读性的，用它当判据最自然。
  const contrast = (fg, bg) => {
    const l1 = lum(flattenOn(fg, bg))
    const l2 = lum(bg)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  const flattenOn = (fg, bg) => (fg[3] >= 1
    ? fg.slice(0, 3)
    : [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])))

  const chain = [
    '--td-text-color-primary',
    '--td-text-color-secondary',
    '--td-text-color-placeholder',
    '--td-text-color-disabled',
  ]
  const problems = []
  for (let i = 1; i < chain.length; i++) {
    const pf = resolve(chain[i - 1])
    const cf = resolve(chain[i])
    if (!pf || !cf) continue // 解析不出来的档位跳过，不误报
    const a = contrast(pf, bg)
    const b = contrast(cf, bg)
    if (b >= a) {
      problems.push(
        `${chain[i]}（对比度 ${b.toFixed(2)}:1）不比上一档 ${chain[i - 1]}（${a.toFixed(2)}:1）醒目`,
      )
    }
  }
  if (problems.length) {
    console.error(`${label}灰阶序被破坏（每一档都要比上一档更不醒目）：`)
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}

/**
 * 拼出来的 CSS 必须是**合法**的 —— 非法的一小段会让整条规则被解析器丢弃，
 * 连带同一规则里的其他修正全部静默失效。
 *
 * 真踩过：`DARK_BRAND_BG` 的元素写成两项而不是 `[名, 值, 备注]` 三元组，
 * 模板把"备注"当值拼进去，产出 `.theme-dark{…-:-;#:2;3:.;…}`。
 * 肉眼看源文件完全正常，生成物里那段也不显眼，但**整条规则作废** ——
 * 于是"修好了"的 placeholder 与语义色其实一个都没生效，
 * 只有那句注释还在说"已修正"。这里把这类错误挡在生成阶段。
 */
function checkCssSanity(name, css) {
  const problems = []
  for (const m of css.matchAll(/\{([^}]*)\}/g)) {
    for (const decl of m[1].split(';')) {
      const s = decl.trim()
      if (!s) continue
      if (!s.startsWith('--')) {
        problems.push(`规则里出现了不以 -- 开头的声明：${JSON.stringify(s.slice(0, 60))}`)
        continue
      }
      const c = s.indexOf(':')
      if (c < 0) {
        problems.push(`声明缺冒号：${JSON.stringify(s.slice(0, 60))}`)
        continue
      }
      const key = s.slice(0, c).trim()
      const val = s.slice(c + 1).trim()
      if (!/^--[a-z0-9-]+$/.test(key)) problems.push(`变量名不合法：${JSON.stringify(key)}`)
      if (!val) problems.push(`${key} 没有值`)
      // 值里含裸分号 / 花括号 = 拼接事故（三元组写成两项就会这样）
      if (/[;{}]/.test(val)) problems.push(`${key} 的值里有非法字符：${JSON.stringify(val.slice(0, 40))}`)
    }
  }
  const open = (css.match(/\{/g) ?? []).length
  const close = (css.match(/\}/g) ?? []).length
  if (open !== close) problems.push(`花括号没配平：${open} 个 { vs ${close} 个 }`)

  if (problems.length) {
    console.error(`${name} 生成的 CSS 不合法（会被解析器整条丢弃，且是静默的）：`)
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}

checkReadabilityOrder(
  darkBlocks,
  [...DARK_ONLY_FIXUPS, ...DARK_BRAND_BG, ...DARK_READABILITY],
  // ⚠️ 底色是**新的卡片底**（DARK_SURFACE 的 gray-13），不是 TDesign 的 #242424。
  // 留着旧值会算错：色阶序校验问的是"这几档文字压在真机上真正碰到的那个底上，
  // 谁比谁醒目"，底选错 = 在一块不存在的底上排序，破了也发现不了。
  '#141822',
  '深色',
)
checkCssSanity('dark.wxss 的可读性修正段', darkReadableCss)
// 同一类事故的另一个入口：这一段的值里带 `linear-gradient(…%…)`，
// 里面带逗号与百分号但没有分号/花括号 —— 一旦哪天有人把三元组写成两项，
// 拼出来就是 `-:-;#:2;` 这种把整条规则作废的东西。
checkCssSanity('dark.wxss 的表面色阶与亮点素材段', darkSurfaceCss)

// 浅色也要声明 ${BRAND_ON_TINT}，值与 --td-brand-color 相同 ——
// 不声明的话浅色下这个变量不存在，wxss 里的 var() 会回退到兜底色，
// 而各处兜底色五花八门（有 #0052d9 有 #4582e6），浅色就会深浅不一。
// 可读性修正同样要落在浅色上：TDesign 的 placeholder 在浅色下也只有 2.81:1。
//
// ⚠️ **这里刻意不写 `,#0052d9` 兜底**（2026-10-10）。原来写的是
// `var(--td-brand-color,#0052d9)`，而 `--td-brand-color` 在浅色里**永远有定义**
// ⇒ 那个兜底不可达、纯装饰。但 `check-mp-contrast.mjs` 的 resolveVar 是
// "**有兜底就用兜底**"（TDesign 用兜底表达"本主题没覆盖"）⇒ 它会拿那句不可达的
// `#0052d9` 当品牌字色的真值，于是**报告里的品牌色永远是旧的那一个**。
// 浅色品牌换成靛蓝之后这就是一句谎：真实值是 #2f4bd6，闸门却在按 #0052d9 算。
// 去掉兜底，两边算的就是同一个值。（wxss 使用处仍各自带 `, #0052d9` 兜底，没风险。）
const lightBrandCss = `.page,page{${BRAND_ON_TINT}:var(--td-brand-color);${LIGHT_READABILITY.map(
  ([k, v]) => `${k}:${v};`,
).join('')}}`
checkCssSanity('light.wxss 的品牌字色与可读性修正段', lightBrandCss)

/**
 * 浅色「表面色阶 + 品牌 + 亮点素材」（2026-10-10）。
 *
 * ⚠️ **必须排在 `lightBlocks` 与 `lightBrandCss` 之后**：这一段改的是
 * `--td-gray-color-1`（页面底）与 `--td-bg-color-secondarycontainer`，
 * 而 TDesign 的浅色分支里那两个变量本身就在前面声明过。
 *
 * ⚠️ 尤其**不能**并进 `lightBrandCss`：那一段的语义是"品牌字色与可读性修正"
 * （只碰文字色），这一段是"换一套浅色风格"（碰底色与描边）。混在一起之后
 * 后来的人不敢动其中任何一行 —— 与深色那侧 `darkSurfaceCss` 单独成段同理。
 */
const lightSurfaceCss = `/* 冷调浅色：表面色阶 + 品牌 + 亮点素材（2026-10-10）
 * ⚠️ 本段第一组里有一行是**拆别名**（--td-bg-color-secondarycontainer）：
 *    TDesign 浅色分支里它与 --td-bg-color-page 都指向 --td-gray-color-1，
 *    不显式覆写就永远与页面同色（"待办条背景没了"那个缺陷的根因）。
 *    生成期与 e2e 各有一条判据守着它，别顺手删。 */
.page,page{${[...LIGHT_BRAND, ...LIGHT_SURFACE, ...LIGHT_PAINT]
  .map(([k, v]) => `${k}:${v};`)
  .join('')}}`
checkCssSanity('light.wxss 的表面色阶与亮点素材段', lightSurfaceCss)

/**
 * 浅色补齐段（`LIGHT_FIXUPS`）：把"只有深色分支定义过"的变量在浅色下显式声明。
 *
 * ⚠️ **必须排在 `lightBlocks` 之后**：它要压掉的正是 `_index.wxss` 里那个
 * `@media (prefers-color-scheme:dark)` 段留下的值（系统深色时它照样生效）。
 * 两者特异性相同（都是 `.page,page`），靠**源码顺序**决胜 ——
 * 而 `app.wxss` 的 import 顺序里 `theme/light.wxss` 在 `_index.wxss` 之后。
 */
const lightFixupCss = `/* 浅色补齐：TDesign 深色分支独有的变量（不补 ⇒ 浅色主题依赖系统配色）
 * 详见 gen-mp-theme.mjs 里 LIGHT_FIXUPS 的注释。 */
.page,page{${LIGHT_FIXUPS.map(([k, v]) => `${k}:${v};`).join('')}}`
checkCssSanity('light.wxss 的浅色补齐段', lightFixupCss)

// 序校验：深色压深色卡片底，浅色压浅色**页面底**。
// 底选错会算出相反的结论（深色那套黑字公式在浅色上是反的）。
// ⚠️ 浅色的底跟着 `LIGHT_SURFACE` 走（2026-10-10 从 #f3f3f3 改成 #eff2f7）——
// 写死旧值等于在一张不存在的底上排序，破了也发现不了。
checkReadabilityOrder(
  lightBlocks,
  LIGHT_READABILITY,
  '#eff2f7',
  '浅色',
)

/**
 * 设计 token 表（阶段 C1）的**生成前体检**。
 *
 * 为什么要在生成阶段再挡一次，而不全交给 `check-mp-tokens.mjs`：
 * 那个脚本是**事后**判据（生成物已经落地了）。而这里挡的是"表被改坏的那一瞬间"
 * —— 网格破了、值写成裸变量名、名字拼错，都会直接产出一份**语法合法但语义错**
 * 的 CSS，而 `checkCssSanity` 查不出来（它只管语法）。
 *
 * ⚠️ 特别挡住 `--drc-fg-muted: --td-text-color-placeholder` 这种写法：
 * 它合法、能解析、不报错，但值是字符串而不是颜色 —— 用到它的地方会变成
 * "没有颜色"，而界面上表现为**继承父级**，看上去只是"这一处没生效"。
 */
function checkTokens() {
  const problems = []
  const seen = new Set()
  for (const t of TOKENS) {
    if (!t.name.startsWith('--drc-')) problems.push(`${t.name}：token 必须用 --drc- 前缀`)
    if (seen.has(t.name)) problems.push(`${t.name} 重复定义`)
    seen.add(t.name)
    if (!t.why || t.why.length < 8) problems.push(`${t.name} 缺"为什么有这一档" —— 下次重构会把它当冗余删掉`)
    const v = String(t.value)
    if (v.startsWith('--')) {
      problems.push(`${t.name}: ${v} —— 引用变量必须写完整的 var(${v})，写裸变量名得到的是字符串不是颜色`)
      continue
    }
    const ref = /^var\(--[a-z0-9-]+\)$/.exec(v)
    if (ref) continue // 语义 token：值是引用，不参与网格
    // 几何 / 字号：必须是网格的整数倍
    const m = /^(\d+(?:\.\d+)?)rpx$/.exec(v)
    if (!m) {
      if (v !== '0') problems.push(`${t.name}: ${v} —— 既不是 0 也不是 Nrpx 也不是 var()`)
      continue
    }
    const n = Number(m[1])
    const gridExempt = t.grid === 'exempt'
    if (GEOMETRY_GROUPS.includes(t.group) && !gridExempt && n % GRID_RPX !== 0) {
      problems.push(`${t.name}: ${v} 不在 ${GRID_RPX}rpx（4px）网格上 —— 破了网格就没法"整体调一档"`)
    }
    if (gridExempt && n % GRID_RPX === 0) {
      problems.push(`${t.name}: ${v} 标了 grid:'exempt' 但本身就在网格上 —— 那条豁免是多余的，删掉它`)
    }
    if (TYPE_GROUPS.includes(t.group) && n % TYPE_STEP_RPX !== 0) {
      problems.push(`${t.name}: ${v} 不在 ${TYPE_STEP_RPX}rpx（2px）字号阶梯上`)
    }
  }
  if (problems.length) {
    console.error('theme/tokens.mjs 的表有问题（生成的 CSS 会语义错但语法对）：')
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}
checkTokens()

const tokenCss = `.page,page{${tokenDecls()}}`
checkCssSanity('设计 token 段', tokenCss)
const tokenCssDark = retarget(tokenCss, '.page,page', '.theme-dark,.theme-dark page')

const lightHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：miniprogram/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：把 TDesign 的浅色变量从 @media (prefers-color-scheme:light) 里解放出来，
 *      无条件生效。选择器与 TDesign 一样是 .page,page，所以深色分支也被压掉了 ——
 *      系统是深色也一样是白底深字。
 *
 * 末尾另有一段 **设计 token（--drc-*）**，来自 theme/tokens.mjs（阶段 C1 的唯一事实源）。
 *
 * 还有一段 **冷调浅色（2026-10-10）**：表面色阶 + 品牌 + 亮点素材。
 * ⚠️ 其中一行是**拆别名** —— TDesign 浅色分支把 --td-bg-color-page 与
 * --td-bg-color-secondarycontainer 都指向 --td-gray-color-1，
 * 不显式覆写后者，"贴在页面上的底色"就永远与页面同色。
 *
 * 共 ${lightBlocks.length} 段 + 品牌/可读性 1 段 + 冷调浅色 1 段 + 设计 token ${TOKENS.length} 项。
 */
`

const darkHeader = `/* 生成物，不要手改 —— 重新生成：node scripts/gen-mp-theme.mjs
 *
 * 来源：miniprogram/miniprogram_npm/tdesign-miniprogram/common/style/theme/_index.wxss
 * 作用：深色主题变量。选择器从 TDesign 的 .page,page 换成 .theme-dark ——
 *      **挂在页面根容器的 class 上**，而不是 page 上。
 *
 * 为什么不能继续用 page：page 上已经挂着浅色表（那是默认态），两套都写 page
 * 就只能靠"源码顺序"决胜，而那是单向的 —— 压得住深色、切不回浅色。挂 class 之后
 * "用不用深色"由根容器的 class 说了算，与系统深色无关（这才是"用户手动切"）。
 *
 * 必须在 theme/light.wxss **之后** import：浅色表写在 page 上会向下继承，
 * 本文件靠"同特异性下靠后胜出"把它压掉。
 *
 * 末尾另有一段 **设计 token（--drc-*）**，来自 theme/tokens.mjs。
 * ⚠️ 它与浅色那份**逐项同名同值**，但选择器是 .theme-dark —— 几何与语义名
 * 都不随主题变，所以两份只差选择器；语义 token 指到 --td-* 上，由本文件自己的
 * 深浅变量给出不同的解析结果。
 *
 * 共 ${darkBlocks.length} 段 + 1 段补齐（TDesign 深色分支缺 --td-shadow-4 与
 * --td-scrollbar-hover-color，不补会继承到浅色值，深色里就有一块浅色阴影）
 * + 可读性修正 + **表面色阶与亮点素材（深空墨蓝，2026-10-09）**
 * + 设计 token ${TOKENS.length} 项。
 */
`

const outputs = [
  {
    file: path.join(ROOT, 'theme/light.wxss'),
    content:
      lightHeader +
      lightBlocks.join('\n') +
      '\n' +
      lightBrandCss +
      '\n' +
      lightSurfaceCss +
      '\n' +
      lightFixupCss +
      '\n' +
      tokenCss +
      '\n',
    desc:
      `浅色（默认）主题，${lightBlocks.length} 段 + 表面色阶 ${LIGHT_SURFACE.length} 项 + ` +
      `品牌 ${LIGHT_BRAND.length} 项 + 亮点素材 ${LIGHT_PAINT.length} 项 + ` +
      `深色独有变量补齐 ${LIGHT_FIXUPS.length} 项 + 设计 token ${TOKENS.length} 项`,
  },
  {
    file: path.join(ROOT, 'theme/dark.wxss'),
    content:
      darkHeader +
      darkBlocks.map((b) => retarget(b, '.page,page', '.theme-dark,.theme-dark page')).join('\n') +
      '\n' +
      darkFixupCss +
      '\n' +
      darkReadableCss +
      '\n' +
      darkSurfaceCss +
      '\n' +
      tokenCssDark +
      '\n',
    desc:
      `深色主题，${darkBlocks.length} 段 + ${DARK_ONLY_FIXUPS.length} 段补齐 + ` +
      `${DARK_READABILITY.length} 项可读性修正 + 表面色阶 ${DARK_SURFACE.length} 项 + ` +
      `亮点素材 ${DARK_PAINT.length} 项 + 设计 token ${TOKENS.length} 项`,
  },
]

// ── 变量覆盖对账（**两个方向都要**）──────────────────────────────────
//
// 这条断言的价值在于"TDesign 升级后"—— 新增变量忘了进另一套分支，这里会报出来。
// 两个方向各对应一种**静默**后果：
//   ① 浅色有、深色没有 ⇒ 深色下那个位置**露出浅色值**；
//   ② 深色有、浅色没有 ⇒ 系统是深色时，`_index.wxss` 的 dark media 段
//      会把深色值留给浅色主题 ⇒ **浅色主题的样子取决于系统配色**（2026-10-10 补的）。
{
  const lightNames = varNames(lightBlocks)
  const darkNames = varNames(darkBlocks)
  // 本脚本自己追加的效果素材不算 TDesign 的覆盖面：它们本来就是**主题专属**的
  // （深色有极光/辉光、浅色有环境光/环），不是"另一套漏了"。
  const MATERIAL = new Set([
    ...DARK_PAINT.map(([k]) => k),
    ...LIGHT_PAINT.map(([k]) => k),
    ...LIGHT_FIXUPS.map(([k]) => k),
  ])
  const problems = []

  const lightOnly = [...lightNames].filter(
    (n) => !darkNames.has(n) && !DARK_ONLY_FIXUPS.some(([k]) => k === n),
  )
  if (lightOnly.length) {
    problems.push(
      '浅色有、深色没有（会在深色下露出浅色值）：\n' +
        lightOnly.map((m) => '    · ' + m).join('\n') +
        '\n    若是 TDesign 新增的，补进 DARK_ONLY_FIXUPS 或等它修深色分支。',
    )
  }

  const darkOnly = [...darkNames].filter(
    (n) => !lightNames.has(n) && !MATERIAL.has(n) && !LIGHT_FIXUPS.some(([k]) => k === n),
  )
  if (darkOnly.length) {
    problems.push(
      '深色有、浅色没有（系统是深色时会把深色值留给浅色主题 ⇒ 浅色依赖系统）：\n' +
        darkOnly.map((m) => '    · ' + m).join('\n') +
        '\n    补进 LIGHT_FIXUPS 给一个浅色下该有的值。',
    )
  }

  if (problems.length) {
    console.error('主题变量覆盖对账失败：')
    for (const p of problems) console.error('  ' + p)
    process.exit(1)
  }
}

/**
 * `LIGHT_FIXUPS` / `DARK_ONLY_FIXUPS` 的键也要对账：写了一个 TDesign 里
 * **两边都没有**的变量名，等于凭空造了一个没人用的声明（静默无害，但是垃圾）。
 */
{
  const lightNames = varNames(lightBlocks)
  const darkNames = varNames(darkBlocks)
  const junk = []
  for (const [k] of LIGHT_FIXUPS) if (!darkNames.has(k) && !lightNames.has(k)) junk.push(`LIGHT_FIXUPS 的 ${k}`)
  for (const [k] of DARK_ONLY_FIXUPS) if (!lightNames.has(k) && !darkNames.has(k)) junk.push(`DARK_ONLY_FIXUPS 的 ${k}`)
  if (junk.length) {
    console.error('补齐清单里有两边都不存在的变量（TDesign 改名了？）：')
    for (const j of junk) console.error('  · ' + j)
    process.exit(1)
  }
}

/** 可读性修正项也要对账：改了一个不存在的变量名，等于什么都没改（静默失效） */
for (const [k] of DARK_READABILITY) {
  if (!varNames(darkBlocks).has(k)) {
    console.error(`DARK_READABILITY 里的 ${k} 在 TDesign 深色分支里不存在 —— 这条修正是无效的`)
    console.error('（可能是 TDesign 改名了。确认后改掉这里的键名，或删掉这条。）')
    process.exit(1)
  }
}

/**
 * 表面色阶要**覆盖**的变量必须真的存在于 TDesign 深色分支里（2026-10-09）。
 *
 * ⚠️ 这一条与上面 `DARK_READABILITY` 的那条是同一类事故，但危险方向相反：
 * `DARK_READABILITY` 写错键名 ⇒ 多出一个没人用的变量（无害）；
 * `DARK_SURFACE` 写错键名 ⇒ **页面底根本没换**，而生成物里那段看着好好的、
 * 注释也写着"深空墨蓝" ⇒ 没人会发现深色其实还是 TDesign 的中性灰。
 * 那正是"判据钉了一个不存在的东西"的形状。
 *
 * `DARK_PAINT` 反过来：它定义的 `--td-brand-gradient` 等是**本项目自己的**变量，
 * TDesign 里本来就不该有，所以它走的是"必须不在 TDesign 里"的检查（见下）。
 */
{
  const darkNames = varNames(darkBlocks)
  const problems = []
  for (const [k] of DARK_SURFACE) {
    if (!darkNames.has(k)) {
      problems.push(`DARK_SURFACE 里的 ${k} 在 TDesign 深色分支里不存在 —— 表面色阶没有覆盖到它`)
    }
  }
  // 素材变量不许与 TDesign 同名：撞名会让"改素材"意外改到 TDesign 自己的取值上，
  // 而那是全组件范围的改动，影响面远大于"改一个渐变"。
  for (const [k] of DARK_PAINT) {
    if (darkNames.has(k)) problems.push(`DARK_PAINT 里的 ${k} 与 TDesign 深色分支同名 —— 会覆盖它的原值`)
  }
  if (problems.length) {
    console.error('深色表面色阶 / 亮点素材对账失败：')
    for (const p of problems) console.error('  · ' + p)
    console.error('（键名拼错是**静默失效**：CSS 合法、深色照旧，没人看得见。）')
    process.exit(1)
  }
}

/**
 * 浅色表面色阶 / 亮点素材的对账（2026-10-10）。三条，各挡一种静默失效：
 *
 * ① `LIGHT_SURFACE` 的键必须在 TDesign 浅色分支里真的存在 —— 拼错了就**根本没换**，
 *    而生成物里那段看着好好的、注释还写着"冷调浅色"。
 * ② `LIGHT_PAINT` 的键不许与 TDesign 撞名（撞了就是全组件范围的意外改动）。
 * ③ ⚠️ **浅色那个别名必须真的被拆开** —— 这是本轮浅色改版存在的全部理由。
 *    `--td-bg-color-page` 与 `--td-bg-color-secondarycontainer` 在 TDesign 浅色分支里
 *    是 `--td-gray-color-1` 的两份拷贝；拆别名的那一行被谁删掉，
 *    两个变量立刻又变回同一个值，而**界面只是"某几条底色不见了"**：
 *    没有任何东西会报错，`check-mp-contrast` 也照样全绿（它只算文字对比度）。
 */
{
  const values = new Map()
  for (const b of lightBlocks) {
    for (const m of b.matchAll(/(--td-[a-z0-9-]+)\s*:\s*([^;}]+)/g)) values.set(m[1], m[2].trim())
  }
  for (const [k, v] of [...LIGHT_BRAND, ...LIGHT_SURFACE, ...LIGHT_PAINT]) values.set(k, v)

  const resolve = (name, depth = 0) => {
    if (depth > 8) return null
    const raw = values.get(name)
    if (raw == null) return null
    const m = /^var\(\s*(--td-[a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw)
    if (!m) return String(raw).trim()
    return m[2] ? String(m[2]).trim() : resolve(m[1], depth + 1)
  }

  const lightNames = varNames(lightBlocks)
  const problems = []
  for (const [k] of LIGHT_SURFACE) {
    if (!lightNames.has(k)) {
      problems.push(`LIGHT_SURFACE 里的 ${k} 在 TDesign 浅色分支里不存在 —— 这一档没有覆盖到它`)
    }
  }
  for (const [k] of LIGHT_PAINT) {
    if (lightNames.has(k)) problems.push(`LIGHT_PAINT 里的 ${k} 与 TDesign 浅色分支同名 —— 会覆盖它的原值`)
  }

  const page = resolve('--td-bg-color-page')
  const sunken = resolve('--td-bg-color-secondarycontainer')
  if (!page || !sunken) {
    problems.push(
      `浅色的 --td-bg-color-page / --td-bg-color-secondarycontainer 解析不出颜色（page=${page} / sunken=${sunken}）` +
        ' —— 拆别名那条断言因此失效',
    )
  } else if (page.toLowerCase() === sunken.toLowerCase()) {
    problems.push(
      `浅色下 --td-bg-color-page 与 --td-bg-color-secondarycontainer 又都是 ${page} 了。\n` +
        '    TDesign 浅色分支里这两个变量都指向 --td-gray-color-1，必须**显式覆写**后者才能拆开。\n' +
        '    不拆的后果：贴在页面上的横幅/胶囊 "底色等于没画"（用户报过「待办条的背景也没了」），\n' +
        '    而且**没有任何闸门会红** —— 对比度只算文字，算不出"这条底色看不见"。',
    )
  }
  if (problems.length) {
    console.error('浅色表面色阶 / 品牌 / 亮点素材对账失败：')
    for (const p of problems) console.error('  · ' + p)
    process.exit(1)
  }
}

const check = process.argv.includes('--check')
let failed = false

for (const out of outputs) {
  const rel = path.relative(ROOT, out.file)
  const current = fs.existsSync(out.file) ? fs.readFileSync(out.file, 'utf8') : null
  if (check) {
    if (current === out.content) {
      console.log(`${rel} 已同步（${out.desc}）。`)
    } else {
      failed = true
      console.error(`${rel} 与 TDesign 不一致 —— 跑一下：node scripts/gen-mp-theme.mjs`)
    }
  } else {
    fs.mkdirSync(path.dirname(out.file), { recursive: true })
    fs.writeFileSync(out.file, out.content)
    console.log(`${current === out.content ? '无需改动' : '已写入'} ${rel}（${out.desc}）`)
  }
}

if (failed) process.exit(1)
