/**
 * client — DSH Remote Control 小程序客户端核心。
 *
 * 握手流程（字节级契约见 dsh-remote-protocol）：
 *   hello(role:client) -> hello-ok
 *   pair-begin-client(token) -> paired{hostId, sessionId}
 *   keys = derivePskKey(psk, 'c2h'|'h2c', sessionId)
 *   之后每个 payload 都以 { t:'enc', sessionId, seq, ciphertext } 传输。
 *
 * 中继只能看到密文 —— 它经手的控制面帧（hello / pair / peer 事件 / error）
 * 都在这里处理。
 */
'use strict'

var codec = require('./codec.js')
var copy = require('./copy.js')
var store = require('./session-store.js')
var socket = require('./socket.js')

var PROTOCOL_VERSION = 1

/**
 * 一页历史等多久算超时。主机会把整份会话日志读出来再切片（真机实测 4 轮 713 行是毫秒级），
 * 但长会话 + 慢磁盘可能到秒级，所以给得比普通命令宽。超时**resolve(null)** 而不是 reject：
 * 页面只需要分得清"拿到了 / 没拿到"，用 reject 会让每个调用点都要写 try/catch。
 */
var HISTORY_TIMEOUT_MS = 15000
/**
 * 一次普通命令等回执的上限。两条路都走它：新建会话（`cmd.new_session`，
 * 本地操作不该慢）与发指令（`cmd.send_prompt`，要等主机把消息收进 dsh 的 inbox）。
 * 所以它是"命令回执"的统一上限，不是"新建会话专用"。
 */
var COMMAND_TIMEOUT_MS = 12000
/**
 * 补差量那一项能力位的 id（规范 §17.4）。
 *
 * 字面量而不是 import：mp 是 CommonJS 且不能引协议包（它要打进小程序包，
 * 而协议层是 ESM + zod）。两端对同一个字符串，这件事由 `e2e/wire-surface.test.mjs`
 * 那条双向闸以外的方式守不住——所以下面凡是用到它的地方都写着它是**协议里的字面量**。
 */
var CAP_RESUME = 'drc.payload.resume'
/**
 * 补差量最多问几页（`resumeHistory`）。一页是 40 条（宿主 `HISTORY_LIMIT`）再叠一个正文字符预算，
 * 所以 4 页大约是"断线期间主机跑了上百条事件"的量级。
 *
 * 为什么小：重连后用户第一眼看的是**最新**那一段。逐轮问完是"正确但慢"——
 * 断线一天可能有上千条，问几十轮才回到最新，而每轮都要一个 15 秒的往返窗口。
 * 撞到上限就整体退回整页重读（`reason:'too-deep'`），一次往返拿到最新那段，
 * 代价是重复传输 —— 这个交换在"手机上等重连"这个场景里明确划算。
 *
 * ⚠️ 撞界时**不能"给一半"**：只补前 4 页的话，屏幕上最新的一段是缺的，
 * 而用户看到的是"补完了"（没有任何信号）。要么补齐，要么退整页。
 */
var DELTA_MAX_PAGES = 4

class DrcClient {
  constructor() {
    this.status = 'idle' // idle | connecting | pairing | online | needs-pair | error
    this.statusText = ''
    this.server = ''
    this.psk = ''
    this.convId = ''
    this.hostId = ''
    this.hostLabel = ''
    this.seq = 0
    this.kC2H = null
    this.kH2C = null
    this.sessions = []
    this.keepAwake = null
    this.model = null
    this.clientId = ''
    this.sock = null

    this._listeners = []
    this._pendingToken = null
    this._cmdSeq = 0
    this._resume = null
    this._decryptFails = 0
    /**
     * cmdId → done(payload)。**回执类**载荷（它只回答我们发出的那一次请求，不是广播）：
     * 取历史（`ev.session_history`）与命令结果（`ev.result`，目前只有新建会话用）都在这里。
     * 一张表按 cmdId 分派，是因为"结算点只有一个"这条纪律不好维护第二份。
     */
    this._cmdWaiters = {}
    /**
     * 对端说"太快了"的退避截止时刻（ms）。
     *
     * 中继的 `error` 帧现在会带 `retryAfterMs`（规范 §12.2 E2，2026-10-07 接线）——
     * 这一端从前只把它 toast 掉，等于收到了一个精确的数字却**照旧立刻重试**。
     * 在这个窗口内发命令只会再被拒一次，而配对限流那条路是会自我加速的
     * （被拒 → 再发 → 再被拒）。所以窗口内**在 `nextNonceFor` 之前**就地拒绝：
     * 既不消耗 nonce，也不必等一次必然失败的来回。
     *
     * 连接重建时清零（`_onHelloOk`）：配额按连接算，新 socket 是一份新配额。
     */
    this._rateLimitedUntil = 0
    /**
     * **本连接上**主机自报的能力位（`ev.host_info.caps`，规范 §13.2）。
     *
     * ## 为什么必须是"本连接"的，而不是"这台主机"的
     *
     * 它在 `_onHelloOk`（新连接开始）与 `onClose`（连接没了）两处清空 —— 与
     * `_rateLimitedUntil` 同一条理由，只是后果重得多：主机那一帧报的是
     * "**此刻**真正支持什么"（§13.2 L2）。换一个连接、或主机在这期间重启成了
     * 另一代版本，那个答案就过期了。而拿着过期的"支持"发 `since`，
     * 主机这一代根本不认 ⇒ **差量永远补不回来**，界面上只是"重连之后少了十几行"。
     *
     * `null` = 还不知道。老主机从不发 `ev.host_info`，而新主机那一帧也要等
     * `peer-joined` 之后才到。**凡"不知道"一律按不支持处理**：退回重拉一页
     * 只是慢，不会坏（§10.7 S6 是 MUST NOT 级的约束，宁可漏优化不可违约束）。
     */
    this.hostCaps = null
    /**
     * **本连接上**还挂着的最后一张审批/提问卡（frame 原文）。
     * 见 `_onEncrypted` 里那段注释：它是为了当掉"补拉晚于挂起"的空窗。
     * 生命周期与 `hostCaps` 同源（换连接 / 解配一律清空）。
     */
    this.pendingCard = null
    /**
     * **本连接上**主机自报的限额（`ev.host_info.limits`）。
     *
     * 与 `hostCaps` 同一个生命周期、同一组清空点（`_onHelloOk` / `onClose` /
     * `_forgetPairing`）：它们是同一帧的两个字段，分开存就会出现"能力位是新的、
     * 限额是旧的"那种**没法自证**的组合。
     *
     * 为什么图片这件事读**限额**而不是能力位：`drc.payload.attachments` 覆盖
     * images / files 两样，而同一台主机上"文件能收、图片不能收"是可能的
     * （取证见 `packages/plugin/src/core/capabilities.ts` 的 `imageAttachmentsSupported`）。
     * 用那一位开关会把能用的文件附件一起关掉，所以图片看 `maxImageAttachments`。
     *
     * `null` = 还没收到那一帧 ⇒ 不知道。**不知道不等于 0**（见 `imageAttachmentLimit`）。
     */
    this.hostLimits = null
    /**
     * 每一条会话的续传游标：`sessionId → 已经读到过的最大 latestSeq`。
     *
     * 由 `_rememberCursor` 从**每一次**历史回执里取（取最大值，所以往前翻旧页
     * 不会把它往回拨）。`resumeHistory` 拿它当 `since` 的起点。
     *
     * **刻意只在内存里**（不落 storage）：它表达的是"这次打开小程序以来读到哪儿"，
     * 而落盘的收益很小、代价是一个必须与主机历史窗口对齐的持久化状态 ——
     * 那种状态一旦与主机对不对上，表现就是静默漏消息。进程重启后没有它 ⇒
     * 退回重拉一页，仍然是对的。
     *
     * ⚠️ **解配时必须清掉**（`_forgetPairing`）：换了主机之后，
     * 旧主机的 `latestSeq` 是一个纯数字，而它在**新**主机上会被当成一个真实的
     * 游标 —— 那正是"发一个别人家的序号去问差量"，症状是静默拿到一页莫名其妙的内容。
     */
    this.historyCursor = {}
  }

