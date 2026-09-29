# Mar7thClaw

以三月七为默认人设的本机 Claw。它直接驱动本机已登录的 **Claude Code CLI** 来完成任务（读写文件、运行命令、写代码、上网查资料），提供一个前台常驻的桌面面板和一个 Discord bot。人设按酒馆（SillyTavern）的方式注入：角色卡、世界书、作者注释、深度提示和后置指令。

> A local "claw" assistant for Windows with a March 7th (Honkai: Star Rail) persona. It drives your locally logged-in Claude Code CLI to do real work, with an always-on desktop panel, a Discord bot, SillyTavern-style persona injection, scheduled tasks and long-term memory.

技术基础来自作者的另一个项目 ClaudeBridge：调用原生 `claude.exe`（`shell:false`），解析 stream-json 输出，不读取也不复制登录凭据。和 ClaudeBridge 不同的是，这里跑的是完整的 agent 模式：工具开启，用 `--resume` 续接会话，并通过 stdin 控制协议完成权限审批和中断。

## 环境要求

- Windows 10/11（桌面面板、托盘、开机自启和任务栏图标按 Windows 编写；核心本身是纯 Node，其他系统也能以 `npm start` 运行）
- Node.js 22 及以上
- 已安装并登录的 Claude Code（`claude auth login`），版本需支持 `--permission-mode auto`、`--append-system-prompt-file`、`--system-prompt-snapshot` 等参数
- 可选：一个 Discord bot 令牌（需开启 Message Content Intent）

## 启动

```powershell
git clone https://github.com/Mar7thLover/Mar7thClaw.git
cd Mar7thClaw
npm install                      # Electron 缓存可以用 electron_config_cache 指到别的盘
npm run import-openclaw          # 可选：从 OpenClaw 的 openclaw.json 导入 Discord 令牌与白名单（也可以把路径作为参数传入）
npm run doctor                   # 自检
.\start.cmd                      # 打开常驻面板（核心没在运行时会自动拉起）
```

没有 OpenClaw 时，手动创建 `data/config.json`，只写需要覆盖的字段即可：

```json
{
  "discord": {
    "token": "你的 bot 令牌",
    "owners": ["你的 Discord 用户 ID"],
    "allowFrom": ["你的 Discord 用户 ID"],
    "guilds": { "服务器 ID": { "requireMention": true } }
  }
}
```

### 头像

仓库不包含角色头像（角色美术的版权归 HoYoverse）。把一张 PNG 放到 `cards/march7th.png`（或 `data/cards/<角色卡 ID>.png`）就会用作面板头像、托盘和任务栏图标；没有时显示粉蓝渐变的「七」字头像。导入酒馆 PNG 角色卡时，图片会自动成为那张卡的头像。

- **启动程序**：`npm install` 结束时会自动生成 `node_modules/electron/dist/Mar7thClaw.exe`，也就是一个把头像写成图标的 `electron.exe` 副本。任务栏、任务管理器、开始菜单里显示的都是它。换了头像后，先从托盘「完全退出」，再运行 `npm run build-launcher` 重新生成。
- **开机自启**：运行 `scripts\install-autostart.ps1` 注册，加 `-Off` 取消；也可以在托盘菜单里勾选。注册的是当前用户的登录项（HKCU Run），登录后直接显示面板。
- **只要后台、不要窗口**：`scripts\start-core.ps1` / `scripts\stop-core.ps1`，或 `npm start` 前台运行。
- **快捷键**：`Ctrl+Alt+M` 呼出或收起面板。关闭窗口只会收到托盘。托盘里有两种退出：「退出面板」时核心和 Discord 继续值班；「完全退出」会连核心一起停掉。
- 浏览器也能打开面板：`http://127.0.0.1:18790/`，只监听本机。

## 架构

```
Electron 面板 (desktop/) ──HTTP+SSE──┐
浏览器 http://127.0.0.1:18790 ────────┤
Discord (src/discord/) ───────────────┤
                                       ▼
                        核心 src/index.js（独立 Node 进程）
                        SessionManager：会话持久化、每会话串行、全局并发上限、权限审批中转
                        assembler：酒馆式提示词组装
                        runner：claude.exe -p --input-format stream-json --resume …
```

## 人设注入（酒馆式）

