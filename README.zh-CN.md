# Antigravity Claw

> **不要让您Gemini Pro订阅包含的额外token付诸东流!**
> **Stop wasting your EXTRA TOKEN from a Gemini Pro subscription you already paid!**

[**English**](README.md) | **简体中文**

面向 [OpenClaw](https://github.com/openclaw/openclaw) 的双提供商
[Antigravity](https://antigravity.ai) 集成:一个一等公民的 `agy` CLI agent
harness,**加上**一条原生 OpenAI 兼容的 API-key 路由,支持热切换与自动备份接管。

| Provider             | 后端                    | 运行时                                         | 认证                       |
| -------------------- | ----------------------- | ---------------------------------------------- | -------------------------- |
| `antigravity`        | Antigravity CLI (`agy`) | 插件 agent harness(`agentRuntime.id = "antigravity"`) | `agy` 本地登录       |
| `antigravity-openai` | OpenAI 兼容 API         | OpenClaw 内置运行时                             | API key(`OPENAI_API_KEY`) |

在两条提供商之间切换 agent 的模型选择,就是热切换本身。核心的模型回退
(`agents.defaults.model.fallbacks`)会在配额、限流、认证失败时自动接管,因此
CLI 与 API 两条路由互为备份,不需要任何通道专属代码。

## 特性

- **原生 agent harness** —— `agy --print` 以真正的 OpenClaw `AgentHarnessV2`
  运行:每次尝试可用性探测、NDJSON delta 流式进入常规 assistant 管线、会话
  转写持久化、超时/中止时的进程树清理,以及分类后的终端失败(billing、
  rate limit、auth、server error),供核心故障转移使用。
- **原生 API-key 路由** —— `antigravity-openai` 使用 OpenClaw 内置运行时与
  OpenAI 兼容传输。不需要 CLI 二进制或登录。
- **热切换 + 备份接管** —— 改一次模型选择即可在提供商之间切换;运行时回退
  (`fallbackRuntime: "openclaw"`)与模型回退链覆盖二进制缺失、key 缺失、配额
  与限流。
- **Skills** —— `antigravity-cli` 与 `antigravity-api` 的切换、预检、取消与
  迁移 playbook。
- **配额进度条** —— 聊天里用 `/quota` 查看 agy CLI 配额池(周限额 + 5 小时
  限额),带进度条、剩余百分比与重置倒计时,数据直接来自 agy `/usage` 面板
  所用的同一个 Cloud Code RPC。
- **一键切换** —— `/keys` 以按钮形式列出 API key 与提供商/模型切换;
  `/keys use <profile>` 换到另一个 key 并挑选模型。
- **无通道 hack** —— 回复与转写都走标准 OpenClaw 管线,所有通道表现一致。

## 架构

```
            model selection (agents.defaults.model)
                            |
        +-------------------+-------------------+
        |                                       |
 antigravity provider               antigravity-openai provider
 agentRuntime.id = "antigravity"     (no runtime policy)
        |                                       |
 antigravity harness                  built-in OpenClaw runtime
 (AgentHarnessV2)                      (openai-responses transport,
        |                                API-key auth)
 agy --print stream-json
```

- `harness.ts` —— `AgentHarnessV2` 实现(启动、流式、终止、故障转移)。
- `src/agy-client.ts` —— 二进制解析、可用性探测、NDJSON 解析、错误分类。
- `src/agy-quota.ts` / `src/agy-quota.render.ts` —— 配额 RPC 客户端(凭据读取、
  拉取)与 Telegram 进度条渲染器。
- `src/commands.ts` —— `/quota` 与 `/keys` 插件聊天命令。
- `models.ts`、`provider-catalog.ts`、`provider-discovery.ts` —— 静态离线目录。
- `openclaw.plugin.json` —— manifest:激活、提供商、配置 schema、模型目录、skills。
- `skills/` —— 热切换 playbook。

完整设计说明见 `DESIGN.md`。

## 安装

需要 OpenClaw `>= 2026.8.1`(目前 npm 上是 OpenClaw beta 通道:`2026.8.1-beta.x`)。

```bash
openclaw plugins install git:https://github.com/CheeseGhostfox/antigravity-claw
```

插件注册两条提供商:

- `antigravity` —— CLI harness(需要 `agy` 二进制,见下文)。
- `antigravity-openai` —— API-key 路由。

### 安装 Antigravity CLI(用于 `antigravity` 提供商)

```bash
agy login        # 交互式登录一次
agy --version    # 验证
```

如果 `agy` 不在 `PATH` 中,可在插件配置里指定显式路径(见下文)。

## 配置

`openclaw.json` 中可选的 `plugins.entries.antigravity.config` 块:

```jsonc
{
  "plugins": {
    "entries": {
      "antigravity": {
        "config": {
          "binaryPath": "C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe",
          "sandbox": true,
          "projectPrefix": "openclaw"
        }
      }
    }
  }
}
```

- `binaryPath`(string)—— 显式指定 `agy` 可执行文件。默认取 `PATH` 上的 `agy`,
  然后是 Windows AppData 安装位置。
- `sandbox`(boolean,默认 `true`)—— 给 `agy` 传 `--sandbox`。
- `projectPrefix`(string,默认 `"openclaw"`)—— `agy --project <prefix>-<hash>`
  的稳定前缀。

## 用法

### CLI harness(`antigravity`)

```bash
# 把 agent 默认模型切到 CLI 提供商
openclaw models --set-default "antigravity/Gemini 3.7 Flash (High)"
```

CLI 模型:`Gemini 3.7 Flash (High|Medium|Low)`、`Gemini 3.1 Pro (High|Low)`、
`Gemini 3.6 Flash (High)`。

### API-key 路由(`antigravity-openai`)

```bash
openclaw onboard   # 选择 "Antigravity API (OpenAI-compatible)"
# 或
export OPENAI_API_KEY=sk-...
openclaw models --set-default antigravity-openai/gpt-5.6-sol
```

API 模型:`gpt-5.6-sol`、`gpt-5.6`、`gpt-5.2`、`o3`、`gpt-5-mini`。

### 定制 API-key 路由(模型、端点、思考深度)

`openclaw.plugin.json` 里的 OpenAI 条目只是随附的**示例**目录。API-key 路由
的每个请求级细节都可在 `openclaw.json` 的 `models.providers["antigravity-openai"]`
下配置;OpenClaw 会把这些行合并到插件的静态目录之上:

- `baseUrl` —— 任意 OpenAI 兼容端点(提供商级,或按模型)。
- `api` —— `openai-responses`(默认)或 `openai-completions`。
- `models[]` —— 增删或替换模型:`id`、`name`、`reasoning`、`input`、
  `params`、`contextWindow`、`contextTokens`、`maxTokens`、`compat`。
- `thinkingLevelMap` —— 把 OpenClaw 思考档位(`off|low|medium|high|xhigh|max`)
  映射到端点的 reasoning-effort 字符串(例如 `none`、`minimal`、`low`)。
- `compat.supportedReasoningEfforts` —— OpenClaw 提供哪些思考档位。
- `compat.supportsReasoningEffort` —— 端点是否接受 effort。

```jsonc
{
  "models": {
    "providers": {
      "antigravity-openai": {
        "baseUrl": "https://gateway.example.com/v1",
        "api": "openai-completions",
        "models": [
          {
            "id": "my-reasoning-model",
            "name": "My Reasoning Model",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 128000,
            "contextTokens": 32000,
            "maxTokens": 16000,
            "thinkingLevelMap": {
              "off": "none",
              "low": "minimal",
              "medium": "low",
              "high": "medium",
              "xhigh": "high",
              "max": "high"
            },
            "compat": {
              "supportsReasoningEffort": true,
              "supportedReasoningEfforts": ["none", "minimal", "low", "medium", "high"]
            }
          }
        ]
      }
    }
  }
}
```

API key 始终绑定在提供商 id 上(`OPENAI_API_KEY` 或
`openclaw auth login antigravity-openai --openai-api-key <key>`),与 `baseUrl`
指向哪个端点无关。把 agent 指向新模型:

```bash
openclaw models --set-default antigravity-openai/my-reasoning-model
```

可复制的模板在 `examples/api-key-custom-endpoint.jsonc`。

### 热切换与备份接管

把一条路由设为主、另一条设为自动回退:

```jsonc
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "antigravity/Gemini 3.7 Flash (High)",
        "fallbacks": ["antigravity-openai/gpt-5.6-sol"]
      }
    }
  }
}
```

- CLI 可用 → 尝试经 `agy --print` 运行,delta 流式进入常规 assistant 管线。
- CLI 二进制缺失 / 未登录 / 命中配额 → harness 返回失败的尝试终端;核心推进
  回退链到 API 路由(或在同一路由上用 OpenClaw 内置运行时重跑尝试)。
- API key 缺失 / 命中配额 → 核心推进到 CLI 回退。

## 聊天命令

所有切换都是核心模型选择 —— 这些命令只是 `/model` 与 `/think` 之上更友好的
聊天入口。

### `/quota` —— Antigravity CLI 配额

按模型分组显示 `antigravity`(CLI)提供商背后账户的剩余配额池,带进度条:

```text
📊 Antigravity CLI quota
   · account u***@example.com

📊 Gemini 3.7 Flash (High)
   · Gemini 3.7 Flash (High)
▸ Weekly Limit  [█████████████░░░] 83% remaining · resets in 73h 53m
▸ 5-hour Limit  [██░░░░░░░░░░░░░░] 12% remaining · resets in 2h 7m
```

数据来自 agy `/usage` 面板所用的同一个私有 Cloud Code RPC
(`loadCodeAssist` → `retrieveUserQuotaSummary`)。agy OAuth token 从系统
keyring(`gemini`/`antigravity`)读取,无头 Linux 则读 token 文件;
`AGY_OAUTH_TOKEN_FILE` 可覆盖路径。token 只读 —— 从不写回、不进日志。
账号登录与 token 刷新仍由 agy 自己负责(运行 `agy` 就会刷新存储的 token);
如果 agy 未登录或 token 已过期,命令会明确告诉你。

### `/keys` —— 切换提供商、模型与 API key

```text
/keys               列出提供商 + API key,带一键切换按钮
/keys use <profile> 选一个 key,然后点你想用的模型
/keys help          用法
```

- 提供商切换:按钮派发 `/model antigravity/Gemini 3.7 Flash (High)`(CLI)或
  `/model antigravity-openai/<model>`(API)。
- 两条路由的思考深度:`/think low|medium|high`。
- API key 切换:模型 ref 后缀 `@<profile>` 选择认证 profile,例如
  `/model antigravity-openai/gpt-5.6-sol@work`。

### 多个 API key

每个 API key 都是 `antigravity-openai` 提供商的一个 OpenClaw auth profile。
在网关主机上添加 key:

```bash
openclaw models auth login --provider antigravity-openai --profile-id work --method api-key
openclaw models auth login --provider antigravity-openai --profile-id personal --method api-key
```

按会话(`-s`)、agent(`-a`)或全局(`-g`)切换:

```bash
openclaw models --agent -s "antigravity-openai/gpt-5.6-sol@work"
openclaw models --agent -s "antigravity-openai/gpt-5.2@personal"
```

在聊天里,`/keys use work` 与模型按钮效果相同。可复制的模板在
`examples/multi-key-profiles.jsonc`。

## Skills

- `antigravity-cli` —— 切到 CLI harness;可用性检查;取消;迁移说明。
- `antigravity-api` —— 切到 API-key 后端;key 配置;取消;迁移说明。

## 开发

### 从源码构建

仓库提交了编译后的 `dist/` 产物,所以安装后的插件无需构建步骤。本地重建:

```bash
npm install        # 安装 openclaw peer(dev 依赖)+ 工具链
npm run build      # tsc -p tsconfig.build.json -> dist/
npm test           # vitest run(全部 src 套件)
npm run typecheck  # tsc -p tsconfig.json
```

加载器级契约测试(注册、harness 门控、故障转移分类)在 OpenClaw monorepo 里,
因为它们用到发布版 `openclaw` 包不导出的内部 `plugin-test-runtime` 模块;
`src/` 下的纯函数套件则独立运行。

### 打包方式

OpenClaw 要求外部安装的插件包提供编译后的运行时产物(TypeScript 源码回退只
对本地 `--link` 开发路径开放)。因此本仓库提交 `dist/` 并显式声明:

```json
{
  "openclaw": {
    "extensions": ["./index.ts"],
    "runtimeExtensions": ["./dist/index.js"]
  },
  "peerDependencies": {
    "openclaw": ">=2026.8.1-0"
  }
}
```

- `openclaw.runtimeExtensions` 让安装器指向仓库里已存在的编译入口。
- `openclaw` peer 依赖让 OpenClaw 把宿主 SDK 包链接进插件的 `node_modules`,
  使 `openclaw/plugin-sdk/*` 导入在运行时解析。
- 改源码后记得同步 `dist/`:`npm run build`,然后提交。
- `types/openclaw-sdk-shared.d.ts` 为发布版 `openclaw` npm 包未随附 `.d.ts`
  的 SDK 子路径提供本地类型声明;运行时解析不受影响。

## 故障排查

- `agy --version` 失败 → 安装 `agy` 或设置 `binaryPath`。harness 会探测
  `agy --help` 并自动回退。
- "not logged into Antigravity" 报错 → 运行 `agy login`。
- 未登录时 `agy models` 会卡住 → 插件探测阶段从不运行它;模型 id 是静态的。

## 许可证

MIT —— [OpenClaw](https://github.com/openclaw/openclaw) 的衍生作品
(MIT,Copyright (c) 2026 OpenClaw Foundation)。见 `LICENSE`。