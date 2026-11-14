# dsh-locus

[English](README.md) | 简体中文

为 **DeepSeek Harness（DSH）** 提供 Unity、Blender 和 LaTeX 工具，让智能体直接操作正在运行的编辑器、读取真实状态，并编译 LaTeX 文档。

| 领域 | 能力 |
| --- | --- |
| Unity | 执行 C#、读取控制台、切换播放模式、搜索资源、读取项目文件、执行菜单命令、请求重新编译 |
| Blender | 通过 `bpy` 执行 Python、读取场景状态、将场景渲染为图片 |
| LaTeX | 将 `.tex` 编译为 PDF，可选将第一页转换为 SVG，并提取错误与警告 |

本项目参考 [Locus](https://github.com/r1n7aro/Locus) 的集成思路，是独立实现的 DSH 插件，并非 Locus 官方发行版。与 Locus 一样，采用 **GPL-3.0-or-later** 许可证。

运行时不需要启动 Locus 桌面应用。插件通过分别运行在 Unity 和 Blender 内部的轻量桥接程序与编辑器通信。

## 工具列表

| 工具 | 用途 |
| --- | --- |
| `unity_status` | 查询编辑器版本、项目、当前场景、播放模式和编译状态 |
| `unity_execute` | 在编辑器中执行 C#，由 Roslyn 编译并在主线程运行 |
| `unity_console` | 读取最近的控制台日志，可按严重程度筛选 |
| `unity_playmode` | 开始播放、暂停或停止：`play` / `pause` / `stop` |
| `unity_asset_search` | 按文本、类型和目录搜索 `AssetDatabase` |
| `unity_asset_read` | 读取项目文件；文本直接返回，二进制以 Base64 返回 |
| `unity_menu` | 按路径执行编辑器菜单命令 |
| `unity_recompile` | 请求重新编译脚本 |
| `blender_status` | 查询版本、打开的文件、场景、对象数量和选择状态 |
| `blender_execute` | 执行 Python，预加载 `bpy`、`bmesh` 和 `mathutils` |
| `blender_screenshot` | 将当前场景渲染为 PNG |
| `latex_build` | 将 `.tex` 编译为 PDF，可选将第一页转换为 SVG |
| `latex_status` | 检查已安装的 LaTeX 引擎和 `dvisvgm` |
| `locus_instances` | 列出已连接的 Unity / Blender 实例及 LaTeX 工具链 |

## 安装

### 1. 安装 DSH 插件

在 DSH 界面中打开 **插件 → 添加插件**，选择本仓库目录，或粘贴其绝对路径。安装后完全退出并重新启动 DSH，让插件和工具加载。

也可以在完全退出 DSH 后使用命令行：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-locus
```

请将示例路径替换为本仓库的实际路径。

要求 Node.js 22.8 或更新版本。插件没有额外的 npm 运行时依赖，仅使用 Node.js 标准库和宿主传入的 Cordis `context`。

### 2. 安装 Unity 桥接包（每个项目单独安装）

1. 在本仓库目录运行 `node scripts/sync-roslyn.mjs`，将 Roslyn 程序集准备到 `unity-package/Editor/Roslyn/`。这些 DLL 不提交到仓库。脚本默认从找到的最新 Unity 编辑器中提取；安装多个版本时，建议用 `--from` 指定目标项目所用编辑器的 Roslyn 目录，避免版本混用。
2. 在 Unity 中打开 **Window → Package Manager → + → Add package from disk…**，选择 `unity-package/package.json`。也可以使用下面的安装脚本复制桥接包；脚本会检查项目已有的同名程序集，跳过需要复用的 DLL，减少重复程序集冲突。
3. 保持编辑器打开。桥接程序会自动启动，可通过 **Tools → dsh-locus → Show bridge status** 查看状态。

```sh
node scripts/install-unity-package.mjs --project "你的 Unity 项目路径"
```

只查看安装计划、不写入项目：

```sh
node scripts/install-unity-package.mjs --project "你的 Unity 项目路径" --check
```

手动指定 Roslyn 来源：

```sh
node scripts/sync-roslyn.mjs --from "Unity编辑器目录/Data/MonoBleedingEdge/lib/mono/msbuild/Current/bin/Roslyn"
```

要求 Unity 2021.3 或更新版本。桥接包仅在编辑器中运行，不会进入游戏构建。当前真机验证版本见下方“限制与验证范围”。

### 3. 安装 Blender 桥接插件（可选）

在 Blender 中打开 **Edit → Preferences → Add-ons → Install…**，选择 `blender-addon/dsh_locus_bridge.py`，然后启用 **dsh-locus bridge**。

桥接程序会随插件启动。在 3D 视图侧栏中会出现 `dsh-locus` 标签页，提供启动和停止按钮。

### 4. 安装 LaTeX 工具链（可选）

安装 MiKTeX 或 TeX Live，并确保 `xelatex`（也可使用 `lualatex` 或 `pdflatex`）在 `PATH` 中。只有生成 SVG 预览时才需要 `dvisvgm`。可调用 `latex_status` 检查环境。

## 配置

插件通过 `cordis.patch.yml` 注册以下配置：

```yaml
- insert:
    - id: dsh-locus
      name: dsh-locus
      config:
        allowExecute: true        # false 禁用 unity_execute / blender_execute
        timeoutMs: 30000          # 普通桥接调用超时，单位毫秒
        processTimeoutMs: 120000  # 代码执行、重编译、渲染和 LaTeX 的超时
        latexEngine: auto         # auto | xelatex | lualatex | pdflatex
        svgPreview: true          # latex_build 的 svg 参数默认值
```

可在所用 profile 的 `cordis.patch.yml` 中覆盖这些配置，然后重启 DSH。

## 工作原理

Unity 和 Blender 内部运行桥接程序，DSH 作为客户端连接。双方使用本机回环 TCP 通信，以换行分隔的 JSON 传递请求和结果，通过每个进程随机生成的令牌认证。

实例信息保存在 dsh-locus 状态目录中。Windows 下为 `%LOCALAPPDATA%\dsh-locus\instances`。完整协议、错误码和方法说明见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

选择 Unity 实例时，插件优先匹配包含当前会话工作目录的 Unity 项目；只有一个在线实例时可自动选择。存在多个实例时，可以给 Unity 工具传入 `project`，通过完整项目路径、项目名、实例 key 或进程 PID 明确指定。

## 测试

在仓库目录执行：

```sh
npm test                             # 38 项测试：插件入口、协议、发现、LaTeX、工具及 Blender 桥接
node scripts/sync-roslyn.mjs          # 准备 Roslyn；下方 C# 编译检查需要
node scripts/check-csharp.mjs         # 对照 Unity API 桩编译脚本
node scripts/check-csharp.mjs --unity # 对照本机真实 Unity 程序集编译脚本
npm run verify:host                  # 使用真实 DSH Cordis 和校验器验证插件
```

Blender 桥接测试使用真实插件代码和模拟的 `bpy`，不需要安装 Blender，可覆盖 socket 服务、令牌握手、主线程调度与实例生命周期。这两项测试需要 Python：优先尝试 `PYTHON` 环境变量指定的解释器，再依次尝试 `python`、`python3` 和 `py`；均不可用时会跳过。

`npm test` 使用单进程模式（`--test-isolation=none`），因为测试会启动真实 socket 和 Python 子进程，而受限沙箱可能禁止带管道的逐文件子进程。自行调用 `node --test` 时，请保留 `--test-isolation=none --test-force-exit`。

`verify-host.mjs` 从已安装 DSH 的 `app.asar` 中提取 `@deepseek-ai/cordis` 和 `@deepseek-ai/dsh-tools`，在真实 Cordis 上挂载、卸载插件，并使用宿主的 `assertSupportedJsonSchema`、`projectToolSchema` 和 `validateJsonSchemaValue` 检查工具契约。这补充了模拟测试无法验证的宿主兼容性。未找到 DSH 安装时会跳过；特殊安装路径可用 `--asar <路径>` 指定。

## 限制与验证范围

- **Blender 和 LaTeX 尚未完成真实应用端到端验证。** Blender 使用模拟 `bpy` 验证桥接机制；LaTeX 已覆盖缺少引擎和日志解析等情况，但尚未在真实 Blender 会话或实际 `xelatex` 编译中验证。
- **Unity 已在一个真实项目中验证，版本为 2021.3.18f1。** 已验证状态查询、C# 执行、控制台读取、资源搜索、文件读取，以及进入和退出播放模式、重载后重连和请求重新编译。菜单执行尚未在该项目中验证。
- `unity_execute` 使用 Roslyn 编译代码，并在 **Unity 编辑器主线程**运行，因此可以调用 Unity API。代码阻塞时编辑器也会阻塞，直到执行结束。请使用显式 `return` 返回结果，不支持自动返回末尾表达式。
- `await` 可以使用，但后续代码在线程池继续运行。此时调用 `Application.dataPath` 等要求主线程的 API 会报错。编辑器仍会等待代码完成；当前处理避免了同步上下文死锁，不能消除长时间运行代码造成的卡顿。
- `unity_execute` 和 `blender_execute` 分别允许在编辑器中运行任意 C# 和 Python。若只需要其他工具，可设置 `allowExecute: false`。
- 通信协议可用于 Windows、macOS 和 Linux，但目前仅在 Windows 上实际验证。

## 许可证与致谢

本项目采用 **GPL-3.0-or-later**，沿用参考项目 [Locus](https://github.com/r1n7aro/Locus) 的许可证。完整条款见 [LICENSE](LICENSE)。

这是独立实现，不包含 Locus 源代码，也不是 Locus 官方插件。感谢 Locus 提供的集成思路。

本地准备的 Roslyn 程序集保留 Microsoft 的 MIT 许可证，不因本项目的许可选择而改变。第三方组件说明见 [NOTICE](NOTICE)。