每轮提示词分两层组装，可以在「设置 → 预览」或用 `npm run preview -- "消息"` 查看：

| 层 | 发送方式 | 内容 |
| --- | --- | --- |
| system 层 | `--append-system-prompt-file`，追加在 Claude Code 默认系统提示之后，工具能力不受影响 | 主提示 / 卡片 `system_prompt`（支持 `{{original}}`）、Claw 规则、界面规则、常驻世界书（角色前/后、示例前/后）、用户 Persona、description、personality、scenario、示例对话 |
| 逐轮注入层 | 放在每轮的用户消息里 | 首轮开场白、关键词触发的世界书、Discord 频道记录与引用（标记为不可信）、深度提示（卡片 `depth_prompt` 与「指定深度」词条）、作者注释、实际消息、`post_history_instructions` |

- 会话历史由 Claude Code 持有，所以"深度"只能相对本轮消息来定位：深度 ≥1 的放在消息之前，深度 0 的放在消息之后，后置指令永远在最后。不管会话里堆了多少工具输出，人设提醒都贴近生成位置。
- system 层只放稳定的内容，可以吃到提示词缓存；关键词词条放在注入层，不会打断缓存。启动参数带 `--system-prompt-snapshot off`，修改角色卡后，已有会话下一轮就生效。
- 宏：`{{char}} {{user}} {{persona}} {{original}} {{time}} {{date}} {{weekday}} {{isodate}} {{isotime}} {{random:a,b}} {{roll:d6}} {{// 注释}} {{trim}} <USER> <BOT>`。
- 世界书支持：常驻条目、主/次关键词（AND_ANY / NOT_ALL / NOT_ANY / AND_ALL）、`/正则/`、整词匹配、概率、递归扫描、扫描深度、字符预算与插入顺序。
- 角色卡读写使用 `chara_card_v3` 结构，也能导入酒馆的 V1/V2 JSON 和 PNG 卡（读取 `ccv3`/`chara` 文本块）。面板导出的 JSON 可以直接导入 SillyTavern。

## 三月七角色卡

`cards/march7th.json`：description、personality、scenario、开场白（另有 2 个备选）、4 组示例对话、后置指令、深度提示，以及一本 16 条的世界书「三月七的相册」（说话方式为常驻条目；列车组成员、仙舟师父、六相冰、相机、长夜月、翁法罗斯、匹诺康尼等按关键词触发）。素材参考 OpenClaw 工作区中的设定文档与游戏内语音。用户自己编辑或导入的卡保存在 `data/cards/`，与内置卡同名时优先使用用户卡。

## 权限

- 面板和主人的会话默认用 `auto` 模式：Claude Code 的分类器直接放行安全操作，有风险的转给你审批。面板上会弹审批卡片（Discord 里是按钮，只有主人能点），选项有允许 / 本会话都允许 / 拒绝；10 分钟无人处理自动拒绝。每个会话都可以改成 `default` / `acceptEdits` / `plan` / `bypassPermissions`。
- 无人值守时用不上的工具默认禁用：`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`。
- Discord 访客（不在 owners 里的人）的会话仅限聊天：`--tools "" --safe-mode --strict-mcp-config`，不加载本机的 CLAUDE.md、技能和 MCP，也不能提升权限模式。

## 模型

核心启动时用 Claude Code 的 `initialize` 控制消息读取当前账号的模型菜单（不生成回复、不消耗额度），结果缓存在 `data/models.json`。面板的模型下拉框（旁边的 ↻ 可以重新读取）和 Discord 的 `/model` 自动补全都分成四组显示：

- **当前账号菜单**：CLI 菜单原样列出，如 `default`、`opus`、Fable、`sonnet`、`haiku`。
- **别名**：`opus[1m]`、`sonnet[1m]`、`fable`、`fable[1m]`、`best`，始终指向该系列的最新版本。
- **完整模型 ID**：如 `claude-opus-5-5`、`claude-sonnet-5[1m]`，用于固定版本。
- **旧版模型**：CLI 菜单不会列出，但官方仍在服务，共 8 个：Fable 5、Opus 5、Opus 4.8/4.7/4.6/4.5、Sonnet 4.6/4.5。

