# WorkBuddy 国际版支持实施方案

日期：2026-09-11
状态：待审阅；本次只编写方案，不修改产品代码。
依据：本轮用户确认、现有源码、`workbuddy-ai-international-research-2026-09-11.md`。调研中的网络结果为当日快照，不代表本次重新验证。

## 1. 目标与已确认规则

同一个 npm 插件同时支持国内 WorkBuddy 与国际 WorkBuddy AI。国内目录获取逻辑保持不变；国际目录采用 App 形态 UA 请求 `/v3/config`。

| 项目 | 国内 | 国际 |
|---|---|---|
| provider id | workbuddy | workbuddy-ai |
| 模型组名 | WorkBuddy | WorkBuddy AI |
| 设置卡片标题 | DSH WorkBuddy Connect | DSH WorkBuddy AI Connect |
| 桌面凭据文件名 | workbuddy-desktop.info | workbuddy-desktop-ai.info |
| 目录来源 | 现有 /console/enterprises/personal/models | /v3/config，App 形态 UA |
| 展示结构 | 现有模型名、倍率、badge 标签 | cli 名单与顺序、模型元数据、modelPromotions |

两版分别依据能否解析出本版凭据决定可见性，桌面凭据和插件自留副本均计入。App 是否安装不决定可见性。

- 无凭据：对应 provider 对外目录为空，模型选择器不显示分组。
- 有凭据：显示对应目录；卸载 App 后凭据仍在也适用。
- 有凭据但已过期：不因过期直接隐藏，允许既有刷新流程尝试续期；失败明确提示重新登录。
- 空文件、无法解析或无 token 的文件不算凭据；权限错误作为读取错误显示，不伪装成已登录。
- 两张设置卡片始终保留，便于未登录用户找到登录说明；隐藏模型组不隐藏卡片。这是本方案的界面默认选择。
- 不做账号池、账号轮换、额度调度，不复制同版账号为多个 provider。

## 2. 实现结构与兼容

以最小的双版本描述对象承载 provider id、displayName、凭据默认文件名/env、own 文件名、probe 文件名、路由、卡片文案和目录策略。不建通用供应商框架。

每个版本独立构造 credential store、catalog、upstream client、shim、adapter、probe store/service。单版启动或目录失败不能阻止另一版注册。两套 shim 各自保留随机回环端口和进程内密钥。

`adapter.ts` 中所有 provider 位置必须一致参数化：pi model.provider、pi provider id、Resolved profile.provider/displayName、profiles Map key、注册声明；不可只改模型组名称。invalidate 继续以新 Map 身份重建，保留当前 DSH 兼容方法，不引入未公开 resolveProfiles。

国内 provider id、已有配置 authFile、环境变量、own/probe 文件名、status/probe 路径和 CLI 默认行为保持兼容。新增国际配置 authFileAI 与 WORKBUDDY_AI_AUTH_FILE；国际 own/probe 分别使用 `.workbuddy-ai-auth.json`、`.workbuddy-ai-probe.json`，位于现有 DSH home 语义下，不误称天然按 profile 隔离。

凭据优先级仍是显式配置 → 对应 env → 平台默认路径；桌面与 own 副本择取沿用现有规则，但先检查所属区域，拒绝跨版误配并给出诊断。不能把国际 token 发到国内端点。已有用户把国际凭据配置在国内 authFile 的情况给迁移提示，不自动搬移敏感文件。

## 3. 国际 App 版本与 UA

版本解析顺序：本机已安装国际 App 的真实版本 → 最近保存的有效版本 → 经验证的内置版本。UA 使用 `WorkBuddy AI/<version>`，不混入 CLI/CodeBuddy token。

- 插件启动及每次实际刷新国际目录前重新读取 App 版本，读到新值立即替换保存值。因此更新 App 后，下次刷新会跟随更新。
- macOS 优先读取已定位 App 的 Info.plist CFBundleShortVersionString，支持系统 Applications 和用户 Applications；解析标准 plist，不用字符串猜版本。
- Windows/Linux/WSL 的 App 版本位置先按真实安装元数据定位和测试；未找到可靠来源时用保存值或兜底值，不猜测目录或版本。凭据发现延续现有平台结构，仅分开文件名，并补平台测试。
- 版本文件只记录 version、source、observedAt，不保存令牌。对版本格式做校验，禁止任意字符串进入 HTTP header。
- 本机发现新版本但目录请求失败时，不偷偷降回旧版本来试探服务端；保留错误与历史目录。不存在 App 时才使用保存值。
- UA 仅用于国际目录请求；聊天、积分和续期的现有请求头不跟着改变。

版本号不用于推断模型能力。调查只证明当日多个版本形态可用，不保证网关将来永远忽略版本。

