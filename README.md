# Hush

一个干净、轻量、阅读优先的 AI 学习和讨论桌面应用。只做对话、mark、追问和 note，不写代码，也不调用工具。

官网：<https://hiyang06.github.io/hush/> · 下载：[Releases](https://github.com/HiYang06/hush/releases/latest)

- **对话**：填你自己的 API key，接入 Claude、GPT、Gemini，以及兼容 Anthropic / OpenAI / Gemini 协议的第三方服务。key 只存在本机，请求直接发给服务商
- **Mark**：标记回答里的重点原文，加批注和分类，之后集中回顾
- **追问**：选中回答里的一句话，在旁边的面板里追问，可以选择带不带主对话的上下文，再把结论带回主对话
- **Note**：每个 project 一份笔记，外加一份全局笔记。可以从对话里收录内容，让 AI 帮你整理，也可以在对话里引用笔记
- **小窗提问**：在任何应用里按 ⌥Space（Windows 上是 Alt+Space）唤起

支持 macOS（Apple 芯片）和 Windows（x64）。不登录也能用；登录后可以在多台设备间同步，iOS 只读版在做。

## 本地运行

需要 Node.js 20 或更高版本。

```
npm install
npm run dev
```

## 测试与打包

```
npm run typecheck
npm test
npm run build:mac   # dmg，输出到 dist/
npm run build:win   # Windows 安装包，在 Mac 上也能打
```

## 目录

| 目录 | 内容 |
|---|---|
| `src/` | 桌面应用（Electron + React + TypeScript + SQLite） |
| `server/` | 可选的同步服务端（Node + Postgres + R2），`cd server && npm test` |
| `ios/` | iOS 只读版（SwiftUI） |
| `site/` | 官网，推到 `main` 后由 GitHub Pages 发布 |

桌面端默认连接官方同步服务，设置环境变量 `HUSH_SYNC_URL` 可以改连你自己部署的服务端。

## License

[MIT](LICENSE)
