# Changelog

版本号即 git tag，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- **修复「检测未完成」只报 `TypeError: fetch failed`**：思考强度探测的每一步现在把网络层失败与上游应答分开对待 —— 传输失败（请求根本没到）按 400ms / 1200ms 退避重试两次，HTTP 应答（哪怕是 401/429）仍然只问一次，因为它已经是上游对这个请求的结论；探测自身的 30 秒超时也不重试，否则一次卡死会变成三倍停顿。这样本地代理/VPN 链路上瞬时丢包不会再被记成「模型探测不出来」。
- 失败原因不再被 `fetch` 的固定一句话吃掉：新增共用的 cause 链渲染（`src/fetch-failure.ts`），失败行从 `baseline status 0: transport error: TypeError: fetch failed` 变成 `baseline status 0 (3 attempts): transport error: TypeError: fetch failed; cause: Error: connect ECONNREFUSED 127.0.0.1:7891`，并带上 happy-eyeballs 的 `AggregateError` 逐地址原因、超时的 `TimeoutError`。聊天、探测、令牌刷新三处的传输失败共用同一条渲染。
- 并入上游 #54：chat 与 probe 请求补上 `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` 三个 IDE 归属头，版本取与 User-Agent 同一个解析出来的桌面 App 版本；refresh、catalog、billing 三条路径保持不带该头族。

## [0.13.8] — 2026-10-02

- **插件管理页现在有本地化标题与描述**：DSH 读取的插件文案来自包内的 `locale/<语言>.json`（`meta.title` / `meta.description`），没有该文件时才回退到 `package.json` 的 `name` / `description`。补上 `locale/en.json`、`locale/zh.json`，并在 `exports` 里导出 `./locale/*.json`、在 `files` 里带上 `locale`，插件列表与详情页才会显示中文/英文的标题与一句话说明。

## [0.13.7] — 2026-10-01

- **修好浏览器半边整块不加载**：0.13.6 改名后，`tsdown.config.ts` 里客户端 bundle 的注册 id 仍写着旧名 `dsh-workbuddy-connect`。宿主以「解析出的 manifest 包名」作为浏览器模块身份，于是那一行永远等不到自己的 factory，加载器按协议重试同一份脚本，第二次执行就以 `duplicate factory registration` 抛错 —— 结果是 `1 entry did not activate`，侧栏卡片、仪表盘、设置页全部消失（宿主侧模型分组不受影响）。
- 注册 id 改为从 `package.json` 的 `name` 派生，与版本戳同一次读取，避免以后再改名时脱钩；`tests/version.spec.ts` 增加断言锁死「产物必须按包名注册」。
- 客户端插件名同步为 `dsh-workbuddy-connect-functy-client`。

## [0.13.6] — 2026-10-01

- **对外改名**：仓库与 npm 包改为 `dsh-workbuddy-connect-functy`，以区别上游 `corrinehu/dsh-workbuddy-connect`（npm 上的同名包仍归上游，当前 `0.7.1`）。provider id（`workbuddy` / `workbuddy-ai`）和 CLI 二进制名 `dsh-workbuddy-connect` 保持不变，已装用户的会话和脚本不用改。
- 状态 / 探测 / 账号路由改为 `/plugins/dsh-workbuddy-connect-functy/...`，与新包名一致。
- README 中英重写：标明 fork、对照上游 0.7.1 的差异、界面安装与命令行安装分开写。
- 截图换成 2026-10-01 实拍（对话、模型选择器、设置账号、设置模型），并在仓库根声明 `screenshots.json`。
- 并入上游：Windows 在 Electron 宿主内发现桌面 App（#66），以及国际端点的 effort 拒绝码按区域识别（#75）。

[0.13.8]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.8
[0.13.7]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.7
[0.13.6]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.6
