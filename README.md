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

## 五道闸

```sh
node scripts/verify-miniprogram.mjs      # 结构自检（JSON / 页面 / 分包引用）
node --test scripts/check-markdown.mjs   # markdown 渲染
node --test scripts/check-scroll.mjs     # 滚动策略
node scripts/gen-mp-theme.mjs --check    # 主题表新鲜度
node scripts/check-mp-contrast.mjs       # 对比度（组）
```

## 红线

- 正文与指令**绝不离开设备**（明文不进任何网络请求）；`codec.js` 是保留的 oracle，
  **一行都不许改**——改了必须重跑 golden vectors 并说明原因。
- 不做云 ASR / TTS / 推送带正文（与端到端加密冲突）。
- 打开即用：任何"先装点什么"的设计都不接受。

## 许可

MIT