`npm run models:check` 会对旧版模型逐个做一次真实生成（加 `--all` 则校验所有完整 ID），会消耗少量额度。结果写入 `data/model-checks.json`，列表里用标记显示：✓ 表示实测可用，≠ 表示请求被换成了别的模型，✗ 表示最近一次失败。强度下拉框只显示所选模型支持的档位；换模型时，如果原来的强度新模型不支持，会自动回到默认。

2026-09-27 实测：当前版 6 个完整 ID 与 7 个旧版模型可用；`claude-fable-5` 的请求会被服务端换成 `claude-opus-5`。

## 定时任务

Claude Code 自带的 Cron 工具只在常驻的交互会话里生效，而 Claw 每轮回复完就结束 CLI 进程，所以调度放在核心里做，任务保存在 `data/schedules.json`。

- **时间规则**：cron（5 段，按本机时区）、一次性（`at`）、固定间隔（至少 5 分钟），三选一。
- **到点执行**：核心往目标会话发一条【定时任务「标题」】消息，由三月七执行并汇报。
  - 目标会话是 Discord 会话时，结果发回那个频道或私信，群聊里会 @ 最后跟她说话的人。
  - 其他情况下，面板会弹出提示和系统通知。
  - 任务没有指定会话时，首次运行会自动建一个「⏰ 标题」专用会话。
- **错过的任务**：Claw 没在运行期间错过的任务，重新启动后如果还在 12 小时以内会补跑一次，更早的就跳过，并在记录里注明。
- **她自己建任务**：主人会话会挂载一个本地 MCP 服务 `claw`（`src/mcp/claw-server.js`），提供 `schedule_create / list / update / delete` 四个定时任务工具（另有发文件用的 `send_file`，见「附件」），并预先放行。你说"每天九点提醒我…"，她会自己登记。
  - 她创建的任务只能绑定到当前会话，结果也只会送回那里，不能指定别的频道。
  - 访客会话不挂这个工具，也不能挂定时任务。
- **面板管理**：侧栏「定时任务」可以新建、编辑、暂停、立即运行、删除。

## 长期记忆

主人会话使用 Claude Code 自带的自动记忆。记忆按工作目录存放，默认在 `~/.claude/projects/<工作目录转换后的名字>/memory/`。system 层里的 `<claw_capabilities>` 告诉她哪些值得记（长期偏好、约定、项目背景、称呼），哪些不记（闲聊、密码令牌），并要求用客观的第三人称书写。访客会话关闭了自动记忆，读不到也写不进。换工作目录新建会话时，用的是另一份记忆。

## Discord

行为对齐 OpenClaw 的 Discord 插件：

- 私信 / 群组白名单（`dmPolicy`、`groupPolicy`、`allowFrom`、按服务器与频道配置、`users`/`roles` 限制）。
- `requireMention`：@机器人、回复机器人的消息、或命中提及正则才会回复。OpenClaw 配置里的 `(?i)` 在 JS 正则里编译失败，OpenClaw 会直接忽略这条规则；这里会把 `(?i)` 去掉，统一按不区分大小写匹配。
- `ignoreOtherMentions`、频道历史（自上次回复以来别人说的话，最多 `historyLimit` 条；重启后首次回复前会从 Discord 补拉）。
- 输入中提示、流式预览（发出后反复编辑）、2000 字符 / 17 行分块（代码块在块之间自动闭合并重开）。
- 附件：图片、文本、PDF 所有人都能让她读；主人发来的附件另存到会话工作目录的 `.claw-attachments/`。她也能把文件作为附件发回来，详见「附件」。
- 会话划分：频道 × 身份（主人 / 访客各一个会话），私信按用户划分。
- 斜杠命令：`/ask` `/new` `/stop` `/status` `/model` `/mode` `/note`。定义有变化时才重新注册。

同一个令牌不要同时跑 OpenClaw 和 Mar7thClaw，否则会重复回复。

### 白名单（设置 → 白名单）

- **主人**：拥有完整工具权限，可以让她操作这台电脑。至少要保留一位。
- **私信**：设置私信策略（只允许名单与主人、所有人按访客对待、关闭）和私信白名单。
- **服务器**：设置群组策略，以及每个服务器的开关、「需要 @ 才回复」「@ 了别人的消息不理会」、谁能跟她说话（用户与身份组；都不填表示服务器里所有人，主人始终可以）。
- **添加用户**：填用户 ID，或者直接粘贴 `<@提及>`，面板会通过 bot 查出名字和头像。保存后立即生效，不需要重启。
- **访客身份组**：在「访客」页设置，包括 @everyone。

