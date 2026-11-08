<div align="center">

<img src="build/icon.png" width="96" alt="Hush">

# Hush

**一个安静的地方，用来和 AI 一起弄懂一件事。**

干净、轻、阅读优先的 AI 桌面应用。只做对话、mark、追问和 note，不写代码，也不调用会改动任何东西的工具。

[下载](https://github.com/HiYang06/hush/releases/latest) · [官网](https://hiyang06.github.io/hush/) · macOS（Apple 芯片）· Windows（x64）

</div>

---

## 为什么做 Hush

AI 的桌面应用越来越吵：功能越来越多，越来越像编程 agent，学东西的时候大半用不上。真正需要的，只是一段排得好读的回答，加上随手做记号、追问一句、记下来的地方。

Hush 只做这几件事，并把它们做好。三条原则：

- **干净**：界面上只出现当下需要的东西。没有推荐问题，没有头像，操作按钮只在鼠标悬停时出现。
- **轻**：功能少而精，每个功能都要回答得出「学习或讨论时为什么需要它」。
- **阅读优先**：回答要像文章一样好读，排版和流式输出的每个细节都按「长时间读着舒不舒服」来定。

## 能做什么

**读**：回答用衬线正文排版，支持公式、代码高亮、表格；字号可以调，跟随系统深色。

**Mark**：选中回答里的一句话做标记，加批注、分个类。所有 mark 汇总在一页，点一下跳回原文。

**追问**：选中一句话，在右边的面板里单独追问，可以带上主对话的上下文，也可以不带。问明白了，把结论「带回」主对话。主对话不会被岔开的问题打断。

**Note**：每个 project 一份笔记，外加一份全局笔记。可以把回答里的段落收录进来，让 AI 帮你整理，也可以在提问时用 `@` 引用笔记。

**还有**：
- 附件：PDF、Word、PowerPoint、图片，都能在应用里预览
- 联网搜索：接 Tavily 或 Exa，回答里标出来源
- 小窗提问：在任何应用里按 <kbd>⌥ Space</kbd>（Windows 上是 <kbd>Alt Space</kbd>），问完就收起
- ⌘K 搜索全部会话、消息和笔记
- 可选的账号同步，多台电脑共用一份数据
- 应用内检查更新

## 接入模型

用你自己的 API key。key 只存在本机（用系统提供的加密存储保护，macOS 上是钥匙串），请求直接发给服务商，不经过任何中间服务器。

支持四种接口，兼容这些接口的第三方服务和中转站也能接：

| 接口 | 例如 |
|---|---|
| Anthropic Messages | Claude |
| OpenAI Chat Completions | GPT、DeepSeek、Kimi、通义千问、智谱 GLM、OpenRouter |
| OpenAI Responses | GPT |
| Google Gemini | Gemini |

第一次打开时有一个三步的引导：连接服务商（常见的几家只需要贴 key）、选模型、设置联网搜索。

## 安装

从 [Releases](https://github.com/HiYang06/hush/releases/latest) 下载：

- **macOS**：`Hush-x.y.z-arm64.dmg`，打开后把 Hush 拖进「应用程序」
- **Windows**：`Hush-x.y.z-setup.exe`，双击安装

Hush 暂时没有购买 Apple 和微软的开发者签名，所以第一次打开时系统会拦一下：

- **macOS**：提示「无法验证开发者」时，打开「系统设置 → 隐私与安全性」，往下找到 Hush，点「仍要打开」。
- **Windows**：出现「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。

只有第一次需要这样。以后点左栏底部的更新图标就能升级，不用重新下载。

> 自动替换需要 Hush 在「应用程序」文件夹里。如果直接在 dmg 里运行，检查更新时会请你去下载页。

## 数据和隐私

- 对话、笔记、附件都存在本机的 SQLite 数据库里，不登录也能完整使用。
- 登录同步是可选的。同步的内容存在服务器上，**API key 永远不会同步**。
- Hush 没有统计，也没有埋点。

## 从源码运行

需要 Node.js 20 或更高版本。

```sh
npm install
npm run dev          # 开发模式，改了代码自动重载
npm run typecheck
npm test
npm run build:mac    # 打包 dmg 和 zip，输出到 dist/
npm run build:win    # 打包 Windows 安装包，在 Mac 上也能打
npm run release -- 0.2.0   # 发版：改版本号、检查、打包两个平台，确认后推送并发布 GitHub Release
```

| 目录 | 内容 |
|---|---|
| `src/main` | 主进程：数据库、模型接口转换、同步、更新 |
| `src/renderer` | 界面（React） |
| `src/shared` | 两边共用的类型和纯函数 |
| `server/` | 可选的同步服务端（Node + Postgres + Cloudflare R2），`cd server && npm test` 用内存里的 Postgres 跑测试 |
| `ios/` | iOS 只读版（SwiftUI，在做） |
| `site/` | 官网，推到 `main` 后由 GitHub Pages 发布 |

桌面端默认连接官方同步服务；设置环境变量 `HUSH_SYNC_URL` 可以改连你自己部署的服务端。

技术栈：Electron · React · TypeScript · SQLite（better-sqlite3）。

## 反馈

遇到问题或者有想法，欢迎开 [Issue](https://github.com/HiYang06/hush/issues)。

## License

[MIT](LICENSE)
