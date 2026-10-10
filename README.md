# @dsh-remote/client

DSH Remote Control 的**微信小程序客户端**：扫码配对桌面主机（`@dsh-remote/plugin` 那颗
状态栏 pill 出的二维码），下发指令、看流式输出、回答审批与提问、防休眠。

小程序**打开即用、无需安装**；载荷级端到端加密——中继与微信侧都看不到正文与指令，
配对密钥（PSK）只存在于二维码与两台设备的本地存储里。

## 结构

- `core/`——协议编解码（`codec.js`，协议层 golden vectors 的 **oracle**）、
  连接状态机（自动重连 / 退避 / 两帧解不开即掉配对）、主题（浅 / 深两套）
- `pages/{sessions,chat}/`——会话列表与对话两个页面
- `theme/`——由 `scripts/gen-mp-theme.mjs` 从 TDesign 源生成，**勿手改**
- `miniprogram_npm/`——TDesign 裁剪产物（"构建 npm" 产出，入库）

## 八道闸

`pnpm run check` 串的就是下面这八道（顺序即执行顺序）：

```sh
node scripts/verify-miniprogram.mjs         # 结构自检（JSON / 页面 / 组件引用 / 自研 JS / 标签配对）
node --test scripts/check-markdown.mjs      # markdown 渲染（35 项）
node --test scripts/check-mp-tokens.mjs     # 设计 token（8 项，含裸值棘轮）
node --test scripts/check-mp-components.mjs # 组件层（22 项，含 44px 点击区）
node --test scripts/check-scroll.mjs        # 滚动策略（14 项）
node scripts/gen-mp-theme.mjs --check       # 主题表新鲜度（生成物与 tokens.mjs 不许漂）
node scripts/check-mp-contrast.mjs          # 对比度（356 组）
node scripts/gen-mp-copy.mjs --check        # 共享文案表两端一致
```

> ⚠️ 这一节原来写的是「五道闸」并只列了五条 —— 而 `package.json` 的 `check` 早就串了八道。
> 2026-10-10 拆仓时按 `package.json` 重数了一遍。**过期的数字比没有数字更坏**：
> 它让"闸门全绿"看起来是验过的，其实数的是另一批。

## 红线

- 正文与指令**绝不离开设备**（明文不进任何网络请求）；`codec.js` 是保留的 oracle，
  **一行都不许改**——改了必须重跑 golden vectors 并说明原因。
- 不做云 ASR / TTS / 推送带正文（与端到端加密冲突）。
- 打开即用：任何"先装点什么"的设计都不接受。
- **有意不做"设置中继地址"的界面**（v3 拍板，见 V3-PLAN §7 阶段 E 的「需求已反转」）。
  中继地址的配置点在 **DSH 侧**（宿主插件的 `serverUrl`），它会写进配对二维码的 `s=`；
  小程序**只从二维码取**，界面上没有、也不该有手填中继地址的输入框。
  三条理由（写下来免得下一个人当待办捡起来）：
  1. **零知识的边界更干净**——中继地址是"主机让手机连哪儿"，由主机自己声明最自然；
     手机手填等于让用户在手机上维护一条主机侧的部署信息。
  2. **微信四道闸照样拦**——体验版/正式版上自定义域名要过
     「socket 合法域名」白名单 + 备案 + 证书（见 SELF-HOSTING 与公众号后台设置）。
     手填地址换不来"人人可自部署"，只换来一个**会误导用户的输入框**。
  3. **少一个优先级问题**——两处能配地址就必须定"谁覆盖谁"，那是纯人造的复杂度。

## 许可

MIT
