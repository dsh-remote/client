/**
 * 工具名 → 中文类别（`activity.js`）。
 *
 * 逐字移植自宿主 `app.asar` 里 `@deepseek-ai/dsh-client-ui-chat` 的
 * `activity(name)`（2026-10-06 从 asar 实测抽出，不是猜的）：
 * 宿主步骤组那行中文（"正在读取文件"而不是 "Read"）就是它算出来的。
 * mp 之前直接显示 `{{it.tool}}` 原样英文（`Bash`），与宿主对不上。
 *
 * 未知工具名宿主返回 "tools"（"正在调用工具"）——这里行为一致：
 * 显示错的类别比显示英文更糟，但宿主就是这么定的，跟它保持一致，
 * 原工具名仍留在副标题位（见 chat.js `_applyTool`），信息不丢。
 *
 * ⚠️ 但"未知"的判定**不含大小写**：真机发的工具名是首字母大写的（Bash / Read），
 * 压成小写再比（见 `activity()` 里那段）。原样比会让所有工具都落进 "tools"。
 *
 * 小程序没有 Intl.Segmenter 依赖问题——这里只用纯字符串比较（indexOf/slice，
 * 与本目录其它 core 文件同一口径，不用 startsWith/endsWith）。
 */

var ACTIVITY_ZH = {
  thinking: '正在分析请求',
  read: '正在读取文件',
  readImage: '正在读取图片',
  write: '正在写入文件',
  search: '正在搜索代码',
  edit: '正在编辑文件',
  commands: '正在运行命令',
  code: '正在运行代码',
  webSearch: '正在搜索网页',
  webFetch: '正在访问网页',
  subagents: '正在协调子智能体',
  plan: '正在更新计划',
  questions: '等待你的操作',
  tools: '正在调用工具',
}

/**
 * 工具名 → 类别键。宿主原函数的分流规则逐字移植
 * （含 `_inspect` 后缀与 `terminal_` / `subagent_` 前缀两条）。
 *
 * ⚠️ **入口先把名字压成小写**（2026-10-08 补，阶段 C3 核对文案机时抓到）。
 *
 * 移植过来的那张表只认小写（`read` / `bash` / `edit`…），而**真机发过来的工具名
 * 是首字母大写的**（宿主内核给的就是 `Bash` / `Read` / `Edit` / `Write`；
 * `carrier-services.ts` 直接透传 `data.name`，不改大小写；mock 内核自己两种都写过）。
 * 于是真机上 `activity('Bash')` 落到 `return 'tools'` —— 界面上**每一个工具**
 * 都显示「正在调用工具」，文案机等于没接。
 *
 * 而判据之所以一直没发现：它测的是**小写**的那几个名字（照宿主的移植源写的），
 * 于是绿的那一侧与真机那一侧根本不是同一批输入。
 *
 * 压小写是**只放宽不收窄**的改法：表里所有键本来就是小写，
 * 所以既有的每一次匹配都还成立，只是把真机那批名字也接住了。
 */
function activity(name) {
  var n = String(name == null ? '' : name).toLowerCase()
  if (n === 'read') return 'read'
  if (n === 'read_image') return 'readImage'
  if (n === 'grep' || n === 'glob' || (n && n.slice(-8) === '_inspect')) return 'search'
  if (n === 'write') return 'write'
  if (n === 'edit' || n === 'apply_patch') return 'edit'
  if (
    n === 'bash' ||
    n === 'pwsh' ||
    n === 'exec_command' ||
    n === 'write_stdin' ||
    (n && n.indexOf('terminal_') === 0)
  )
    return 'commands'
  if (n === 'run_code') return 'code'
  // ⚠️ 两种写法都要认：移植源那张表用的是 `web_search` / `web_fetch`（下划线），
  // 而真机内核发的是 `WebSearch` / `WebFetch`（驼峰，压小写后是连写）。
  // 只认前者的话，真机上这两个工具会掉进 "tools"。
  if (n === 'web_search' || n === 'websearch') return 'webSearch'
  if (n === 'web_fetch' || n === 'webfetch') return 'webFetch'
  if (n === 'subagent' || (n && n.indexOf('subagent_') === 0)) return 'subagents'
  if (n === 'todo_write' || n === 'todowrite' || n === 'create_goal' || n === 'update_goal' || n === 'get_goal')
    return 'plan'
  if (n === 'ask_user_question' || n === 'request_user_input') return 'questions'
  return 'tools'
}

/** 工具名 → 直接能显示的中文（类别未知时宿主也显示"正在调用工具"）。 */
function activityLabel(name) {
  return ACTIVITY_ZH[activity(name)] || ACTIVITY_ZH.tools
}

module.exports = {
  ACTIVITY_ZH: ACTIVITY_ZH,
  activity: activity,
  activityLabel: activityLabel,
}
