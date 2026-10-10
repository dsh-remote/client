/**
 * 演示模式的数据与事件序列。
 *
 * ## 它为什么存在（两个读者，一条红线）
 *
 * 1. **审核员**：这个小程序要配合桌面端才能用，而审核员没有主机、没有二维码。
 *    打开只看到「扫描主机二维码」⇒ 看不到任何实质功能 ⇒ 典型的「功能不完整」拒审。
 *    演示模式让他能在 10 秒内看到这个工具到底长什么样、解决什么问题。
 * 2. **首次打开的用户**：先看清界面再决定要不要装桌面端，比"先配对再说"友好。
 *
 * **红线：演示数据必须一眼可辨是演示。**
 * - 每一条会话标题都带「演示」标记，且会话 id 用 `demo-` 前缀；
 * - 页面顶部常驻一条说明（不是 toast：toast 会消失，而"这是不是真数据"必须在每一帧都看得见）；
 * - **绝不写入任何真实存储、绝不连接中继**（见 `e2e` 里那条反向判据）。
 *   演示模式存在的意义是"看得见"，不是"假装连上了"——后者一旦被审核判成
 *   功能虚假，比"功能不完整"更严重。
 *
 * ## 为什么数据放在这里而不是页面里
 *
 * 两个页面（会话列表 / 聊天）都要用它，而它们各自的 data 是渲染层的东西。
 * 演示数据是**内容**，不是界面状态——放一处才不会两边漂移。
 */

/** 演示会话的 id 前缀。任何地方看到 `demo-` 就知道这条不是真会话。 */
var copy = require('./copy.js')

var PREFIX = 'demo-'

/** 演示会话列表（形状与 `ev.session_changed.sessions[]` 一致：id/title/workspace/state/running/updatedAt）。 */
function sessions() {
  var now = Date.now()
  return [
    {
      id: PREFIX + '1',
      title: '【演示】接入登录接口并补测试',
      workspace: '/home/x/projects/api-server',
      state: 'awaiting-permission',
      running: false,
      updatedAt: new Date(now - 40 * 1000).toISOString(),
    },
    {
      id: PREFIX + '2',
      title: '【演示】把构建脚本从 shell 迁到 Node',
      workspace: '/home/x/projects/toolkit',
      state: 'idle',
      running: true,
      updatedAt: new Date(now - 9 * 60 * 1000).toISOString(),
    },
    {
      id: PREFIX + '3',
      title: '【演示】排查上传偶发失败',
      workspace: '/home/x/projects/toolkit',
      state: 'archived',
      running: false,
      updatedAt: new Date(now - 30 * 60 * 60 * 1000).toISOString(),
    },
  ]
}

/** 演示会话的 id（chat 页用哪一条）。 */
var SESSION_ID = PREFIX + '1'

/**
 * 聊天页的演示事件序列。
 *
 * 形状**逐字**照 `_onEvent` 的真实入参来：`{ kind:'payload', payload:{ t, … } }`。
 * 由 chat 页原样喂进它自己的 `_onEvent` —— 演示走的是**与真机同一条渲染管线**，
 * 不另写一套"演示专用渲染"，也就不会出现"演示好看、真机难看"那种漂移。
 *
 * ⚠️ **必须是包了 `kind` 的那一层**。第一版这里直接返回裸 payload
 * （`{t:'ev.message_delta', …}`），而 `_onEvent` 的第一句是
 * `if (evt.kind !== 'payload') return` ⇒ 整个演示页一片空白。
 * 形状对不上不会报错、只会静默丢弃 —— 所以 `e2e/mp-review-safety.test.mjs`
 * 有一条专门核对这一层包装。
 */
function events() {
  var s = SESSION_ID
  /** 造一条 payload 事件（`_onEvent` 的入参）。 */
  var at = function (t, fields) {
    return { kind: 'payload', payload: Object.assign({ t: t, sessionId: s }, fields) }
  }
  return [
    // 用户那句话（宿主就是用 role:'user' 的 delta 回传用户消息的）
    at('ev.message_delta', { messageId: 'dm1', role: 'user', delta: '把登录接口接进来，顺手补上测试', done: true }),
    // 一轮运行开始
    at('ev.run_state', { state: 'running' }),
    // 两次工具调用
    at('ev.tool_event', { callId: 'dc1', title: '读取 src/routes/auth.ts', phase: 'completed' }),
    at('ev.tool_event', { callId: 'dc2', title: '运行 pnpm test', phase: 'completed' }),
    // 助手的回复正文
    at('ev.message_delta', {
      messageId: 'dm2',
      role: 'assistant',
      delta:
        '登录接口已经接好，测试也补上了。\n\n- 路由挂在 `POST /auth/login`\n- 用 `zod` 校验入参，错误统一走 400\n- 新增 3 条用例（成功 / 密码错 / 入参缺字段）\n',
      done: true,
    }),
    // 待办快照（这一区在真机上就是"排队等着做的事"）
    at('ev.todo', {
      // ⚠️ 字段名必须是 `content`（协议 `todoItem` 就是 content + status）。
      //   这里原来写的是 `text` ⇒ 审核模式下列表**每一行都是空的**
      //   （页面读 `item.content`，拿到 undefined）。2026-08-09 用户报的就是这一条。
      //   `id` 也一并去掉：协议里没有它，页面按 index 做 wx:key。
      todos: [
        { content: '接入登录接口', status: 'completed' },
        { content: '补 3 条测试用例', status: 'completed' },
        { content: '更新接口文档', status: 'pending' },
      ],
    }),
    // 停在"等你决定"那一刻：这正是这个工具最想让人看到的一屏
    at('ev.permission_request', {
      requestId: 'demo-req-1',
      action: 'write file docs/auth.md',
      reason: '要把新增的接口写进接口文档',
      // ⚠️ 直接用共享表（`core/copy.js`，生成自 packages/plugin/copy/zh-cn.json）：
      // 演示模式里演的就是**真卡片**，按钮文案必须与宿主逐字相同。
      // 这里曾经自己抄了一份 —— 那正是 F2 要消灭的"两端各写一份"。
      options: copy.APPROVAL_OPTIONS,
      expiresAt: new Date(Date.now() + 180 * 1000).toISOString(),
    }),
  ]
}

/** 演示模式顶栏那句说明（两个页面共用，避免各写一份而漂移）。 */
var BANNER = '演示模式 · 示例数据，不会连接你的主机'

module.exports = {
  PREFIX: PREFIX,
  SESSION_ID: SESSION_ID,
  BANNER: BANNER,
  sessions: sessions,
  events: events,
  /** 这个 id 是不是演示会话（页面据此决定跳转时带不带 demo 标记）。 */
  isDemoId: function (id) {
    return String(id || '').indexOf(PREFIX) === 0
  },
}