## 4. 国际目录解析与展示

请求国际基址 `/v3/config`，携带本版 Bearer 和已验证的 App 请求头。先检查 HTTP、响应信封与结构；空壳 productFeatures 文档不能视为成功目录。

解析步骤：

1. 读取 agents 中 cli 的 models，保留其顺序。
2. 按 id 关联顶层 models 元数据，过滤禁用或不可解析项，不加入 cli 名单外模型。
3. 按声明解析图片、推理、输入输出上限、contextWindow.defaultLength/supportedLengths。
4. 解析 modelPromotions 的目标 id、生效时段、时区、折扣和展示模式；只实现实际观察并验证的形态，未知规则不猜算。
5. 保留原始倍率与促销信息，渲染时计算当前有效显示。促销过期后撤销徽章与替换倍率，不能把缓存中的 Free now 永久固化。

Auto 的空倍率保持为空，不改成 x0.00。hy4-preview 与 hy4-preview-f 不合并，国内同名 id 的倍率或探测结果也不能借用。

国际上下文页区分默认窗口、支持窗口和最大输入/输出；不把 maxInputTokens 与默认上下文混成一个字段。本轮仅展示上游窗口信息，不新增上下文档位切换功能。需明确 adapter 对外 contextWindow 的安全取值：优先采用上游明确默认窗口，缺失才回退现有输入上限，并以完整聊天验证；不能只因为最大输入声明为 1M 就默认按 1M 预算。

模型名称本地化只为明确核对过的聚合 id 做映射，普通模型保留上游名称。倍率和促销继续跟在模型名后，不改请求 model id。不新增 App logo 复刻工作。

### 目录失败与缓存

国际优先采用 App 目录；本方案不自动改用 CLI 目录，避免悄悄切换名单、id 与价格来源。降级顺序为同版同来源的最近成功目录 → 本版内置保守目录，并在卡片标记历史/兜底状态、更新时间和失败原因。

国际成功目录缓存单独保存；按账号身份及目录来源区分，账号切换不能继续展示前账号促销或积分。持久化内容不含 token。静态兜底只保留经来源核对的模型与能力，不附带实时免费承诺。国内既有目录策略保持，仅加凭据可见性门控。

## 5. 凭据与目录生命周期

当前代码只在 shim.ready 后抓取一次目录，无法保证运行中首次登录后出现模型组，需要补最小同步流程。

拟定：启动立即检查；每 30 秒只读两版本地凭据状态；增加卡片“刷新模型列表”动作。轮询不产生模型推理请求，不每轮拉积分或远端目录。

- 无→有：启用本版兜底/缓存并拉取远端目录，成功后 invalidate 并发出 llm/adapters-updated。
- 有→无：清空对外目录、停止使用当前身份的目录和探测观测，通知 model directory 更新。
- 账号变化：清理内存身份相关状态，重新拉取目录；同账号 token 轮换只更新凭据，不每次重拉目录。
- 手动刷新：重新读凭据；国际同时重读 App 版本；每版同一时间合并为一个目录请求。
- 已过期 token：复用 store.resolve 的刷新锁，不重复并发续期；明确鉴权失败与普通网络错误。
- 旧目录请求晚于账号切换返回：用身份/请求代次校验丢弃，不能覆盖新账号目录。
- 卸载插件时取消定时器、废弃在途结果、释放两套注册和 shim；共享 heartbeat 仍表示整个插件，不由单版销毁误清。

刷新目录的控制接口须使用既有随机密钥及 Host/Origin 校验；不能把状态 GET 偷偷变成不受保护的操作入口。启动和上述凭据检查永不自动运行推理档位探测。

## 6. 国际聊天与推理档位

### 聊天

保留 developer→system 的现有处理。国际请求无首条 system 时，在不重排用户内容的前提下补最小 system；具体 payload 以真实兼容验证确定。修正 Credits exhausted 被误归 soft_rate 的问题，保留其他 429 的重试语义。

GPT 返回 object:response 的首事件不等于完整 OpenAI chat stream 已兼容。必须验证最终文本、结束信号、usage、工具调用及工具结果续轮。如果确有差异，只在国际边界实现已观测格式的转换，不先引入通用 Responses 转换层。

### 推理

沿用“显式声明优先 → 有效探测结果 → 上游默认”。不增加 minimal，不探测 off，off 只受 canDisableThinking 声明控制。

国际 probe 请求补 system，采用经候选模型验证的最小输出上限。Luna 接受 16 只是一条证据，不能外推所有模型；若其他模型拒绝该上限，归为请求不兼容/未知，不能误判 effort 不支持或自动无限加大输出重试。