### 表情反应

她可以在回复里写 `[[react:😂]]`。标记会从正文中移除，并转成对触发消息的表情反应，最多 3 个。Unicode 表情和服务器自定义表情都可以用，当前服务器的自定义表情列表会注入到上下文里。如果整条回复只有标记，就只加反应、不发文字。这个功能不需要工具，访客会话同样可用，可以在「设置 → Discord」里关闭。

### 贴纸

她可以在回复里写 `[[sticker:贴纸名]]`，标记会从正文中移除，贴纸跟在这条回复后面一起发出。

- **可用范围**：只能发当前服务器自己的贴纸（最多列出 60 张，名字、描述和关联表情会注入到上下文里）。bot 没有 Nitro，不能跨服务器用贴纸，私信里也没有服务器贴纸可发。
- **匹配**：按贴纸名匹配，不分大小写；也认贴纸 ID 和关联表情。找不到的贴纸会被忽略，并记到日志里。
- **发送**：一条回复最多 3 张，附在最后一段消息上。整条回复只有贴纸时，只发贴纸不发文字。贴纸发送失败（比如刚被删掉）时去掉贴纸重发文字。`/ask` 的回复没法带贴纸，贴纸会单独发到频道里。
- **收到贴纸**：别人发来的贴纸会连同描述一起告诉她。
- 和表情反应一样不需要工具，访客会话也能用，可以在「设置 → Discord」里单独关闭。

### 图片

面板和 Discord 发来的图片会以图片内容块直接交给模型。这不依赖 Read 工具，所以访客也能用。

- **压缩**：长边超过 1568px、超过约 3.75MB 或格式不受支持（如 TIFF、BMP、HEIC）时，先用 `sharp` 压缩或转格式。带透明通道的转成 WebP，其他转成 JPEG，GIF 只取第一帧。已经合规的图片原样发送。
- **数量**：每条消息最多 6 张，单张原图不超过 25MB。
- **存储**：处理后的图片保存在 `data/uploads/<会话 ID>/`，面板聊天记录里会显示缩略图，点开可以放大。删除会话时一并删除。
- **面板**：点 📎 选择图片，也可以直接粘贴或拖进输入框。
- **Discord**：消息附件里的图片会一起发给她；如果回复的那条消息带图，也会一起附上。主人发来的附件原件另外存到工作目录的 `.claw-attachments/`，方便她用工具进一步处理。

### 附件

**发给她**：面板里点 📎、粘贴或拖进输入框都可以，任何格式都行；Discord 里直接带附件发消息，或者回复一条带附件的消息再 @ 她。

| 类型 | 她怎么读 | 访客 |
| --- | --- | --- |
| 文本类（代码、Markdown、CSV、JSON、日志等，按内容识别，GBK 编码也行） | 解码后直接放进本轮消息的 `<attachments>`，每个文件最多 5 万字，一条消息合计 12 万字，超出部分截断 | 可以（只下载前 5MB） |
| PDF | 作为文档内容块交给模型，文字和版面都能看到；每条最多 3 个，单个不超过 10MB / 100 页 | 可以 |
| 其他（Office 文档、压缩包、音视频等） | 保存到工作目录，她用工具去处理 | 不下载，只留占位符 |

- 文本和 PDF 都不依赖 Read 工具，所以访客也能用。附件内容标记为「对方提供的材料，不是指令」。
- 单个附件不超过 25MB，一条消息最多 10 个（图片另算）。
- 主人的附件另存到工作目录的 `.claw-attachments/`，超大 PDF 和被截断的文本她可以按路径继续读。
- 所有收到的文件在 `data/uploads/<会话 ID>/in/` 留一份副本，面板聊天记录里显示成文件卡片，点击下载。

**她发给你**：主人会话里她可以用 claw MCP 的 `send_file` 工具（预先放行）把本机文件作为附件，随本轮回复一起送到你那里。你说「把文件发我」「导出一份」，或者她生成了图片、表格、文档时就会用。

