# Mac mini：原生 DSH + Ubuntu Qwen

0.4.0 增加 macOS 文件操作与本机 Docker 命令后端。此文是目标 Mac 的安装与验收步骤；在目标机器完成真实隔离和模型测试前，不应把跨平台单元测试视为已验证 macOS 部署。

DSH 和项目文件位于 Mac。公开开发请求交给在线模型，私密工作者所需的消息和文件片段通过加密 SSH 隧道交给你信任的 Ubuntu Qwen。这里的“本地”指受信任的个人设备范围，私密内容会到达 Ubuntu；不会到达在线模型。Mac 的 shell 命令在 Mac 上的 Linux 容器执行，不能直接使用原生 macOS SDK。

## 1. 准备本机隔离环境

保留已有 DSH 安装和模型配置，先备份 profile、settings 和 lockfile。需要满足 package.json 的 Node 版本（Node 22.19+，或 24+）及 Python 3。

已有本机 Docker 引擎可以复用。没有时可按 [Colima 官方安装说明](https://colima.run/docs/installation/) 安装 Colima 和 Docker CLI，例如 Homebrew 环境：

```sh
brew install colima docker python
colima start --cpu 2 --memory 4 --runtime docker
```

不要改用远程 Docker context。插件每次调用都指定本机 Unix socket，忽略继承的 DOCKER_HOST/context。Colima 的默认 socket 通常为 `$HOME/.colima/default/docker.sock`；Docker Desktop 通常为 `$HOME/.docker/run/docker.sock`。检查它确实属于当前 Mac 的引擎。引擎需要支持 `bind-recursive=disabled`，可通过后文实机检查验证；不要为兼容旧引擎而删掉隔离选项。

已有 OrbStack 引擎也可复用，其 socket 通常为 `$HOME/.orbstack/run/docker.sock`。若其 Docker 包装程序在插件内报 `unsupported argv0 "docker-tools"`，安装 Homebrew 官方 `docker` CLI 并显式设置 dockerPath 为 `/opt/homebrew/bin/docker`，仍连接原有 OrbStack socket；不必另装容器引擎。

先在受信任的安装步骤下载运行镜像，再固定为本机 image ID：

```sh
docker --host "unix://$HOME/.colima/default/docker.sock" pull node:22-bookworm-slim
docker --host "unix://$HOME/.colima/default/docker.sock" image inspect node:22-bookworm-slim --format '{{.Id}}'
```

把输出的 `sha256:…` 用作下文 dockerImage。模型执行时禁止拉取镜像，也不会联网安装依赖。Docker 的 [none 网络](https://docs.docker.com/engine/network/drivers/none/) 将容器与主机和其他容器的网络隔离，文件只通过明确的快照挂载提供。

## 2. SSH 隧道连接 Qwen

使用你已有且已验证的 Ubuntu SSH 登录。先通过可信方式核对 Ubuntu 的 SSH 主机指纹；不要使用 StrictHostKeyChecking=no 或丢弃 known_hosts。下面的占位主机需替换为你的 Ubuntu SSH 目标：

```sh
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -L 127.0.0.1:18000:127.0.0.1:8000 USER@UBUNTU_LAN_HOST
```

隧道监听 Mac 的回环地址，Ubuntu 的 Qwen 服务仍只监听本机。保持该终端运行；不必新增系统服务或自动启动项。验证 `http://127.0.0.1:18000/v1/models` 返回实际目标模型。如果端口占用，选择另一空闲回环端口并同步更新 provider；如果鉴权是必需的，使用已有授权密钥并在 Mac 的凭证管理中保存，不要写入本文、Git 或聊天提示词。

如果服务器同时检查 HTTP Host 的端口，SSH 转发不会自动改写它。先检查是否已有经验证且符合服务器规则的回环隧道；可以让独立 ubuntu-qwen provider 复用该端口，保持其他 provider 不变。不要伪造 Origin 或关闭同源检查。新端口需要通过服务器支持的配置方式授权后再使用。

## 3. 添加单独的 Ubuntu Qwen provider

在 Mac DSH 的 `llm-pi-ai.providers` 中合并一个新 provider，保留其他 provider：

```yaml
ubuntu-qwen:
  displayName: Ubuntu Qwen（SSH 隧道）
  api: openai-completions
  baseURL: http://127.0.0.1:18000/v1
  apiKeyEnv: UBUNTU_QWEN_API_KEY
  timeoutMs: 900000
  streamIdleTimeoutMs: 900000
  compat:
    thinkingFormat: openai
    supportsReasoningEffort: true
    supportsDeveloperRole: false
    supportsStore: false
  models:
    - id: qwen3.8-27b-heretic-mtp-fp8
      name: Ubuntu Qwen3.8 27B Heretic MTP FP8
      contextWindow: 49152
      maxTokens: 32768
      reasoningEfforts:
        'off': none
        low: low
        medium: medium
        high: xhigh
```

当前 DSH 的 openai-completions 客户端即使访问不要求鉴权的服务也需要非空 API key。对于本次已确认无需服务端 API 鉴权、仅通过受信任回环 SSH 隧道访问的 Ubuntu 服务，在 DSH 的凭证/环境配置中设置 `UBUNTU_QWEN_API_KEY=local-ssh-tunnel`。这是非机密客户端占位符，不是真实安全密钥，不提供服务端认证；LAN 连接认证由 SSH 提供。若 Ubuntu 服务以后要求 API 鉴权，改用其实际密钥并仅在 Mac 本地凭证配置中保存。不要把真实密钥写入本文、Git 或提示词。

以 Ubuntu 当前实际模型目录为准；不要仅因名字相近便改写现有 provider。此配置的 Qwen High 保留原提供方 xhigh 出参映射。智能路由菜单仍只有默认、关闭、低、中、高五档。

## 4. 安装插件并配置主机字段

安装本 fork 的已验证固定提交，或用户提供且核对 SHA-256 的 0.4.0 发布包。不要用仍是 0.2.2 的远端旧版本替代包含 Mac 后端的版本。

```sh
dsh plugin --profile web add /absolute/path/to/dsh-privacy-router-0.4.0.tgz --ignore-scripts
```

在 web profile 的 `cordis.patch.yml` 合并到插件的现有覆盖项（不要复制第二个同名插件）。下面是新安装示例；已有信任名单应加入 ubuntu-qwen，保留其他可信目标：

```yaml
- id: privacy-router
  config:
    localProvider: ubuntu-qwen
    localModel: qwen3.8-27b-heretic-mtp-fp8
    cloudProvider: deepseek-official
    cloudModel: deepseek-flash
    trustedProviders: [ubuntu-qwen]
    trustedProviderPrefixes: []
    sandboxBackend: docker
    dockerPath: /opt/homebrew/bin/docker
    dockerSocket: /Users/YOUR_USER/.colima/default/docker.sock
    dockerImage: sha256:REPLACE_WITH_LOCAL_IMAGE_ID
    pythonPath: /opt/homebrew/bin/python3
```

可留空 dockerPath/dockerSocket/pythonPath，由插件从已知本机位置寻找；显式路径应匹配当前 Mac，不要照抄 Ubuntu 路径。dockerImage 必须已存在于本机引擎。上述字段属于主机信任配置，设置页不能覆盖。

在线目标使用 Mac 已配置且可用的 DeepSeek provider；如名称不同，采用实际 provider id。保留全局默认模型和现有 Qwen 模型选项。添加 provider 和主机配置后，在设置页核对智能路由实际使用的本地/在线目标；已有用户设置可能覆盖基础 localProvider/cloudProvider。把路由本地目标设为 ubuntu-qwen 和实际模型，在线目标设为实际 DeepSeek provider，同时保留普通模型列表和全局默认值。

## 5. 项目与运行验收

没有项目时，建立全新的 `~/Projects/dsh-collaboration` 示例项目，仅授权 public/，private/ 和 tests/ 保密。不要自动扫描或授权已有项目。设置页选择“私密开发协作”，填入物理绝对项目路径、公开项目简介和本地集成命令。

从克隆源码运行测试；安装依赖时按当前 DSH 版本处理 peer dependencies，不要为消除提示而盲目升级整个 DSH。随包提供的 `scripts/check-mac-runtime.mjs` 必须在 Mac 实际运行：

先建立主机拥有的 `/absolute/path/to/host-runtime.json`，例如（替换用户名、实际安装路径和前面取得的镜像 ID）：

```json
{
  "sandboxBackend": "docker",
  "dockerPath": "/opt/homebrew/bin/docker",
  "dockerSocket": "/Users/YOUR_USER/.colima/default/docker.sock",
  "dockerImage": "sha256:REPLACE_WITH_LOCAL_IMAGE_ID",
  "pythonPath": "/opt/homebrew/bin/python3"
}
```

在源码目录使用同一份配置运行测试和实际验收：

```sh
DSH_TEST_RUNTIME_CONFIG=/absolute/path/to/host-runtime.json npm test
node scripts/check-mac-runtime.mjs /absolute/path/to/host-runtime.json
```

JSON 文件只接受 sandboxBackend/dockerPath/dockerSocket/dockerImage/pythonPath，不包含模型密钥、项目授权、平台覆盖或跳过测试选项。DSH_TEST_RUNTIME_CONFIG 只供测试夹具使用，不改变生产配置。工作区与协作测试使用其中相同的 Docker 路径、socket、镜像和 Python。Linux 测试仍运行真实 bwrap 和 Python，不能通过此配置模拟 Mac 成功。

Mac 测试启动器在账户主目录创建全新的物理路径临时目录，作为子测试进程的 TMPDIR，待子进程结束后清理，兼容默认 Colima 主目录共享。Python 直接测试和文件后端使用同一个经过实际启动验证的解释器；留空时依次检查 /usr/bin/python3、/opt/homebrew/bin/python3、/usr/local/bin/python3，跳过不可用的系统启动器。显式指定的 Python 不可用时直接失败，不改用其他解释器。

检查程序使用全新合成文件，验证文件私密边界、真实容器命令、无非回环网络接口和路由、主机回环 canary 不可达、隐藏主机文件/环境、只读公开接口及正常写回。超时检查从运行调用开始给出 10 秒启动观察预算（包括快照检查）；必须在停止前观察到运行中的父进程和子进程各自写出的启动标记。取消检查等待这两个标记后才取消。两者都等到父子进程原定晚写时间之后，再确认文件不存在。检查不需要连接互联网；缺失启动证据、后端/Python 不可用、一般启动错误或清理不能确认均明确失败，不静默跳过。

然后在 DSH 空闲时手动重启，在网页核对：设置保存和重载、独立“智能路由”、五档菜单、切回普通 Qwen 保持直连。用合成私密标记完成一次公开模块 + 本地私密模块 + 集成测试，捕获实际云端请求并确认不含标记；不要把真实私密项目用于验收。

普通聊天默认私密。给在线模型新增可公开需求时仅在该消息前加 `/公开 `。本地任务和集成测试的固定回执不能证明成功，完整结果只在本地会话显示。

## 故障处理

- SSH 断开：停止本轮并重建已验证的隧道，不切换到在线模型代替处理私密任务。
- Docker/Python/镜像不可用：修复本机依赖后再试，不退回无限制 shell。
- Docker 清理失败：先用同一本机引擎检查并停止插件命名的残留容器，再继续；不可把“客户端退出”当作“容器已停止”。
- 浏览器管理策略校验失败：使用工具支持的重连或修复上游服务，不修改策略、不伪造允许结果；未恢复时不要声称页面实测完成。