流程仍为 baseline → 随机哨兵 → low/medium/high/xhigh/max；仅明确 invalid_reasoning_effort 的 400 通过哨兵，HTTP 200 本身不证明效果。最多 7 次尝试，仍按次确认计费，手动重测绕过缓存，14 天 TTL。

缓存与任务按 provider 隔离；目录指纹须纳入实际使用的来源与相关推理能力字段，国际和国内同 id 绝不共享结果。Composer 按当前 provider 选择对应 status/probe 路由；切模型或 provider 时丢弃旧响应和确认目标，防止确认后探测另一模型。

## 7. 设置卡片、配置和 CLI

同一 client bundle 注册两个 settings.plugin.item key，复用卡片布局，参数化标题、简介、provider、路由和登录文案。实施前以最小运行验证两个条目都可见；若插槽不支持，再定位限制，不直接复制整个插件。

国际标题为“DSH WorkBuddy AI Connect”；简介为“在 DSH 中直接使用 WorkBuddy AI 国际版桌面 App 包含的模型，开箱即用，无需额外配置。”

两张卡片分别显示状态/上下文/明细：账号身份、到期信息、积分、目录来源与时间、优惠、探测结果。单卡失败不遮蔽另一张。未登录态仍能查看登录说明；刷新和探测有提交中、成功、失败及可理解原因。

CLI 新增 `--provider workbuddy|workbuddy-ai`，无参数沿用国内行为；status/doctor/logout 都按目标版操作。logout 只删除该版插件 own 副本，不删除 App 凭据，不承诺一定隐藏模型组。doctor 显示目录来源、UA 版本来源和目标凭据路径，不打印 token。

## 8. 文件落点