  // ── 事件 ──────────────────────────────────────────────────────────
  on(fn) {
    this._listeners.push(fn)
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn)
    }
  }

  emit(evt) {
    for (var i = 0; i < this._listeners.length; i++) {
      try {
        this._listeners[i](evt)
      } catch (e) {
        /* 一个页面挂了不能拖垮传输层 */
      }
    }
  }

  _setStatus(status, text) {
    this.status = status
    this.statusText = text || ''
    this.emit({ kind: 'status', status: status, text: this.statusText })
  }

  // ── 启动 / 恢复 ───────────────────────────────────────────────────
  /**
   * 载入上次持久化的内容（server + psk + convId）。
   *
   * **这里绝不许抛**：调用点是 `app.js` 的 `App.onLaunch` → `getClient()`，
   * 抛出去就是"小程序启动即失败、无提示、无法自愈"（真机表现是白屏/卡在启动页）。
   * 而存储里的值可能是旧版本写的、也可能被人手动改过 —— psk 里混进一个非 base64
   * 字符，`derivePskKey` 就会抛 InvalidCharacterError。所以派生包 try/catch，
   * 失败就当成"没有可用的配对"：清存储 + 明说重新扫码。
   */
  hydrate() {
    this.clientId = store.installId()
    var p = store.loadPairing()
    if (p) {
      this.server = p.server
      this.psk = p.psk
      this.convId = p.convId
      this.hostId = p.hostId || ''
      this.hostLabel = p.hostLabel || ''
      this._resume = p
      try {
        this.kC2H = codec.derivePskKey(this.psk, 'c2h', this.convId)
        this.kH2C = codec.derivePskKey(this.psk, 'h2c', this.convId)
      } catch (e) {
        this._forgetPairing()
        this.psk = ''
        this.server = ''
        this._setStatus('needs-pair', '本机保存的配对信息已损坏，请重新扫码配对')
      }
    } else if (store.loadPairingError()) {
      // 记录存在但形状坏了（loadPairing 已经就地清掉）：也要说出来，
      // 否则用户看到的是"这台机器从没配对过"，而真相是"你那把钥匙坏了"。
      this._setStatus('needs-pair', '本机保存的配对信息已损坏，请重新扫码配对')
    }
    if (!this.server) this.server = store.serverUrl()
    return this
  }

  isPaired() {
    return !!this.convId && !!this.kC2H
  }

  /**
   * 打开 socket 并（重新）跑握手。
   *
   * 这是**配对入口**（扫码 / 粘贴 / 手输三条路最后都到这里），所以形状校验也在这：
   * 非法输入就地拒绝并给一句中文，不放进网络来回 —— 更不放到 derivePskKey 里
   * 变成一句英文异常（那时用户已经"配对上了"，却什么都做不了）。
   *
   * ## ⚠️ 校验必须在**赋值之前**（2026-10-07 审计）
   *
   * 原来的写法是先 `this.server = …` / `this.psk = …` / `this._pendingToken = …`，
   * 再逐项校验、遇错 `return`。而那些 `return` 都发生在 `if (this.sock) this.sock.close()`
   * **之前**，于是已配对的用户扫到一张坏码时被留在一个自相矛盾的状态里：
   *
   *   · `this.psk` 已被换成那张坏码里的值，**旧的可用 PSK 被覆盖掉了**；
   *   · 旧 convId 与两把旧密钥都还在 ⇒ `isPaired()` 为 true
   *     ⇒ sessions 页（`onShow` 用 `isPaired()` 决定显不显示主机卡）显示「已配对到 xxx」；
   *   · 而 `newSession` / `sendPromptReceipt` 用 `status !== 'online'` 全部拒绝
   *     ⇒ 「还没有连上主机，请先完成配对」。
   *
   * 用户被困在一张"说已配对、却什么都发不出去"的界面上，而界面让他重扫 ——
   * 他刚扫的就是这张码。**所以改成：先算局部变量、校验通过再一次性提交。**
   *
   * @param {Object} opts { server?, psk?, token? } —— token 触发一次全新配对。
   */
  connect(opts) {
    opts = opts || {}
    // ── 1. 先算，不提交 ──────────────────────────────────────────────
    var nextServer = opts.server || this.server || store.serverUrl()
    var nextPsk = opts.psk || this.psk || ''
    var nextToken = opts.token ? codec.normalizePairingToken(opts.token) : null

    // ── 2. 逐项校验（顺序按"用户最先需要知道的那条"排）──────────────
    if (!nextServer) {
      // ⚠️ 这句原来写「请先扫码**或填写**中继服务地址」——而**界面上没有"填写"这条路**
      // （v3 拍板：中继地址的配置点在 DSH 侧 = 主机插件的 serverUrl，小程序只管扫，
      // 见 V3-PLAN §7 阶段 E 的「需求已反转」）。用户读到它只会去找一个不存在的东西。
      //
      // 判据：文案里提到的每个入口都必须真实存在（e2e/mp-client-contract 那一族）。
      this._setStatus('needs-pair', '请先扫描主机状态栏那颗胶囊弹出的二维码')
      return
    }
    if (!codec.isValidPairingServer(nextServer)) {
      this._setStatus('needs-pair', '中继地址要以 ws 或 wss 开头')
      return
    }
    // ⚠️ `nextPsk && !isValidPsk(nextPsk)` 这个写法会**因为空串短路而跳过整个校验**，
    // 而 `derivePskKey('')` **不抛**：它照常算出 32 字节
    // （K = SHA-512("dsh-rc/v1" ␟ 方向 ␟ convId ␟ 空)），那把 key 中继自己就能派生 ——
    // 它知道 convId、namespace 与方向，全是公开的。所以"没有 psk"必须当成**不合法**，
    // 而不是"不用校验"。
    if (!codec.isValidPsk(nextPsk)) {
      this._setStatus(
        'needs-pair',
        nextPsk ? '配对密钥不合法，应是 16 字节，请重新扫码' : '缺少配对密钥，请扫描主机二维码',
      )
      return
    }
    if (nextToken && !codec.isValidPairingToken(nextToken)) {
      this._setStatus('needs-pair', '配对码必须是主机显示的 6 位数字')
      return
    }
    if (!this.clientId) this.clientId = store.installId()

    // ── 3. 校验全过，一次性提交 ──────────────────────────────────────
    this.server = nextServer
    this.psk = nextPsk
    this._pendingToken = nextToken
    if (opts.server) store.setServerUrl(nextServer)

    this._setStatus('connecting', '正在连接 ' + this.server)

    if (this.sock) this.sock.close()
    this.sock = socket.createSocket({
      url: this.server,
      onOpen: () => {
        this.sendControl({
          t: 'hello',
          role: 'client',
          protocol: PROTOCOL_VERSION,
          clientId: this.clientId,
          clientMeta: { platform: 'wechat-mp', label: '微信小程序' },
        })
      },
      onMessage: (data) => this._onFrame(data),
      onClose: () => {
        // 连接没了 ⇒ 主机那一份"此刻支持什么"也跟着失效。
        // 不清的话，断线**期间**（页面还在、status 已是 connecting）任何一次读历史
        // 都会拿上一代的答案去决定发不发 `since` —— 而 `isPaired()` 与 `this.sock`
        // 在这段时间里仍然是"配对着"的，那条路走得通，所以这个坑很安静。
        this.hostCaps = null
        this.pendingCard = null
        this.hostLimits = null
        if (this.status !== 'needs-pair') this._setStatus('connecting', '正在重连')
      },
      onError: (e) => {
        this.emit({ kind: 'error', message: (e && (e.errMsg || e.message)) || 'socket error' })
      },
    })
    this.sock.open()
  }

  disconnect() {
    if (this.sock) this.sock.close()
    this.sock = null
    this._setStatus('idle', copy.statusText('offline'))
  }

  /**
   * 彻底忘记配对（主机每次新配对都会换 PSK）。
   *
   * **必须先向主机告别，再断线。** 只做本地清理的话，主机完全不知情：
   * 它那边的 `status.json` 仍然显示「配对中」，中继的成员表里也还留着这部手机，
   * 用户在电脑上看到的与手机上看到的对不上，而且那部手机再也不会回来 ——
   * 这个状态没有任何东西会把它清掉。
   *
   * 走的是中继**已经实现**的 `session-leave`（客户端分支）：中继会把它转成
   * `peer-left` 发给主机，主机据此知道这个观众走了。不新增协议帧 ——
   * 帧名是冻结的（F1），而中继那条路本来就在。
   *
   * 顺序不能反：帧要靠 socket 发出去，`disconnect()` 之后就发不出了。
   *
   * ⚠️ **退避重连期也要断得掉**：`sendThenClose` 在 `_task` 已经没了（socket 断了、
   * 重连还排在定时器上）时直接 `return false`，而且**什么都不清**（不设 `_manualClose`、
   * 不清 `_reconnectTimer`）。那些返回值以前被丢掉，紧接的 `this.sock = null` 就把它
   * 变成**孤儿 socket**：定时器到点自己重连，之后 hello-ok 还会把"已解除配对"
   * 改写成"请输入主机上的 6 位配对码"（探针实测）。所以 false 就补一次 `close()` ——
   * 那是唯一会停表（`_manualClose`）的入口。
   */
  unpair() {
    if (this.sock && this.convId) {
      if (!this.sock.sendThenClose({ t: 'session-leave', sessionId: this.convId, clientId: this.clientId })) {
        this.sock.close()
      }
    } else {
      this.disconnect()
    }
    this.sock = null
    // 正在配对中的那半程也要一起作废：留着它，下一次 hello-ok 会用旧 token 再发一次
    // `pair-begin-client`，用户看到的是"解除配对之后又自己配上了"。
    this._pendingToken = null
    this._forgetPairing()
    this.psk = ''
    this._setStatus('needs-pair', '已解除配对')
  }

  _forgetPairing() {
    store.clearPairing()
    this.convId = ''
    this.kC2H = null
    this.kH2C = null
    this._resume = null
    this.sessions = []
    this.keepAwake = null
    // 断线后必须清掉：留着会显示上一个主机的模型，而那看着像"现在在用这个模型"。
    this.model = null
    this._decryptFails = 0
    // 能力面与续传游标都是**那一台主机**的属性，换主机之后必须一起丢：
    //   ① `hostCaps`：新主机可能是另一代版本，"上一代支持 resume"不作数；
    //   ② `historyCursor`：旧主机的 `latestSeq` 是个纯数字，而它在**新**主机上
    //      会被当成一个真实的游标 —— 那等于"拿别人家的序号去问差量"，
    //      而结果不会报错，只是静默给你一页莫名其妙的内容（最难查的那种）。
    this.hostCaps = null
    this.pendingCard = null
    this.hostLimits = null
    this.historyCursor = {}
    // 还挂着的回执类请求不会有回音了：就地结算掉，否则页面的「历史读取中」会一直转
    this._settleWaiters(null)
  }

  /**
   * 把所有挂起的**回执类**请求按同一个结果结算（断线/解配时用）。
   *
   * **不能"先换表再回调"**：`done()` 里的幂等守卫查的是 `self._cmdWaiters[cmdId]`，
   * 表一旦先被换成空的，每个回调都会在守卫处早退 —— 连超时那条路也一起被吃掉，
   * 于是断线时页面上的「正在读取主机上的历史…」会永远转下去（不发错、不重试，最难查）。
   * 结算点只有 `done()` 一个，让它自己删自己那一行。
   */
  _settleWaiters(payload) {
    var ids = Object.keys(this._cmdWaiters)
    for (var i = 0; i < ids.length; i++) this._cmdWaiters[ids[i]](payload)
  }

  /** 配对不可用了：丢掉并要求重新扫码。 */
  _resetPairing(why) {
    this.disconnect()
    this._forgetPairing()
    this._setStatus('needs-pair', why)
    this.emit({ kind: 'error', message: why })
  }

  // ── 发送 ──────────────────────────────────────────────────────────
  sendControl(frame) {
    return this.sock ? this.sock.send(frame) : false
  }

  /**
   * 加密并发送一个 payload 给主机。`cmdId` 由调用点自己分配（回执要按它结算）。
   *
   * ## `opts.silent`：**自动命令失败不许喊给用户听**（2026-08-09 用户报的 bug）
   *
   * 用户原话：「重连过程中并没有发送任何信息，会 toast 提示：还没连上主机，
   * 这条没发出去，这个不对」。
   *
   * 根因：重连一进来客户端就**自己**发一条 `cmd.list_sessions` 去恢复列表
   * （见 `_onHelloOk` 的恢复分支）。那一刻 socket 对象还在、底层 SocketTask 还没建，
   * `sendControl` 返回 false ⇒ 这里 emit 一条 error ⇒ chat 页把**任何** error 都弹成
   * toast ⇒ 用户什么都没发，却被告知"这条没发出去"。
   *
   * ⇒ 判据是"这条命令是不是用户按出来的"：
   *   · 用户按出来的（中断 / 回答 / 批准 / 新建会话）→ 失败必须说；
   *   · 后台自己跑的（拉列表 / 拉挂起 / 防休眠）→ **静默**，状态栏那句"正在重连"已经是全部信息。
   *   把两者混在一起，就会出现"用户没做任何事，界面却在报错"这种最费解的一类提示。
   *
   * ⚠️ 静默 ≠ 吞掉：调用方仍拿到 `false`，`status.json` 与日志里照样有轨迹。
   */
  sendCmd(cmd, opts) {
    var self = this
    var silent = !!(opts && opts.silent)
    /** 统一出口：静默时只返回 false，不 emit。 */
    var fail = function (message) {
      if (!silent) self.emit({ kind: 'error', message: message })
      return false
    }
    if (!this.isPaired() || !this.sock) {
      return fail('尚未配对，无法发送指令')
    }
    // **绝不回退 nonce 计数器**（codec.js:119-121 的不变式：key 绑定 psk+会话+方向，
    // 计数器按 installId 单调递增，nonce 因此绝不复用）。曾经这里兜底一个
    // `{nonceCounter: 0}`：`_resume` 一旦缺失，每条命令都从 0 起算 —— 连发两条
    // 相同明文会得到**完全相同的 24B nonce 与相同密文**（探针实测），
    // 密钥流复用是这一层最贵的一类错误。缺 `_resume` 就拒绝发送，宁可失败。
    if (!this._resume) {
      fail('配对记录不完整，请重新扫码配对')
      return false
    }
    /**
     * 退避窗口内**先拒绝**（2026-10-07 补，§5-13）。
     *
     * 必须排在 `nextNonceFor` **之前**：退避中的命令本来就发不出去，
     * 消耗一次 nonce 只是白白把计数器往前推——它安全（不会复用），但毫无意义。
     */
    var waitMs = this._rateLimitedUntil - Date.now()
    if (waitMs > 0) {
      this.emit({
        kind: 'error',
        message: '对端限流中，请 ' + Math.max(1, Math.ceil(waitMs / 1000)) + ' 秒后再发',
      })
      return false
    }
    var nonce = store.nextNonceFor(this._resume)
    // null = 这一次的 nonce 没能安全落盘（存储写失败）。**不许发**：发了就有可能在重启后
    // 复用同一个 nonce，而那是密钥流复用。宁可这次指令失败，也不要一条看不见的密码学退化。
    if (!nonce) {
      return fail('本地存储写不进去，请重新扫码配对')
    }
    var rec = codec.seal(this.kC2H, cmd, nonce)
    var sent = this.sendControl({
      t: 'enc',
      sessionId: this.convId,
      seq: ++this.seq,
      clientId: this.clientId,
      ciphertext: rec.ciphertext,
    })
    /**
     * **发不出去必须说出来**（2026-10-07 补，§5-4）。
     *
     * 这条路是真实发生过、且只有真机才看得见的：socket **对象还在**，但底层的
     * SocketTask 已经不在了（重连退避窗口，`socket.js` 的 `_task === null`），
     * `send()` 返回 false 而**不抛错**。`sendCmd` 原来只在
     * "没配对 / 没 socket / nonce 落不了盘"三档报错，这一档一条都不报 ——
     * 于是调用方拿到一个没人看的 false，用户看到的是"点了没反应"，
     * 而中转那句话（`interrupt`/`answer`/`resolve_permission` 全部不看返回值）
     * 让它变成一次彻底静默的丢帧。
     *
     * nonce 已经消耗掉了，这一条是**丢帧不是复用**：计数器往前走永远是安全的方向。
     */
    if (!sent) {
      fail('还没连上主机，这条没有发出去')
    }
    return sent
  }

  newCmdId() {
    this._cmdSeq++
    return 'c' + Date.now().toString(36) + '_' + this._cmdSeq
  }

  // ── 接收：控制面 ──────────────────────────────────────────────────
  /**
   * 解一帧 → 派发。
   *
   * **派发整段有 `try/catch`**（2026-10-07 补，§5-11）。原来只 `JSON.parse` 被包住，
   * switch 内部一个 `TypeError`（`enc-batch` 收到 `null` 元素、`_onPaired` 拿到
   * 派生不出密钥的 psk……）就会**逃出 `_onFrame`**，落到 wx 的 socket 回调里 ——
   * 后果不是"这一帧失败"，是**这条连接上后面所有帧都没人处理了**，而界面上什么都没有。
   * `enc-batch` 那两条逐项守卫就是为这一类加的，但那只治好了那一个 case。
   *
   * 与 `JSON.parse` 失败**静默丢弃**（上面那个 catch）是两种不同的处理，这是刻意的：
   * 坏 JSON 是"对端发了垃圾"，本轮见过的 case 是"对端发了一条我们的代码没接住的合法帧"——
   * 后者要留痕，否则下一次还是查不到。
   */
  _onFrame(raw) {
    var f
    try {
      f = JSON.parse(raw)
    } catch (e) {
      return
    }
    if (!f || !f.t) return

    try {
      this._dispatchFrame(f)
    } catch (e) {
      this.emit({ kind: 'error', message: '有一条数据没能处理，已跳过' })
    }
  }

  _dispatchFrame(f) {
    switch (f.t) {
      case 'hello-ok':
        this._onHelloOk(f)
        return
      case 'paired':
        this._onPaired(f)
        return
      case 'pair-fail':
        this._pendingToken = null
        // **旧的配对不能留着**：扫码时 `connect({psk})` 已经把 `this.psk` 换成新扫到
        // 的那把，旧 convId 对应的密钥再也派生不出来；而 `isPaired()` 只看 convId 与
        // kC2H（还是旧的那两把），于是界面显示"已配对"、实际什么都发不出去。
        // 清干净 → 页面据此回到扫码页（sessions 页的 needs-pair 分支）。
        this._forgetPairing()
        this.psk = ''
        this._setStatus('needs-pair', '配对失败' + translatePairFail(f.reason))
        return
      case 'peer-left':
        // 中继按**会话**维护成员表：别的会话的主机离开与本机这次配对无关。
        // 不校验归属就会把"另一条会话没了"当成"这台主机没了"，
        // 用户被无端踢回扫码页（多会话后台下这是真会发生的形状）。
        if (f.sessionId && f.sessionId !== this.convId) return
        // 主机掉了，会话没了 —— 只能重新配对
        this._forgetPairing()
        this._setStatus('needs-pair', copy.statusText('needsPair'))
        return
      case 'error':
        /**
         * `retryAfterMs`（规范 §12.2 E2，2026-10-07 接线，§5-13）。
         *
         * 中继从前**不发**这个字段，于是这一端没有东西可读；它现在发了，而这一端原来
         * 只是 toast 掉 —— 收到一个精确的毫秒数却照旧立刻重试，那与不发没有区别。
         * 这里把它记进 `_rateLimitedUntil`（`sendCmd` 会在窗口内先拒绝，见那边注释）。
         *
         * 只认两个"等一等就好"的码（`errors.wantsRetryAfter` 的同一张表，但小程序
         * **引不了协议包**，所以字面量只能各写一份——伞仓 `e2e/wire-surface.test.mjs`
         * 比的是 `ev.*`/`cmd.*`，管不到 `error.code`，这一点如实记在这）。
         */
        if (
          (f.code === 'rate_limited' || f.code === 'pair_table_full') &&
          typeof f.retryAfterMs === 'number' &&
          f.retryAfterMs > 0
        ) {
          this._rateLimitedUntil = Math.max(this._rateLimitedUntil, Date.now() + f.retryAfterMs)
        }
        if (f.code === 'unknown_session') {
          this._forgetPairing()
          this._setStatus('needs-pair', '会话已失效，请重新配对')
        } else {
          this.emit({ kind: 'error', message: f.message || f.code || 'unknown error' })
        }
        return
      case 'pong':
        return
      case 'enc':
        this._onEncrypted(f)
        return
      case 'enc-batch':
        // 中继会把主机发出的批量帧原样转发（server.forwardEncBatch），所以这条
        // 路径是活的：逐条解开当普通 enc 处理。
        //
        // ⚠️ 两道守卫（2026-10-07 审计），都因为"中继是唯一能自由构造畸形帧的人"：
        //
        // ① **形状**：items 未必是数组、元素未必是对象、`ciphertext` 未必是字符串。
        //    原来直接 `f.items[i].ciphertext`，一个 `null` 元素就是一句 `TypeError`
        //    逃出 `_onFrame` —— 而 `_onFrame` 只对 `JSON.parse` 做了 try/catch，
        //    switch 内部**没有保护**。后果不是这条帧失败，是后面所有帧的处理交给宿主。
        //    ⚠️ 形状不对的 item **跳过、不计失败**：它不是"密钥不匹配"，
        //    把它算成解密失败等于让一条畸形帧把一个健康配对误杀。
        // ② **一帧只算一次失败**：`_decryptFails` 的"给两次机会"是为了免得一条损坏的帧
        //    误杀一个健康配对（见 `_countDecryptFail`）。而在批量帧下"一帧"里就有 N 个
        //    item，逐条各计一次 ⇒ **一帧就能把两次机会烧光**。批量帧是活路径。
        //
        // 口径要分清两种"这帧没解出东西"：
        //   · **有形状合法却解不开的** ⇒ 这帧真的坏了，记**一次**（不论坏了几条）；
        //   · **全是形状不对的** ⇒ 这是畸形帧，不是密钥不匹配，**一次都不记**。
        //     否则两条纯畸形的帧就能把一个健康配对杀掉 —— 而畸形是中继随手能造的，
        //     真密钥不匹配却只在中继真的换了密钥时才出现。
        if (!Array.isArray(f.items)) return // 畸形帧：不许动配对状态
        var opened = 0
        var tried = 0
        for (var i = 0; i < f.items.length; i++) {
          var it = f.items[i]
          if (!it || typeof it.ciphertext !== 'string' || !it.ciphertext) continue
          tried++
          // countFail=false：这一帧的失败由下面**按整帧**记一次，不逐条记
          if (this._onEncrypted({ sessionId: f.sessionId, ciphertext: it.ciphertext }, false)) opened++
        }
        if (tried > 0 && !opened) this._countDecryptFail()
        return
      default:
        return
    }
  }

  _onHelloOk(f) {
    // 新连接 = 新配额：限流退避不该跨连接生效（与主机侧同一条理由 ——
    // 旧窗口早就过去了，留着它会让"重连之后什么都发不出去"看起来像另一个 bug）。
    this._rateLimitedUntil = 0
    // 新连接 = 上一代的能力面作废。主机在**它知道这端回来了**的那一刻会补发一条
    // `ev.host_info`（`index.ts` 的接线）：
    //   · 新配对 —— 中继的 `peer-joined`（带 token）触发；
    //   · 重连 —— 中继在 2026-10-06 之后就**不再**为重连通知主机了（那条无 token 的
    //     重放被删掉），主机改成从"某个 clientId 重新出现在这条会话的成员表上"
    //     自己认出来（`relay.ts` 的 `onClientRejoined`）。
    // 补一条这条注释的理由：它原来写的是"主机在 `peer-joined` 之后会紧跟一条"，
    // 那句话在**重连**那一半上是错的，而这一整段的存在意义恰好是重连——
    // 照它排错会去查中继有没有转发 `peer-joined`，而那条路根本不存在。
    //
    // 这一句与 `onClose` 那句是同一个不变量在两个入口上的兑现，**两处都要**：
    // 只留 `onClose` 会漏掉"connect() 里先 close 再建新 socket"这条路的时序。
    this.hostCaps = null
    this.pendingCard = null
    this.hostLimits = null
    if (f.clientId) this.clientId = f.clientId
    if (this._pendingToken) {
      this._setStatus('pairing', copy.statusText('pairing'))
      this.sendControl({ t: 'pair-begin-client', pairingToken: this._pendingToken })
    } else if (this.isPaired()) {
      // 恢复尝试 —— **会话可能服务端已经没了**（主机重启 / 会话被回收）。
      //
      // 刻意**不**在这里宣布 online：`isPaired()` 只说明本机存着 PSK 与 convId，
      // 而中继侧那条会话早就不存在了。原来的写法先摆出「已连接，正在同步会话列表」，
      // 于是 list_sessions 被中继回 `unknown_session` 之前，界面一直显示"在线"、
      // 「＋新建会话」也可点 —— 用户点下去只会等到 12 秒超时，然后什么也没发生。
      // 真机上这正是"新建会话用不了"的全部现象：会话已死，界面说它活着。
      //
      // 所以恢复期间用一个**独立的** connecting 态：它和"首次连接中"视觉上一样，
      // 但页面能靠它把主动作置灰（见 sessions.wxml 的 section-action.off）。
      // 中继回 unknown_session 时下面那一步会把它转成 needs-pair，用户重新扫码即可。
      this._setStatus('connecting', '正在重连')
      // ⚠️ silent：重连期间这条**必然**会失败几次（SocketTask 还没建），
      //   让它在界面上喊"这条没发出去"就是用户报的那个 bug。
      this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() }, { silent: true })
    } else {
      this._setStatus('needs-pair', '请输入主机上的 6 位配对码')
    }
  }

  _onPaired(f) {
    this._pendingToken = null
    var convId = f.sessionId
    var hostId = f.hostId || ''
    // ⚠️ **重放同一个 paired 帧不许把 nonce 计数器打回 0**（2026-10-07 审计）。
    //
    // 原来这里无条件 `nonceCounter: 0`。而中继是**零知识**的：它不需要任何密钥就能
    // 重放一个 `paired`（帧是明文控制面帧，它经手过就能再交一份）。一旦计数器归零，
    // 下一条命令的 24 字节 nonce = 同一前缀 ‖ 计数器 1 —— 与之前用过的那条**逐字节相同**
    // （`noncePrefix` 只绑 psk+会话+安装，三者都没变），于是密钥流复用：
    // 相同明文得到逐字节相同的密文，中继把两条一 XOR 就是明文之差。
    //
    // 所以只有**真的要换一把密钥**（新会话 + 新 PSK）才允许计数器从头开始；
    // 同一个 convId 的重复 `paired` 保留盘上已有的计数器。
    var sameConv = convId === this.convId
    var pairing = {
      server: this.server,
      psk: this.psk,
      convId: convId,
      hostId: hostId,
      hostLabel: this.hostLabel,
      nonceCounter: sameConv && this._resume ? Number(this._resume.nonceCounter || 0) : 0,
      pairedAt: sameConv && this._resume ? this._resume.pairedAt || Date.now() : Date.now(),
    }
    this.convId = convId
    this.hostId = hostId
    this.kC2H = codec.derivePskKey(this.psk, 'c2h', this.convId)
    this.kH2C = codec.derivePskKey(this.psk, 'h2c', this.convId)
    this._resume = pairing
    /**
     * **写失败要说出来**（2026-10-07 补，§5-7）。
     *
     * `savePairing()` 返回 false 时，这次配对**只活在内存里**：用户此刻一切正常，
     * 而一旦退出小程序，`hydrate()` 读不到任何记录、`loadPairingError()` 也是空的
     * （那条路径只覆盖"读到了、但形状坏了"）—— 界面上呈现成"这台机器从没配对过"，
     * 用户会以为配对又失效了。真相是"存不进去"，而存不进去的原因（配额满）
     * 用户自己就能看出并且可以清理。
     *
     * 与 `nextNonceFor` 那条**不同**，这里**不能**拒绝配对：nonce 落不了盘就拒发
     * 是密码学纪律，而整份记录落不了盘时我们手上的 PSK 是**唯一**一份 ——
     * 丢掉它等于立刻让用户重扫，不丢则重启后要重扫。两者都不如**现在就告诉他**。
     */
    if (!store.savePairing(pairing)) {
      this.emit({
        kind: 'error',
        message: '配对信息没能存进本机，请重新扫码',
      })
    }
    this._setStatus('online', '已配对到 ' + (this.hostLabel || this.hostId || '主机'))
    // 主机在 peer-joined 时会推 sessions + keep-awake，但主动再要一次，
    // 保证主机正在忙的时候列表也能填上
    this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() }, { silent: true })
  }

  // ── 接收：数据面（密文） ──────────────────────────────────────────
  /**
   * 解一帧密文。
   *
   * @param {boolean} [countFail] 默认 true = 解不开时记一次失败（`_countDecryptFail`）。
   *   批量帧那条路传 false，因为"一帧该记几次"有分歧：逐条各记一次会让**一帧**就
   *   烧光两次机会（见 `enc-batch`）。默认 true 是为了保住直接调用它的那些判据
   *   （`e2e/mp-client.test.mjs` 第 13 条就是直接调本函数喂坏密文的）。
   * @returns {boolean} 真的解开了没有。
   */
  _onEncrypted(f, countFail) {
    if (!this.kH2C) return false
    var payload = codec.open(this.kH2C, f)
    if (!payload) {
      // 密钥对不上意味着这个会话已经废了 —— 之后每一帧都会同样失败。
      // 别让用户对着空列表发呆：丢掉配对并明说怎么办。两次机会是为了免得
      // **一条**损坏的帧误杀一个健康的配对（计数与阈值都只在 `_countDecryptFail` 里）。
      //
      // ⚠️ 提示**照发**、计数才受 `countFail` 控制：批量帧那一路传 false 只是为了
      // "按整帧记一次"，不能连提示一起省掉 —— 静默是这一族缺陷里最难查的那种。
      if (countFail === false) this.emit({ kind: 'error', message: '有一条数据无法解密，若持续出现请重新扫码配对' })
      else {
        this._countDecryptFail()
        this.emit({ kind: 'error', message: '有一条数据无法解密，若持续出现请重新扫码配对' })
      }
      return false
    }
    this._decryptFails = 0
    // 回执类载荷：它是**回答我们某一次请求**的，不是一条事件。所以先结算那个 Promise，
    // 并且不再往下当普通事件发一遍 —— 否则页面会同时走两条路处理同一页历史。
    //
    // `ev.result` 也走这里：它有 `cmdId`，所以是"对答"（新建会话在等它），
    // 只有**没有** waiter 时才当普通事件发下去（那是别的命令的回执，页面按老规矩弹提示）。
    if (payload.t === 'ev.session_history' || payload.t === 'ev.result') {
      var waiter = this._cmdWaiters[payload.cmdId]
      // **不要在这里 delete**：结算点只有一个，就是各自 done() 里的那一处。
      // 两边都删过一次 => done() 里的幂等守卫（`if (!self._cmdWaiters[cmdId]) return`）
      // 永远命中，Promise 永不 resolve —— 真机与本地闭环的表现都是「加载更早」转圈不动、
      // 或首屏历史永远停在 loading（超时同样会被这个早退吃掉）。
      if (waiter) {
        waiter(payload)
        return true
      }
    }
    // 每个页面都要的簿记放在这里，页面保持「哑」
    if (payload.t === 'ev.session_changed') {
      this.sessions = payload.sessions || []
      // **主机真的回了一句** —— 这是"会话确实活着"的第一个硬证据，
      // 所以 online 只在这里宣布（恢复路径见 _onHelloOk 的注释）。
      // 判据用 status 而不是 statusText：文案会改，状态不会，
      // 而且 connecting 同时覆盖"首次连接"与"恢复中"两种情形 —— 两者都还没被主机确认过。
      if (this.status === 'connecting') {
        this._setStatus('online', copy.statusText('online'))
      }
    } else if (payload.t === 'ev.keep_awake_state') {
      this.keepAwake = payload
    } else if (payload.t === 'ev.host_info') {
      /**
       * 主机自报的能力面（规范 §13.2）。
       *
       * ## 为什么不在这里做任何判断，只"原样存下"
       *
       * 与上面 `ev.model` 同一条纪律：簿记放在 client，页面保持哑。
       * 消费点在 `supportsResume()` / `resumeHistory()`，判据是**发的命令**。
       *
       * ⚠️ 只认**本连接**收到的第一手值：这一帧走的是加密通道（主机发的），
       * 所以它的时效性与真实性由唯一知情者负责。**不许**拿中继 `hello-ok.capabilities`
       * 来替代 —— 中继是结构性零知识的，它答"主机支持什么"一旦答错（旧中继 strip、
       * 或缓存过期），后果是静默漏消息。协议层 `payloads.ts` 的 `evHostInfo` 头注
       * 把这条理由写全了。
       */
      this.hostCaps = Array.isArray(payload.caps) ? payload.caps : []
      // 限额与能力位**同一帧**，一起存、一起清（上面那几处），不许只存一半。
      this.hostLimits = payload.limits && typeof payload.limits === 'object' ? payload.limits : null
    } else if (payload.t === 'ev.model') {
      // 模型帧现在**带 sessionId**（wire 1.8.1 起必填），与其他事件走同一句会话过滤，
      // 页面按会话决定要不要显示（chat 页的 `_onEvent` 就是这么判的）。
      // 这里与防休眠同一层簿记：**原样存下整帧**，不替页面做判断。
      this.model = payload
    }
    /**
     * 挂起卡在这里被**记住**，而不是直接 emit 就算完（2026-10-09 用户报
     * 「审批窗卡着、手机没有弹窗」的根因）。
     *
     * ## 为什么必须记住
     *
     * 事件是**推**的，而**页面订阅才拿得到**：小程序退到后台、切到别的页，
     * 那一页就退订了（`onHide` 里 `this._off()`），于是帧到了 client、没到任何界面。
     * 主机那边只有两条重推路（`peer-joined` 与 `cmd.get_pending`），
     * 而补拉发生在**手机下一次进会话页**——那张卡很可能在两次补拉**之间**才挂上，
     * 于是它就一直躺在主机上，直到 180 秒超时。
     *
     * 现场（2026-10-09，装了新插件之后）：
     * `getPendingCalls=6`、`lastGetPendingPending=0`、`lastGetPendingAgoSec=71`、
     * `now=1`、`oldestSec=58` ⇒ 手机问得比卡产生的还勤，那张卡是**最后一次补拉之后**才挂的。
     *
     * ⇒ 这一层记住它，页面回来时直接取（`pendingCardOf`），**不必再等一个网络往返**，
     * 也就当掉了"补拉晚于挂起"这个空窗。提问卡是同一个病，同一处修好。
     *
     * ⚠️ 只记住**一张、且只记最新的**：主机同一时刻只会有一个交互在等，
     * 而一张旧卡被记着会让界面显示一张已经作废的卡（过期/被桌面答掉的那两种）。
     * 作废有两条路，都在这里清：`ev.permission_resolved` / `ev.question_resolved`。
     */
    if (payload.t === 'ev.permission_request' || payload.t === 'ev.question_request') {
      this.pendingCard = {
        t: payload.t,
        sessionId: payload.sessionId || null,
        requestId: payload.requestId,
        payload: payload,
      }
    } else if (payload.t === 'ev.permission_resolved' || payload.t === 'ev.question_resolved') {
      /**
       * 精确作废：只清对得上 requestId 的那张。
       *
       * ⚠️ **这里绝不许 `return`**（2026-10-09 深度 review 抓到的 P0）：
       * 原来那一行 `if (… ) return` 把下面那句 `emit` 一起跳过了 ——
       * 于是**收卡帧既没作废也没送达**，而页面侧的 `_onPermissionResolved` /
       * `_onQuestionResolved` 是有消费者的（它按自己的 requestId 正确收单）。
       * 表现是"卡一直挂在屏幕上"，而 `_startCardTick` 的设计是"到点不清卡片" ⇒ 永久。
       *
       * ⇒ 作废与送达是**两件独立的事**：这里只管前者，一律落到下面的 `emit`。
       */
      if (this.pendingCard && (!payload.requestId || payload.requestId === this.pendingCard.requestId)) {
        this.pendingCard = null
      }
    }
    this.emit({ kind: 'payload', payload: payload })
    return true
  }

  /**
   * 记一次"这条数据解不开"，到两次就丢配对。
   *
   * 单独抽出来是因为**一帧该记几次**是有分歧的（见 `enc-batch`）：
   * 普通 `enc` 帧一帧一条、记一次；批量帧一帧 N 条，按整帧记一次。
   * 阈值 2 与"免得一条损坏的帧误杀一个健康配对"这个意图一起看：
   * 连续**两帧**都解不开才是真解不开（密钥真的不对了），单帧解不开只是网络噪声。
   */
  _countDecryptFail() {
    this._decryptFails++
    if (this._decryptFails >= 2) {
      this._resetPairing('配对已失效，请重新扫码')
    }
  }

  // ── 页面用的便捷指令 ──────────────────────────────────────────────
  listSessions() {
    // 周期刷新（会话列表每 15 秒一次）：它是后台行为，失败不该弹给用户
    return this.sendCmd({ t: 'cmd.list_sessions', cmdId: this.newCmdId() }, { silent: true })
  }

  /**
   * 拉取还挂着的审批/提问（wire 1.9.0 起，fire-and-forget）。
   *
   * 审批/提问卡是"一次性"的一帧：退后台、断线、停在列表页时错过就没了。
   * 主机把 `pending` 里还挂着的按原请求帧重发（同一 `requestId`，页面按卡覆盖），
   * 没有只回 `ev.result{ok:true}`。老主机不认这条命令（静默丢弃），
   * 所以这里不做 waiter、不弹错——收不到就当没有。
   * 调用点：chat 页 onShow（进会话）与重连成功（世界可能变了）。
   */
  getPending(sessionId) {
    var cmd = { t: 'cmd.get_pending', cmdId: this.newCmdId() }
    if (sessionId) cmd.sessionId = sessionId
    // 注释里那句"不弹错"原来只是愿望：sendCmd 照样 emit。现在它真的是静默的。
    return this.sendCmd(cmd, { silent: true })
  }

  /**
   * 发一条指令。images / files 都是可选附件（wire 1.3.0 起，files 是 1.6.0 加的）。
   *
   * 两类附件在协议里就是两个字段，**只映射协议要的那几个字段**——本机路径（path）
   * 之类都不上线。图片固定 image/jpeg（画布重编码出来的就是它），文件带名字和类型标签。
   *
   * 两类的条数上限都是 4（协议层同一个数）；调用方（chat 页）已经按这个数收过一轮。
   */
  sendPrompt(sessionId, text, images, files, cmdId) {
    var cmd = {
      t: 'cmd.send_prompt',
      // 调用方可以自带 cmdId（要等回执时）；不带就自己分配。
      cmdId: cmdId || this.newCmdId(),
      sessionId: sessionId,
      text: text,
    }
    if (files && files.length) {
      cmd.files = files.slice(0, 4).map(function (a) {
        return { name: a.name, mediaType: a.mediaType, data: a.data }
      })
    }
    if (images && images.length) {
      cmd.images = images.slice(0, 4).map(function (a) {
        return { name: a.name, mediaType: 'image/jpeg', data: a.data, width: a.width, height: a.height }
      })
    }
    return this.sendCmd(cmd)
  }

  /**
   * 发一条指令，并等主机的 `ev.result` 回执。
   *
   * 为什么要有这一个（而不是原来那个发完就不管的 `sendPrompt`）：**排队要以 dsh 为准**
   * （2026-10-05 用户拍板）。指令发出去只是"到主机了"，主机收不收、收在哪儿，
   * 只有回执说得清——`agent.followup()` 会把它排进 dsh 自己的 inbox，而
   * "没有活的 agent"这一类失败以前在手机上是**静默的**：消息看着发出去了，
   * 其实哪儿都没到。
   *
   * 与 `newSession` 同一套回执机制（按 cmdId 登记 waiter，回帧或超时只结算一次，
   * 断线时由 `_settleWaiters` 就地结算）。
   *
   * @returns Promise<{ok: boolean, message?: string}>。`ok:false` 一定带可读原因。
   */
  sendPromptReceipt(sessionId, text, images, files) {
    var self = this
    if (this.status !== 'online') {
      return Promise.resolve({
        ok: false,
        message:
          this.status === 'connecting'
            ? '正在重连，请稍后再发'
            : '还没有连上主机，请先完成配对',
      })
    }
    if (!this.isPaired() || !this.sock) {
      return Promise.resolve({ ok: false, message: '还没有连上主机' })
    }
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        if (payload && payload.t === 'ev.result') {
          // 主机只回 ok/message：没有"排到第几位"这种字段（wire 还没有），
          // 所以回执只能回答"收下了 / 没收下"。
          resolve({ ok: payload.ok !== false, message: payload.message || '' })
          return
        }
        resolve({ ok: false, message: '主机没有回应' })
      }
      timer = setTimeout(done, COMMAND_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done
      if (!self.sendPrompt(sessionId, text, images, files, cmdId)) done(null)
    })
  }


  interrupt(sessionId) {
    return this.sendCmd({ t: 'cmd.interrupt', cmdId: this.newCmdId(), sessionId: sessionId })
  }

  resolvePermission(sessionId, requestId, decision) {
    return this.sendCmd({
      t: 'cmd.resolve_permission',
      cmdId: this.newCmdId(),
      sessionId: sessionId,
      requestId: requestId,
      decision: decision,
    })
  }

  answer(sessionId, requestId, answers) {
    return this.sendCmd({
      t: 'cmd.answer',
      cmdId: this.newCmdId(),
      sessionId: sessionId,
      requestId: requestId,
      answers: answers,
    })
  }

  setKeepAwake(enabled, idleReleaseSec) {
    var cmd = { t: 'cmd.keep_awake', cmdId: this.newCmdId(), enabled: !!enabled }
    if (idleReleaseSec !== undefined && idleReleaseSec !== null) cmd.idleReleaseSec = idleReleaseSec
    return this.sendCmd(cmd)
  }

  /**
   * 读一页主机上已有的历史。
   *
   * 分页游标**由主机给**：返回的 `nextBeforeSeq` 原样回传进下一次调用即可拿更早的一页；
   * 它不在就表示到最早了。页面不要自己按条数推算——一条原始内核事件可能被折叠成
   * 0/1/2 条这里看到的条目，按条数翻页迟早会跳过或重发一段。
   *
   * @returns Promise<page|null>。`null` = 没拿到（未配对 / 发送失败 / 超时 / 断线 /
   *          被拒绝）。页面据此显示"读不到"并允许重试，而不是显示成"这个会话没内容"。
   *
   * ⚠️ 想区分"为什么没拿到"的调用方（目前只有 `resumeHistory`）请用
   * `_historyRequest`：这里刻意把五种原因压成一个 `null`，因为页面那一层唯一能做的
   * 区分就是"显示读不到"，多给它一个字段只会多一条没人读的分支。
   */
  loadHistory(sessionId, opts) {
    return this._historyRequest(sessionId, opts).then(function (res) {
      return res.ok ? res.page : null
    })
  }

  /**
   * `loadHistory` 的**带原因**版本，外加一处簿记（续传游标）。
   *
   * @param {object} [opts] `{beforeSeq?, since?, limit?}`。`since` 与 `beforeSeq`
   *   **互斥**（规范 §10.7 S1）——两个都传会让主机（与协议层的校验器）拒掉整条命令，
   *   所以下面用 `else if` 把互斥写成**生产端的形状**，而不是靠调用方自觉。
   * @returns Promise<{ok:true, page}|{ok:false, reason:'offline'|'timeout'|'rejected', message?}>
   */
  _historyRequest(sessionId, opts) {
    opts = opts || {}
    var self = this
    if (!this.isPaired() || !this.sock) return Promise.resolve({ ok: false, reason: 'offline' })
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      // 结算点只有一个：删掉登记因此是幂等的，超时与回帧谁先到都只生效一次
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        if (payload && payload.t === 'ev.session_history') {
          // 游标只在**成功**的回执上推进：失败的那一页没有 `latestSeq`，
          // 而拿一个"没发生过的事"去当游标，下一步的 `since` 就是编的。
          self._rememberCursor(sessionId, payload.latestSeq)
          resolve({ ok: true, page: payload })
          return
        }
        if (payload && payload.t === 'ev.result' && payload.ok === false) {
          // 主机**明确拒绝**了这条命令。目前只有一种：窗口越界
          // （`history_window_exceeded`，runtime.ts 那条 reply）——而它的语义是
          // "补不回来了，改拉历史"（§10.7 S4/S5），不是"重试一下就好"。
          resolve({ ok: false, reason: 'rejected', message: String(payload.message || '') })
          return
        }
        // 断线/解配时 `_settleWaiters(null)` 会喂进一个 null，那也算"没拿到"
        resolve({ ok: false, reason: 'timeout' })
      }
      timer = setTimeout(function () {
        done(null)
      }, HISTORY_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done

      var cmd = { t: 'cmd.session_history', cmdId: cmdId, sessionId: sessionId }
      if (opts.beforeSeq !== undefined && opts.beforeSeq !== null) cmd.beforeSeq = opts.beforeSeq
      else if (opts.since !== undefined && opts.since !== null) cmd.since = opts.since
      if (opts.limit) cmd.limit = opts.limit
      if (!self.sendCmd(cmd)) done(null)
    })
  }

  /**
   * 记下"这条会话已经读到过第几号事件"。
   *
   * **取最大值，不取最新一次**：往前翻更早的一页时 `latestSeq` 报的是那一页的页顶
   * （比游标小），若无条件覆盖，一次「加载更早」就会把游标往回拨 ——
   * 之后重连补差量会把已经读过的整段再补一遍（重复落块）。
   */
  _rememberCursor(sessionId, latestSeq) {
    if (!sessionId || typeof latestSeq !== 'number' || !isFinite(latestSeq)) return
    var current = this.historyCursor[sessionId]
    if (typeof current === 'number' && current >= latestSeq) return
    this.historyCursor[sessionId] = latestSeq
  }

  /** 这条会话已经读到过第几号事件；没读过（或不是数字）时回 `null`。 */
  cursorOf(sessionId) {
    var cursor = this.historyCursor[sessionId]
    return typeof cursor === 'number' ? cursor : null
  }

  pendingCardOf(sessionId) {
    var card = this.pendingCard
    if (!card) return null
    // ⚠️ **中间那个 `card.sessionId &&` 曾经让它变成通配符**（2026-10-09 深度 review 的 P1-3）：
    // 一张不带 sessionId 的卡会被**任何一个**会话取走，而 chat 页的会话过滤对这一路
    // 没有等价物（跨会话那张会 toast 一句，这一条是安静的）。
    // ⇒ 过滤只能是"帧有会话、且与要的那条相同"。
    //
    // ⚠️ 别再在上面加一道 `if (!card.sessionId) return null`：它是**冗余**的
    // （下面那道已经覆盖），而两段看起来都在起作用会让人以为改哪一段都算修了
    // —— 我第一版就加过它，变异时打掉它判据纹丝不动，正好证明了这一点。
    if (sessionId && card.sessionId !== sessionId) return null
    return card.payload
  }

  /**
   * 对端**此刻**支持不支持补差量。
   *
   * 两个来源缺一不可，任何一个"不知道"都按**不支持**处理：
   * - `hostCaps` 是本连接上收到的 `ev.host_info.caps`（见构造函数那段的理由）；
   * - 老主机永远不发那一帧 ⇒ 一直是 `null` ⇒ 一直退回重拉一页。
   *   这是**对的**：§10.7 S6 要求"对端没有这一位时 MUST NOT 发 since"，
   *   而"发了会怎样"是——永远收不到差量页，同时也不再走重拉那条路（静默漏消息）。
   */
  supportsResume() {
    if (!Array.isArray(this.hostCaps)) return false
    return this.hostCaps.indexOf(CAP_RESUME) >= 0
  }

  /**
   * 这台主机**此刻**一条消息能收几张图片。
   *
   * 返回 `null` = **不知道**（还没收到 `ev.host_info`），与 `0`（收到且明确是 0）
   * 是两件事，页面必须分开处理。
   *
   * ## 为什么"不知道"不按 0 处理（与 `supportsResume` 相反）
   *
   * `supportsResume` 那边"不知道 ⇒ 按不支持"是对的：发了不该发的 `since` 是
   * **静默漏消息**（§10.7 S6 是 MUST NOT 级约束）。
   * 而图片这边，"不知道 ⇒ 按 0"会把**老主机**（不发 `ev.host_info`）上的
   * 图片功能整个关掉——那是一次**真的功能回退**，而它要避免的只是
   * "让用户白传一趟附件"。
   *
   * ⇒ 取舍：老主机照常能选图（真能用），新主机报的 0 才真的置灰
   * （那一台上图片会被明确拒绝，用户在**选之前**就知道）。
   * 代价是老主机上那个坏体验还在——它只能由**升级主机**根治，见
   * `packages/plugin/src/core/capabilities.ts` 里记的取证。
   */
  imageAttachmentLimit() {
    if (!this.hostLimits) return null
    var n = this.hostLimits.maxImageAttachments
    return typeof n === 'number' && n >= 0 ? n : null
  }

  /**
   * 这台主机一条消息能收几个**文件**（`ev.host_info.limits.maxFileAttachments`）。
   *
   * ⚠️ `0` 不是"没限制"，而是"这台主机**没配落盘目录**，一条文件都不收"
   * （`runtime.ts` 那个 `uploadDir ? MAX_FILE_ATTACHMENTS : 0`）。
   * ⇒ 问"能不能用文件这条路"必须问这一格，不能假定有。
   */
  fileAttachmentLimit() {
    if (!this.hostLimits) return null
    var n = this.hostLimits.maxFileAttachments
    return typeof n === 'number' && n >= 0 ? n : null
  }

  /**
   * 这台主机**明确**说了它不收图片吗（`0` 张）。
   *
   * 单列一个方法是因为页面问的是"要不要拦"，不是"上限是几"：
   * `null`（不知道）与 `0`（明确不能）在页面上是**两种不同的行为**。
   */
  rejectsImages() {
    return this.imageAttachmentLimit() === 0
  }

  /**
   * 页面在**手机上提交了决定**时调它：把 client 记住的那张卡作废掉。
   *
   * ## 为什么必须有这条出口（2026-10-09 深度 review 抓到的 P0，命中率最高）
   *
   * 「手机自己答掉」这条路**永远收不到** `ev.permission_resolved`：
   * 主机 `settleApproval` / `settleQuestion` 调的是 `settle()` **不带 `voidAs`**，
   * 而 `settle()` 自己写着"只有『不是手机自己点的』才需要作废"——
   * 那种情况下手机上那张卡还亮着、而它已经没用了。
   *
   * ⇒ 提交成功之后 client 侧必须自己清。否则：用户退到列表再进同一会话，
   * `onShow` 会把**那张已经结算完的卡重新画出来**（还带一次长震，
   * 并把顶栏的"运行中"按成"空闲"），再点就会被主机回
   * 「这个审批请求已经不在挂起状态」。
   *
   * @param {string} [sessionId] 只作废这一条会话的（别的会话那张不许动）
   * @param {string} [requestId] 再精确到一张；缺省时作废该会话当前记住的那张
   */
  forgetPendingCard(sessionId, requestId) {
    var card = this.pendingCard
    if (!card) return false
    if (sessionId && card.sessionId && card.sessionId !== sessionId) return false
    if (requestId && requestId !== card.requestId) return false
    this.pendingCard = null
    return true
  }

  /**
   * 这条会话此刻**还挂着**的那张卡（frame 原文），没有就 `null`。
   *
   * `sessionId` 不匹配时也回 `null` —— 一张属于别的会话的卡不能拿到这个会话的界面上，
   * 那正是会话过滤要防的事（这一层是簿记，不是渲染）。
   */
  /**
   * 断线重连后**只补差量**（V3-PLAN §7 B4 / 规范 §10.7）。
   *
   * ## 为什么需要它（而不是让页面自己带 `since`）
   *
   * 两件事必须在一起才成立，拆开任何一件都会静默漏消息：
   *   ① 对端有没有能力位（`supportsResume()`）—— 没有就 MUST NOT 发 `since`；
   *   ② 游标从哪来（`cursorOf`）—— 没有游标就没有"从哪补"。
   *
   * 页面那一层同时装这两件事，就会出现"某一条分支忘了判 ①"这种错 ——
   * 而它的症状（漏十几行）与"主机没发"完全一样。
   *
   * ## 为什么是一个**循环**（而不是问一次）
   *
   * `since` 是**排他下界**，而一页有条数与字符两个预算（宿主侧 `HISTORY_LIMIT = 40`
   * 加一个正文字符预算）。断线久了差量超过一页时，一次请求只能拿到一段。
   *
   * 能循环的前提是**宿主从早到晚取这一段**（`carrier-services.ts` 那条"取页方向"
   * 注释，2026-10-08 定案）：回来的必然紧接 `since`，`latestSeq` 是这一段的页顶，
   * 把它当新的 `since` 带回去就接着往下走。
   *
   * ⚠️ 这条前提**两端必须一致**，而它曾经不一致：真实载体原来也是"从晚到早取"，
   * 于是 `since=100`、范围 101–500、一页装 40 条时回来的是 461–500，
   * `latestSeq=500`，循环第二问问 501+ 得到空页、**正常收工** ——
   * 101–460 那一整段从没到过手机上。**只测 mock 的判据全绿**（mock 一直是从早到晚）。
   * 现在两端同向，判据在 `e2e/wire-resume-delta.test.mjs` 与
   * `carrier-services.test.ts` 的取页方向那一条上。
   *
   * ## 返回值
   *
   * `{mode:'delta', items}`  —— 差量拿到了（`items` 可能为空 = 已经补齐）。
   * `{mode:'full', items: [], reason}` —— **退回重拉一页**。`reason` 是
   *   `'no-cap'`（对端没这一位，S6）/ `'no-cursor'`（没读过历史）/
   *   `'too-deep'`（轮数用光，见下）/ `'rejected'`（窗口越界，S4/S5）/ `'timeout'`。
   *   调用方拿到 `full` 就该走它原来那条整页路径，**不要**把它当错误弹提示：
   *   这是规范规定的降级，不是失败。
   *
   * ## `too-deep`：轮数用光时**故意丢掉**已经补到的那部分
   *
   * 断线很久时差量可能有几百条。逐轮问完是"正确但慢"，而重连后用户第一眼要看的是
   * **最新**那一段 —— 整页重读一次就把它拿到了，代价是重复传输。
   * 所以上限定得很低（`DELTA_MAX_PAGES`），撞到它就整体退回整页，
   * **不做"给一半"**：给一半等于屏幕上最新的一段是缺的，而用户没有任何信号。
   *
   * 永不 reject：调用点是重连那一支，抛出去会让"重连后补历史"整段消失。
   */
  resumeHistory(sessionId) {
    var self = this
    if (!this.supportsResume()) return Promise.resolve({ mode: 'full', items: [], reason: 'no-cap' })
    var cursor = this.cursorOf(sessionId)
    if (cursor === null) return Promise.resolve({ mode: 'full', items: [], reason: 'no-cursor' })

    var items = []
    var since = cursor
    var pages = 0
    var step = function () {
      pages++
      return self._historyRequest(sessionId, { since: since }).then(function (res) {
        if (!res.ok) return { mode: 'full', items: [], reason: res.reason, message: res.message }
        var page = res.page
        var pageItems = page.items || []
        for (var i = 0; i < pageItems.length; i++) items.push(pageItems[i])
        var next = typeof page.latestSeq === 'number' ? page.latestSeq : null
        // **没有推进就是补齐了**。三种都算：
        //   · `latestSeq` 不在（这一代宿主报不出游标 ⇒ 本来就不该走这条路）；
        //   · 空页 —— 主机那边没有更新的内容了；
        //   · `latestSeq <= since` —— 有原始事件但一条都渲染不出来（纯 turn 边界这类）。
        // 少了这个守卫就是一个死循环：反复问同一个 since，每次都拿到同一页。
        if (next === null || pageItems.length === 0 || next <= since) {
          return { mode: 'delta', items: items }
        }
        since = next
        if (pages >= DELTA_MAX_PAGES) return { mode: 'full', items: [], reason: 'too-deep' }
        return step()
      })
    }
    return step()
  }

  /**
   * 让主机新建一条会话，返回主机分配的 id。
   *
   * 与 `loadHistory` 同一套回执机制：按 `cmdId` 登记 waiter，回帧（这里是 `ev.result`）
   * 或超时只结算一次，断线时由 `_settleWaiters` 就地结算 —— 三个出口都要有结果，
   * 否则页面会永远停在"正在新建…"。
   *
   * ## `workspace`：让新会话落进指定的分组（2026-10-07 接线，HANDOFF §0.10.4 第 4 步）
   *
   * 协议层有可选的 `cmd.new_session.workspace`（目录绝对路径，与
   * `SessionSummary.workspace` 同一个字符串、逐字透传），主机侧也已就绪 ——
   * 但这一侧**一直没发**：用户点「＋新建会话」，会话落进主机自己推断的目录，
   * 在电脑的会话列表里归到别的分组甚至「未分组」，而回执照样 `ok:true`，
   * **无错、无日志、手机上完全看不出**。
   *
   * **不传时行为与接线之前完全一致**（载荷里不带这个字段）—— 老主机那条路必须照走。
   *
   * @param {string} [workspace] 目标工作区的绝对路径；省略/空串 = 由主机推断
   * @returns Promise<{ok: boolean, sessionId?: string, message?: string}>。
   *          `ok:false` 一定带可读原因：主机那一代没有这个能力、创建失败、超时、断线，
   *          四种都要能说出来，"新建没反应"是最难查的那种表现。
   */
  newSession(workspace) {
    var self = this
    // `isPaired()` 只说明本机存着 PSK 与 convId。**主机侧那条会话可能早没了**
    // （主机重启 / 会话被回收），而这时 sendCmd 照样"发得出去"——中继只是回一个
    // `unknown_session`，命令本身永远不会有 `ev.result`。
    // 于是调用方只能等满 COMMAND_TIMEOUT_MS 才知道失败了：真机上表现就是
    // 「点了新建会话，界面毫无反应，12 秒后才弹一句主机没有回应」。
    //
    // 所以未确认过的连接一律**就地拒绝并说清原因**。判据用 status === 'online'：
    // 它只在收到主机第一句 `ev.session_changed` 之后才成立（见 _onEncrypted）。
    if (this.status !== 'online') {
      return Promise.resolve({
        ok: false,
        message:
          this.status === 'connecting'
            ? '正在重连，请稍后再发'
            : '还没有连上主机，请先完成配对',
      })
    }
    if (!this.isPaired() || !this.sock) {
      return Promise.resolve({ ok: false, message: '还没有连上主机' })
    }
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        if (payload && payload.t === 'ev.result') {
          var data = payload.data || {}
          var id = typeof data.sessionId === 'string' ? data.sessionId : ''
          if (payload.ok && id) resolve({ ok: true, sessionId: id })
          else resolve({ ok: false, message: payload.message || '新建会话失败' })
          return
        }
        // 超时 / 断线：两种都不该说成"失败了"就完事，得让人知道是哪种
        resolve({ ok: false, message: '主机没有回应，请稍后再发' })
      }
      timer = setTimeout(function () {
        done(null)
      }, COMMAND_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done
      // 只在**给了非空** workspace 时才带上这个键 —— 老主机与老协议下不带它的那条路
      // 必须逐字不变（载荷里多个未知键，schema 那边虽然会 strip，但那是运气不是设计）。
      var cmd = { t: 'cmd.new_session', cmdId: cmdId }
      if (workspace) cmd.workspace = String(workspace)
      if (!self.sendCmd(cmd)) done(null)
    })
  }

  /**
   * 归档 / 取消归档一条会话（2026-10-07 加）。
   *
   * 与 `newSession` 同一套回执机制与同一套前置判断：按 `cmdId` 登记 waiter，
   * `ev.result` 或超时只结算一次；`status !== 'online'` 就地拒绝并说清原因。
   *
   * ## 为什么 `ok:false` 一定有可读原因
   *
   * 这一条的命令空间特别大，而它们在手机上**必须表现不同**：
   * 「主机这一代不支持」（白点一个按钮，但不该像坏了）与
   * 「会话正在运行，不能归档」（这个能修，去电脑上让它跑完）是两件事。
   * 所以这里原样透传 `payload.message`，不做任何"统一话术"。
   *
   * ## 不传 `stopActivity`
   *
   * 协议里没有这个字段（`payloads.ts` 的注）：它会**停掉主机上正在跑的工作**，
   * 而这是用户在手机上的一次误点换来的不可逆损失。主机侧明确拒绝，用户回工作台停。
   *
   * @param {string} sessionId DSH 会话 id（不是配对通道 id，F3）
   * @param {boolean} archived 省略/`true` = 归档；`false` = 取消归档
   * @returns Promise<{ok: boolean, message?: string}>
   */
  archiveSession(sessionId, archived) {
    var self = this
    if (!sessionId) return Promise.resolve({ ok: false, message: '缺少会话 id' })
    if (this.status !== 'online') {
      return Promise.resolve({
        ok: false,
        message:
          this.status === 'connecting'
            ? '正在重连，请稍后再发'
            : '还没有连上主机，请先完成配对',
      })
    }
    if (!this.isPaired() || !this.sock) {
      return Promise.resolve({ ok: false, message: '还没有连上主机' })
    }
    var cmdId = this.newCmdId()
    return new Promise(function (resolve) {
      var timer = null
      var done = function (payload) {
        if (!self._cmdWaiters[cmdId]) return
        delete self._cmdWaiters[cmdId]
        if (timer) clearTimeout(timer)
        if (payload && payload.t === 'ev.result') {
          if (payload.ok) resolve({ ok: true })
          // 原样透传主机给的原因：这一条的命令空间大，"统一话术"会把
          // 「这一代主机不支持」与「会话正在运行」抹成同一句没用的话。
          else resolve({ ok: false, message: payload.message || '归档失败' })
          return
        }
        resolve({ ok: false, message: '主机没有回应，请稍后再发' })
      }
      timer = setTimeout(function () {
        done(null)
      }, COMMAND_TIMEOUT_MS)
      self._cmdWaiters[cmdId] = done
      // 只在**取消归档**时带 `archived: false`：缺省即归档，而载荷里多个
      // "等于 false"的键看着像在说什么，其实与不发完全等价。
      var cmd = { t: 'cmd.archive_session', cmdId: cmdId, sessionId: String(sessionId) }
      if (archived === false) cmd.archived = false
      if (!self.sendCmd(cmd)) done(null)
    })
  }
}

/**
 * `pair-fail` 四个 reason 的中文说法（F6 冻结的枚举）。
 * ⚠️ 事实源在共享表（`core/copy.js`，由 `packages/plugin/copy/zh-cn.json` 生成）——
 * 这里曾经自己写了一份，改一处就与协议那侧漂。未知 reason 原样返回**机器名**：
 * 界面要能看出"这是个没登记过的值"，而不是被兜底成一句看起来正常的话。
 */
function translatePairFail(reason) {
  return copy.pairFailText(reason) || reason || '未知原因'
}

var singleton = null
function getClient() {
  if (!singleton) singleton = new DrcClient().hydrate()
  return singleton
}

module.exports = {
  DrcClient: DrcClient,
  getClient: getClient,
  translatePairFail: translatePairFail,
}
