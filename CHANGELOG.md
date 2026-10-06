# Changelog

版本号即 git tag，遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- **输入框额度徽标移到最右侧，并且可以点开看分账号额度**：那枚「WorkBuddy: 5,266」从"和上下文占用挤在一起"改为排在 composer dock 行内最后 —— 位置由 flex `order` 决定（DSH 把上下文占用控件追加在插槽条目**之后**，且插槽出口是 `display:contents`，只靠 DOM 顺序会落在它左边），再用 `margin-left:auto` 顶到行右端。点击徽标展开的面板**照 DSH 自己的上下文占用弹框（`ContextMeter`）实现**，不是另发明一个：同一套定位与关闭原语（`useAnchoredPosition` 上方定位 + `useDismissOnOutsidePointer` + Esc）、同样 **portal 到 `document.body`**（否则会被 composer 的 overflow 裁掉）、同一套菜单材质（`--dsw-specific-menu` + backdrop-filter + `--dsw-elevation-prominent`）、同样 `min(264px, 100vw - 24px)` 宽度与 12px 内边距、同样的"标题行 + 4px 容量条 + `dl/dt/dd` 行"结构；触发按钮也照抄它的字号/内边距/圆角与 hover、展开态填充。面板内按 **WorkBuddy / WorkBuddy AI 分组，每组一行一个已添加账号**，显示各自余额（有上限则"剩余 / 上限"，没读过则「尚未读取」而不是 0）；没有账号的产品整组不出现。
- **新增两个开关**（均默认开、plugin-wide、设在设置页「侧边栏」分组内，与侧边栏卡片开关并列）：**「输入框额度徽标」** `composerCreditVisible`，与**「输入框检测按钮」** `probeControlVisible`（思考强度检测控件）。三个开关彼此独立 —— 关掉徽标不会连带关掉检测按钮，反之亦然。
  - 该分组的显示条件也一并修正：原先只在"侧栏那两项偏好有值"时才渲染，三个独立偏好下会把第三个开关一起藏起来；现在任一偏好有值即渲染。
  - 检测按钮的开关由控件自己读同一份状态文档决定是否渲染；字段缺失（旧宿主）一律按"显示"处理，与另两个开关同规矩。
- **删除设置页里「仪表盘」那一行入口**：仪表盘现在只从侧栏额度卡片进入；卡片关掉时设置页不再提供第二个入口。
- **设置页首屏不再空等**：状态文档按产品缓存进 `localStorage`（键 `dsh-workbuddy-connect-functy/status/<variant>`，用法与 `@mars-sea/dsh-commandcode-provider` 的缓存同构，读写都容忍 storage 缺失或抛错），进入页面先渲染上次的账号与余额，同时并行拉取实时数据并在到达后替换；某一路读取失败时保留屏幕上已有文档而不是清空。
- **账号区新增「刷新账号」按钮**：一次刷新两版所有已登录账号的余额与状态（每版走各自的 `refresh-credits`，清掉该池的额度缓存，下一次状态读取会为每个账号重新拉一次 billing）；只刷账号状态，模型目录仍走它自己那排「刷新列表」。

## [0.13.10] — 2026-10-06

- **刷新 npm 包的 git 出处**：仓库历史经过一次身份重写 —— 早先在本机全局 git 身份未配置时推入的提交被登记成了另一个名字，现已在全部提交与 tag 上统一为维护者账号 `functy23`。重写只改署名，**文件内容逐字节未变**（main 的 tree 哈希与 27 个 tag 指向的 tree 与重写前完全一致），提交数与代码均无改动；本版据此重新构建并发布，使 npm 包记录到的提交与实际仓库对齐。

## [0.13.9] — 2026-10-05

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

[0.13.10]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.10
[0.13.9]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.9
[0.13.8]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.8
[0.13.7]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.7
[0.13.6]: https://github.com/functy23/dsh-workbuddy-connect-functy/releases/tag/v0.13.6