| 文件 | 改动责任 |
|---|---|
| 新增 src/variants.ts | 两版常量描述，浏览器安全字段与 host 字段边界明确 |
| src/auth.ts | 国际候选路径/env/own 隔离、区域检查，保留国内默认 |
| 新增 src/app-version.ts | 本机版本读取、保存、兜底、UA 构造 |
| src/upstream.ts | 国际目录策略、促销/窗口解析、聊天与探测差异、错误分类 |
| src/catalog.ts；按需要新增 catalog-store.ts | 可见性、独立兜底、国际成功目录保存与来源 |
| src/adapter.ts | 全链路 provider 参数化、窗口映射 |
| src/index.ts | 双版组装、生命周期、目录刷新与更新通知 |
| src/status-paths.ts / web-status.ts / probe-route.ts | 路径参数化、来源状态、认证刷新入口 |
| src/probe-store.ts / probe-service.ts | 本版路径/来源隔离、凭据与任务边界 |
| src/client/*.tsx / locales.ts | 两卡片、当前 provider 探测、刷新与错误状态、双语 |
| src/bin.ts / host-heartbeat.ts | CLI 目标版、插件级健康状态 |
| tests/* | 扩展现有行为测试，并增加版本、目录、双版集成测试 |
| README.md / README.en.md | 双版安装登录、可见性、目录差异、探测说明 |

保留现有导出默认行为；不顺带重排国内目录或改造上游 profile 构造。

## 9. 分阶段实施与验收

### 阶段一：验证接口与冻结 fixtures

先核对脱敏 App 目录信封、促销规则与窗口字段；验证 DSH 两卡片插槽、空目录隐藏与更新事件。保存用于解析测试的最小脱敏 fixtures，不入账号信息。确认各平台版本发现证据，未验证平台明确标注。

出口：国际解析和 UI 能依赖的字段清楚；完整流兼容验证单列，不能用首事件替代。

### 阶段二：双 provider 与凭据可见性

实现描述参数、两版存储与注册、空目录门控、状态路径、CLI 隔离及生命周期。先用离线 fixtures 运行，不需要真实推理请求。

出口：只国内/只国际/两者都有/两者都无四种组合正确；删除 App 不影响有凭据组；清掉全部本版凭据后只隐藏该组；过期有凭据仍可诊断。

### 阶段三：国际目录、版本和展示

实现版本刷新、App 目录解析、促销时效、窗口展示、国际缓存和错误状态，接入两张卡片。

出口：安装版本升级/卸载/保存值缺失/版本损坏分支均通过；App 名单顺序与条目关联正确；空倍率、名单外模型、过期促销均正确处理。

### 阶段四：聊天与探测

实现已证实的国际差异，完成声明档位与探测分流、Composer provider 路由与跨版隔离。

出口：离线测试覆盖 first-system、Credits exhausted、非法哨兵、限流/超时、SSE 格式、跨版同 id、切换期间迟到响应；国内请求路径和行为回归通过。

### 阶段五：整体检查与真机验收

运行 pnpm run check（typecheck → vitest → build）。真实请求放在明确获准的实施验收阶段，本轮方案不发送；刷新令牌可能影响 App 会话，单独协调测试账号/窗口，不用生产账号盲测。

真机矩阵：

- 国内旧功能：普通聊天、图像、工具调用及续轮、声明档位、手动检测。
- 国际至少两种流形态：DeepSeek 与 GPT 系完整回复、结束/错误、图片、工具调用续轮；支持声明的能力才测试和展示。
- 国际未声明模型：完成一次确认后的完整哨兵检测，选择测得档位发送正常聊天；不预设 Max 必须出现。
- 两张卡片同时打开：身份、余额、目录、探测无串号；中英文标题正确。
- 无凭据启动→登录→出现组；两份来源都移除→组消失；App 卸载但保留凭据→组保留并使用保存版本。
- 更新 App 后手动刷新→UA 版本变更；目录失败→明确历史/兜底状态；刷新不触发推理检测。
- 恶意 Host/Origin、缺密钥、错误 provider/model 请求被拒；浏览器不能传任意 UA、URL、prompt 或探测参数。
- Windows/WSL/Linux 完成可运行范围内的验证；未做真机验收的部分在交付中列明，不写成全平台实测。

### 阶段六：文档与交付

同步双语 README，说明国内无凭据时不再显示兜底模型组这一行为变化；更新调研中的决策状态和与实现相反的相关注释。保留调查历史，不把旧快照改写成新实测。

本轮不升版本、不打 tag、不 push、不 npm publish。待用户明确要求发布时，建议按新增能力升 minor（拟 v0.5.0），先升版本再完整 check/构建及 pack 检查，依项目规矩完成发布。

## 10. 关键风险与方案默认选择

- App 目录 UA 属私有行为，可能变化：提供明确错误及同源缓存，不承诺永久兼容。
- 目录数据丰富不代表所有聊天流都兼容：完整流/工具续轮是上线门槛。
- 凭据有无与有效性分开；账号切换和请求迟到必须防串。
- 促销显示必须受有效期约束；不能用旧免费标签作实时计费保证。
- 本方案默认：两卡片常驻；本地凭据检查 30 秒；手动目录刷新；国际同源缓存兜底而不自动切 CLI 目录。这些是实现建议，区别于用户已确认的产品规则。

## 11. 实施期补充（2026-09-11，实施中发现，方案原文未含）

实施时对真实上游复测，新增两条**与方案假设不同**的事实，代码按实测实现：

1. **UA 形态：无空格，不是空格。** §3 原写「UA 使用 `WorkBuddy AI/<version>`」，依据是调研文档 §2.7.3 的「以真实形态（空格）为先」。实施复测：`WorkBuddy AI/5.5.2`（空格）→ **400 / 12403**；`WorkBuddyAI/5.5.2`（无空格）→ **200 / 21 models / cli=20**（同凭据、同一时刻）。代码取无空格形态，单测钉住，调研文档 §2.7.3 已加同款修正注。**这正是方案 §3 末要补的一条：UA 的*形态*同样不可依赖，任一形态都可能在服务端某次变更后翻转。**

2. **国际刷新路径：`/v2/plugin/auth/token/refresh`，不是 `/v2/auth/token/refresh`。** 本机用国际凭据实测：原路径续期**成功**，刷新后的新 access token 可继续读取目录；PR #19 采用的短路径返回 **404**。插件沿用与国内相同的 `chatBase + /v2/plugin/auth/token/refresh`，两版同构（与调研 §2.1「刷新路径两版相同（代码确认）」一致，本次为线路侧实证）。两种积分接口在本机都返回相同余额，故不构成兼容差异。

其余实现取舍（记录以便复审）：

- **可见性形态取方案建议的②**（始终注册、目录为空即隐藏）。§1 列出的唯一行为回归——「无凭据时国内不再显示 15 个兜底模型」——已实施并有测试覆盖。
- **系统消息注入**：国际 chat 与 probe 的首条 system 由插件按需补（方案 §6 授权），`prepareChatBody` 的 developer→system 改写保持原样、两版共用。
- **GPT `object:"response"` 无需转换层**（方案 §6「必须验证」项）：实测该流除顶层 `object` 字段外是标准 `choices[].delta.content` + `finish_reason` + `[DONE]`；核对 pi-ai `openai-completions.js` 的解析分支只读 `choices`、不读顶层 `object`，故**未引入转换层**。
- **未实现（方案 §5/§7 要求、当前分支未做）**：卡片「刷新模型列表」按钮与受保护的刷新控制接口；目录来源/时间与「历史/兜底」状态的卡片展示。`--provider` 已实现，卡片侧刷新动作没有，列为后续工作。
