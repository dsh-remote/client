# Security Policy

## 报告漏洞

用本仓 GitHub 的私密渠道：**Security → Report a vulnerability**（`/security/advisories/new`）。
不要在公开 issue 里贴可利用细节。

## 本仓的范围

- 负责：客户端协议实现（与 protocol 包逐字节对拍的 `codec.js`）、本地存储的配对凭据、
  界面对密文 / 明文的边界处理。
- 不负责：中继与宿主的实现（见其余三个包）。

## 设计边界（承诺）

- **正文与指令绝不离开设备**：明文不进任何网络请求；没有云 ASR / TTS / 带正文推送。
- `codec.js` 是 golden vectors 的 **oracle**：一行都不许改——改了必须重跑向量生成并说明原因。
- 配对密钥（PSK）只存在于二维码与本地存储；解配即清。