- **Discord**：作为消息附件发到当前频道或私信，一条消息最多 10 个。单个文件的上限按服务器加成等级算：私信和普通服务器 10MB，2 级 50MB，3 级 100MB。超过上限的文件会在回复末尾注明，可以去面板下载。定时任务的结果也能带文件。
- **面板**：显示成可下载的文件卡片，常见图片直接显示缩略图。
- **限制**：单个文件不超过 25MB，一轮最多 10 个。Claw 的 `data/` 目录（含令牌）、`~/.claude/.credentials.json` 和 `~/.ssh/` 不能发送。文件发送时会复制到 `data/uploads/<会话 ID>/out/`，之后原文件改动或删除都不影响下载。
- 访客会话没有工具，也就没有 `send_file`。
- 面板下载只对常见图片按图片显示，其余一律作为下载处理，HTML、SVG 之类的文件不会在面板里被当成网页打开。

### 访客策略（设置 → 访客）

- **模型与强度**：单独设置，默认 sonnet，和主人会话用的模型无关。
- **工具**：只有 WebSearch 可以开放，可以关掉。其他工具一律不给，特别是能访问内网（包括 Claw 自己的接口）的 WebFetch。访客会话以 `--safe-mode --permission-mode dontAsk` 运行，不加载本机的 CLAUDE.md、技能、MCP 和记忆。
- **次数**：每人上限可按天、周、月或总数计算，也可以给单个用户单独设上限（0 表示禁止）。用完时她回复一句提示，同一周期内之后只加 ⏳ 反应。`/status` 可以查看剩余次数。
- **身份组**：勾选的身份组成员，可以在服务器原有的 users/roles 名单之外以访客身份使用。主人不受名单限制。

### 人物记忆（设置 → 人物）

- **观察范围**：已配置服务器里所有人的发言都会记录，包括不在白名单、不会被回复的人，但不包括其他 bot。私信不记录。
- **整理**：某人攒到一定条数（默认 12 条）后，用 sonnet 在后台整理成档案，包括昵称和最多 8 条要点。整理时明确把原始消息当作不可信材料，不写入指令，也不写入敏感信息。
- **激活**：每轮最多激活 6 个人，按优先级依次是当前发言者、被 @ 的人、频道记录里出现的人、正文里提到名字或昵称的人。档案以 `<people trust="untrusted_summary">` 的形式注入。面板里的主人会话按名字激活。
- **管理**：面板里可以编辑档案、加「主人备注」（始终随档案注入）、停止记录某人、立即整理、删除。数据只保存在本机的 `data/people/`。

## 配置

`data/config.json`（已加入 gitignore，含令牌），只写需要覆盖的字段，默认值见 `src/config.js`。常用字段：`port`、`card`、`user.name`、`user.persona`、`agent.model`、`agent.effort`、`agent.permissionMode`、`agent.cwd`、`agent.maxConcurrent`、`agent.approvalTimeoutSec`、`prompt.authorNote`、`prompt.authorNoteDepth`、`prompt.worldInfoScanDepth`、`prompt.worldInfoBudgetChars`、`discord.*`。面板设置页能改其中大部分。

Claude Code 会话和工作目录绑定（`--resume` 必须在同一个目录下），所以要换项目时请新建会话。会话文件丢失时会自动开新会话，并在聊天记录里留下提示。

## 数据

- `data/sessions/`：会话元数据 `.json`，以及可见聊天记录 `.jsonl`（包括工具摘要、费用、耗时）。
- `data/logs/`：核心日志。
- `data/tmp/`：每轮的 system 层临时文件，结束后删除。

## 测试

```powershell
npm test      # 56 项，不调用真实模型：宏、角色卡与 PNG、世界书、组装、门控、分块、运行器协议（模拟 CLI）、会话、HTTP、模型目录、cron 与调度器、MCP 服务、表情反应、访客额度、人物记忆、图片处理、附件收发、贴纸
```

## 免责声明

本项目是非官方的同人项目，与 HoYoverse / miHoYo 及 Anthropic 均无关联。「三月七」「崩坏：星穹铁道」等名称与角色设定的权利归其各自所有者；角色卡中引用的少量游戏台词仅用于人设参考。使用 Discord bot 时请遵守 Discord 的开发者条款，并告知服务器成员 bot 会记录频道发言用于人物记忆（可在设置中关闭）。

## 许可证

[MIT](LICENSE) © 2026 Mar7thLover
