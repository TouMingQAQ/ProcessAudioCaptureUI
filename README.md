# 进程音频监听

**挑一个正在出声的程序，实时看它的声音。**

Windows 桌面工具：按**进程**（而不是整块声卡）截取音频，实时画出波形、对数频谱与电平表。
收起时是屏幕角落一颗会跟着声音跳动的悬浮球；关掉主界面也不会退出，托盘图标一直待着。

界面本身只负责展示与交互：**枚举可采集目标、探测音频会话、读取媒体信息、DSP 全部由采集内核
（`ProcessAudioCapture.dll`，C ABI）提供**，本程序通过动态绑定消费它的结果。

> 采集内核来自 [`TouMingQAQ/ProcessAudioCapture`](https://github.com/TouMingQAQ/ProcessAudioCapture)。
> 本程序要求内核 **v3 及以上**（内核缺这组符号时界面会明确提示版本过旧）。
> 仓库里随程序分发的是修复过两个致命缺陷后重新编译的二进制，缺陷分析见 [附录 B](#附录-b两处上游缺陷与修复)。

---

## 功能

| | |
| --- | --- |
| **按程序挑源** | 列出所有可采集的进程并标注它是否正在出声；播放器缩进托盘（一个窗口都没有）时也能识别，界面上打「托盘」标记 |
| **实时可视化** | 256 点峰谷包络波形 · 128 柱对数频谱（20 Hz → Nyquist）· RMS / 峰值电平表 |
| **悬浮球** | 收起时是一枚会跟着音乐律动的小球，悬停展开操作面板：当前曲目、音量表、开始/停止、自动跟随。可拖到任意位置 |
| **样式与配色分离** | 悬浮球分两个独立维度：**律动样式**只管形状（六种，见下），**配色主题**只管颜色（十一种）。任意组合 |
| **两种律动数据** | 小球可以跟着 **128 柱对数频谱** 跳，也可以跟着 **256 点峰谷包络波形** 跳，或者让程序每帧自适应挑更活跃的那份 |
| **系统托盘** | 左键显示 / 隐藏主界面；右键菜单复用悬浮球的功能 |
| **监听缓存** | 记住最近监听的进程，下次启动自动接着听；它不在（没开 / 已退出）就一直等它出现。也可以手动指定持续监听对象 |
| **帧率上限** | 波形 / 频谱 / 悬浮球每秒最多画多少帧（默认 30，可关掉限制），同一个数也决定内核每秒推几帧 |
| **自动跟随** | 当前源安静下来、另一个程序开始出声时，自动把采集切过去（带连续确认，避免抖动） |
| **媒体信息** | 曲名 / 歌手 / 播放状态取自系统媒体控件（SMTC）—— 也就是媒体键、音量面板上显示的那份数据 |
| **录制** | 可选把捕获到的音频同时存成 16-bit PCM WAV |

## 使用

1. 启动后主界面左侧列出所有可监听的程序，**正在出声的排在前面**，右侧带实时电平条；
2. 让目标程序（浏览器 / 播放器 / 游戏）先出点声音，列表里的条目会亮起「正在播放」；
3. 选中它 → 需要的话勾上「录制 WAV」→ 点「开始采集」；
4. 右侧实时显示波形与频谱；
5. 想让它常驻后台：直接关掉主界面即可 —— 程序退到托盘，采集继续跑。
   之后左键点托盘图标唤回主界面，右键可在菜单里开关采集 / 自动跟随 / 悬浮球，或退出程序。

悬浮球上收着同样的操作：鼠标移到小球上展开面板，里面有「开始 / 停止采集」「自动跟随」，
以及当前正在播的曲目与音量。

### 悬浮球：形状与颜色是两件事

设置 →「主题」里，悬浮球被拆成互不相干的两块，可以自由组合：

| | 管什么 | 有哪些 |
| --- | --- | --- |
| **配色**（悬浮球主题） | 只管颜色：小球、外发光、悬停面板的用色 | 纯色 / 马卡龙 / 樱花 / 深海 / 苔原 / 落日 / 葡萄紫 / 流金 / 霓虹 / 石墨 / 薄荷 |
| **律动样式** | 只管形状：小球长什么样、怎么跟着音乐动（样式里一个颜色都不写） | 环柱 / 柱阵 / 示波 / 粒子 / 涟漪 / 激光 |

| 样式 | 画什么 |
| --- | --- |
| **环柱** | 经典环形频谱：一圈柱子的长度就是各频段的能量 |
| **柱阵** | 球体正面一列均衡器柱，低音在左、高音在右（天生就是频谱柱，只吃频谱） |
| **示波** | 把波形卷成一圈，直接描出峰谷包络的起伏 |
| **粒子** | 一圈细小光点被音乐推开，安静时轻轻呼吸 |
| **涟漪** | 声压一圈圈荡开，响度越大涟漪越密越亮 |
| **激光** | 两道细长的激光线扫过球体，鼓点越强转得越快 |

### 小球读哪一份数据

采集内核一次给出两份可视化数据，小球可以挑：

| 数据源 | 是什么 | 特点 |
| --- | --- | --- |
| **频谱** | 128 柱对数频谱（20 Hz → Nyquist） | 分得清频段：低音在左、高音在右，鼓点与镲片各占各的位置 |
| **波形** | 256 组 `(min, max)` 峰谷包络 | 跟的是整体起伏与冲击力，不区分频段，鼓点更直接 |
| **自适应** | 每一帧比较两者 | 谁更活跃就用谁 —— 安静的段落用频谱看细节，密集段落用波形看冲击 |

设置里的样式卡片是**真画布**：跑的就是悬浮球窗口那一份绘制代码（`ball-render.ts` 的
`renderOrb`），所以卡片上的球就是换成它以后的样子，不会"预览挺好看、套上去不是那样"。

## 架构

```
        界面（本程序 · Tauri + TypeScript）
   ┌─────────────────────────────────────────────┐
   │  主界面：目标列表 / 波形 / 频谱 / 日志          │
   │  悬浮球 · 系统托盘                            │
   └────────────────────┬────────────────────────┘
                        │ Tauri 命令与事件
   ┌────────────────────▼────────────────────────┐
   │  宿主编排层（只管"显示什么"）                  │
   │  pac.rs 动态绑定 · sessions.rs 转结构          │
   │  dsp.rs 转帧 · capture.rs 会话 · monitor.rs    │
   └────────────────────┬────────────────────────┘
                        │ C ABI（15 个导出符号）
   ┌────────────────────▼────────────────────────┐
   │  采集内核 ProcessAudioCapture.dll             │
   │   · 目标枚举：窗口 + WASAPI 会话 + SMTC        │
   │   · 采集：进程回环 → 32-bit float PCM          │
   │   · DSP：降混 / 包络 / FFT / 电平表            │
   └─────────────────────────────────────────────┘
```

| 模块 | 负责 |
| --- | --- |
| `pac.rs` | 动态加载内核、绑定 15 个导出符号，并把 C 结构整份拷成 Rust 数据 |
| `sessions.rs` | 调 `pac_enum_targets`，把内核条目转成前端要的结构 |
| `dsp.rs` | 调 `pac_analyzer_*`，把一帧分析结果转成事件载荷 |
| `capture.rs` | 一次采集会话：回调缓冲队列、发射线程（按帧率上限出帧，默认 50 fps）、WAV 落盘 |
| `monitor.rs` | 后台每 1.2 s 扫一次：刷新采集源信息、驱动自动跟随、同步托盘菜单、发现异常中断 |
| `tray.rs` | 系统托盘图标与右键功能菜单 |
| `wav.rs` | 16-bit PCM WAV 写入（先写占位头，结束时回填尺寸） |

### 那些原本"内核没有、宿主补齐"的能力，现在都在内核里

| 能力 | 现在由内核提供的接口 |
| --- | --- |
| 枚举有哪些窗口 / 进程 | `pac_enum_targets` |
| 判断进程当前是否在出声 | 条目里的 `has_session` / `session_state` / `session_peak`（内核走 WASAPI） |
| 没有窗口的进程（缩在托盘的播放器） | 条目 `has_window = 0`，标题由内核从 SMTC 取 |
| "现在在放什么" | 条目里的 `media_title` / `media_artist` / `media_album` / `media_status`（内核走 SMTC） |
| 音频格式探测 | `pac_capture_format`（起流即可拿到，不必等首帧回调） |
| 降混 / 包络 / 频谱 / 电平 | `pac_analyzer_create` / `pac_analyzer_process` |
| 停止 / 异常结束的通知 | `pac_is_capturing` / `pac_capture_error` |

宿主因此**不再依赖 `windows` crate，也不再有 FFT 库**：
`src-tauri/Cargo.toml` 里只剩 `tauri` / `serde` / `serde_json` / `libloading`。

### 播放器最小化到托盘怎么办

播放器「最小化到托盘」后窗口就没了（`MainWindowHandle = 0`），这时会出现两个问题：

* 只靠窗口枚举，这个进程会**从列表里整个消失** —— 明明在放歌却什么都看不到，连采集都无从启动；
* 也就没有窗口标题可读（播放器一般把歌名写在标题里）。

内核对此的处理是：把"只有音频会话、没有可见窗口"的进程也补进列表（`has_window = 0`、`hwnd = 0`），
标题取自 SMTC，拼成 `歌名 - 歌手`。匹配方式是会话 AUMID ↔ 进程名（Win32 程序的 AUMID 通常就是
可执行文件名）；只有在"没有任何窗口标题可读、且机器上仅此一条媒体会话"时才会退化成直接认这条会话。
界面这边只需要认 `windowVisible` 字段，给它打上「托盘」标记。

## 目录结构

```
ProcessAudioCaptrueUI/
├── index.html                  # 主界面骨架
├── ball.html                   # 悬浮球窗口骨架
├── app-icon.png                # 图标源图（1024²，用 npx tauri icon 生成各平台图标）
├── scripts/
│   ├── with-msvc.mjs           # 注入 MSVC 环境后执行命令（本机必需，见"构建"）
│   └── test-audio.ps1          # 循环播放系统 wav，用来造一个"正在出声"的进程
├── src/
│   ├── main.ts                 # 主界面逻辑（窗口列表 / 采集控制 / 事件订阅）
│   ├── ball.ts                 # 悬浮球逻辑（悬停展开 / 拖拽 / 快捷采集）
│   ├── ball-style.ts           # 悬浮球「律动样式」表 + 数据源（频谱 / 波形 / 自适应）
│   ├── ball-render.ts          # 小球绘制（纯函数：六种样式，实时与预览共用）
│   ├── orb.ts                  # 悬浮球实时循环（平滑、空闲衰减、数据源切换）
│   ├── visualizer.ts           # 主界面 Canvas 波形 + 频谱 + 电平表渲染
│   ├── render-gate.ts          # 「这个窗口该不该画」：定向可见性事件 + 文档可见性 → 停 / 开绘制循环
│   ├── api.ts                  # 与 Rust 命令、事件的类型化封装
│   ├── theme.ts                # 应用主题 + 悬浮球配色（色板 → CSS 变量）
│   ├── settings.ts             # 界面偏好的前端状态（读 / 改 / 广播）
│   ├── settings-panel.ts       # 设置面板（通用 / 主题 / 内核）
│   ├── i18n.ts                 # 中英文案
│   ├── styles.css              # 主界面样式
│   └── ball.css                # 悬浮球样式
└── src-tauri/
    ├── binaries/
    │   ├── ProcessAudioCapture.dll                # 采集内核 v3（见附录 B）
    │   └── official-beta/ProcessAudioCapture.dll  # 官方 v0.0.1_beta 原版（有缺陷，仅供对比）
    ├── icons/                  # 各平台图标（由 app-icon.png 生成）
    ├── src/
    │   ├── pac.rs              # 内核的动态绑定（15 个导出符号）
    │   ├── sessions.rs         # 目标列表：调内核 + 转前端结构
    │   ├── dsp.rs              # 可视化 DSP：调内核分析器 + 转帧
    │   ├── capture.rs          # 采集会话、缓冲队列、发射线程
    │   ├── monitor.rs          # 后台扫描：刷新采集源信息 + 自动跟随切换
    │   ├── tray.rs             # 系统托盘图标与右键功能菜单
    │   ├── wav.rs              # 16-bit PCM WAV 写入
    │   └── lib.rs              # Tauri 命令与状态
    └── tauri.conf.json
```

## 命令与事件

| 命令 | 作用 |
| --- | --- |
| `dll_status()` / `reload_dll()` | 采集内核是否就绪、版本号、候选路径；重新加载 |
| `list_audio_windows()` | 返回 `{ windows, warnings }`，含 PID / 标题 / 进程名 / 会话状态 / 会话峰值 / 是否有窗口 / 媒体信息 |
| `start_capture(pid, processName, recordWav)` | 指定进程启动采集，返回真实采样率与声道数 |
| `start_capture_best(recordWav)` | 自动挑当前最"响"的进程启动采集（悬浮球 / 托盘用它） |
| `stop_capture()` | 停止采集，返回帧数 / 时长 / WAV 路径 / 丢帧统计 |
| `capture_status()` | 当前采集状态（供悬浮球同步 UI） |
| `set_auto_follow(enabled)` | 自动跟随开关 |
| `set_monitor_target(processName)` | 设置 / 清除持续监听对象（空串 = 清除）：目标在跑就切过去采，不在跑就等它 |
| `set_ball_visible(visible)` / `set_ball_expanded(expanded)` | 悬浮球显示隐藏 / 展开收起 |
| `show_main_window()` | 唤起主窗口 |

| 事件名 | 负载 |
| --- | --- |
| `pac://audio-frame` | `{ pid, totalFrames, elapsedMs, waveform[512], spectrum[128], rms, peak, windowMs }` |
| `pac://stopped` | `StopReport` |
| `pac://error` | `string` |
| `pac://monitor` | `MonitorTick`：每 1.2 s 广播一次采集源信息（标题 / 状态 / 峰值 / 媒体信息）、候选源，以及持续监听的目标与"是否在等它出现" |
| `pac://capture-changed` | `CaptureChanged`：自动跟随切换、托盘快捷操作、持续监听起流、异常中断的结果提示 |
| `pac://window-visibility:<label>` | `{ visible }`：窗口藏起来 / 露出来了（`main` / `ball` 各一条，定向投递）。名字按窗口分开是必须的：Tauri 的定向事件对没指定 `target` 的监听者（`listen()` 的默认 `Any`）并不隔离 |

`waveform` 是 256 组 `(min, max)` 对，`spectrum` 是 20 Hz → Nyquist 的 128 个对数频率柱，两者都由内核算出。
悬浮球两种都能用：样式里声明自己读哪一份（见「小球读哪一份数据」），不用改 Rust 侧。

### 界面偏好

主界面与悬浮球是两个 WebView，主题、语言这类设置存在应用配置目录的 `settings.json`，
改一次由 Rust 广播 `pac://settings`，两边同时生效。与悬浮球有关的两项：

| 字段 | 含义 |
| --- | --- |
| `ballTheme` | 悬浮球**配色** id（`theme.ts` 的 `BALL_THEMES`） |
| `ballStyle` | 悬浮球**律动样式** id（`ball-style.ts` 的 `BALL_STYLES`） |
| `ballSource` | 小球读哪份数据：`spectrum` / `wave` / `adaptive` |

另外两项不在悬浮球名下，但两个窗口都吃：

| 字段 | 含义 |
| --- | --- |
| `frameRate` | 特效帧率上限（`15` / `30` / `60` / `120` / `0` 不限，默认 `30`）：两个窗口的绘制循环按它限帧，采集内核的推帧间隔也由它换算（`capture::frame_interval_ms`） |
| `monitorTarget` | 持续监听的目标进程名（小写）；空串 = 没有目标。**它不跟普通设置一起走 `save_settings`** —— 改它有副作用（起流 / 停流），只能走 `set_monitor_target`，`get_settings` / `save_settings` 都以状态机里的值为准 |

### 监听缓存：关掉再开还接着听

每次成功起流（主界面、悬浮球、托盘、自动跟随、自动恢复，哪条路都一样）都会把那个进程名
记进 `monitorTarget`。于是：

1. 启动时若 `monitorTarget` 非空，后台扫描线程会去找它：在跑就直接开始采集；
2. 不在跑就一直等（`MonitorTick.waiting` 为 `true`，主界面显示「等待 xxx 启动…」，托盘提示
   也跟着变），进程一出现立刻起流；
3. 用户点「停止采集」只是解除自动起流（`monitor_armed = false`），目标仍记着 —— 不会刚停下
   又被拉起来；下次启动还是会接着听；
4. 想换目标：设置 →「通用 → 持续监听」里填进程名，或用「用当前选中的窗口」；清除则填空。

起流失败（比如目标被独占）会退避约 10 秒再试，不会每 1.2 秒重拉一次。

旧版本写下的 `settings.json` 缺这几个字段时会落回默认值（`solid` / `ring` / `adaptive`），
读进来之前还会做一次收敛：像「柱阵」这种只认频谱的样式，不会被留下 `wave` 这种画不出来的组合。

### 系统托盘图标

| 操作 | 行为 |
| --- | --- |
| **左键单击**图标 | 显示 / 隐藏主界面（最小化状态也会先还原） |
| **右键单击**图标 | 弹出功能菜单 |

菜单项与悬浮球的功能一致，并且**文字与勾选会跟着真实状态走**（由后台扫描线程每 1.2 秒刷新一次）：

| 菜单项 | 说明 |
| --- | --- |
| 显示主界面 / 隐藏主界面 | 文字随主界面可见性变化 |
| 开始采集 / 停止采集 | 文字随采集状态变化；策略与悬浮球一致 |
| 自动跟随出声窗口 | 复选项，与悬浮球上的开关是同一份状态 |
| 显示悬浮球 | 复选项 |
| 退出 | 真正结束进程 |

托盘的悬浮提示也会实时显示当前监听目标，例如 `进程音频监听 · 正在采集 cloudmusic.exe（PID 32440）`。

> 主界面点 × **不会退出程序**，只是收进托盘 —— 采集与悬浮球继续在后台运行。
> 要彻底退出请用托盘菜单里的「退出」。
>
> 藏起来的那一个窗口会**停掉自己的特效渲染**（主界面停了波形 / 频谱的绘制循环，悬浮球停了
> 小球的绘制循环），露出来再接着跑。这件事按窗口各管各的：主界面收进托盘不会把悬浮球冻住，
> 反过来也一样 —— 后端用 `emit_to` 定向通知，而不是广播。

## 构建与运行

### 前置：采集内核

`src-tauri/binaries/ProcessAudioCapture.dll` 必须是**内核 v3 及以上**（提供目标枚举与 DSP）。
如果换成旧版 DLL，界面会在日志里提示"采集内核版本过旧"，目标枚举会直接报错。

### 安装依赖

```powershell
npm install
rustup toolchain install stable-x86_64-pc-windows-msvc   # 已装可跳过
```

### 开发 / 打包 / 测试

```powershell
npm run app:dev      # 开发模式（前端 HMR + Rust 热重启）
npm run app:build    # 打包 NSIS 安装包
npm run test:rust    # 跑宿主侧测试：内核 ABI、目标枚举、DSP、真实采集
```

#### 打包产物

```
src-tauri/target/release/process-audio-capture-ui.exe             主程序
src-tauri/target/release/binaries/ProcessAudioCapture.dll         随程序分发的采集内核
src-tauri/target/release/bundle/nsis/*.exe                        NSIS 安装包
```

把可执行文件连同同目录的 `binaries\ProcessAudioCapture.dll` 一起拷走即可免安装运行。

#### 关于 NSIS 工具链

首次 `tauri build` 时 Tauri 会去 GitHub 下载 `nsis-3.11.zip` 与 `nsis_tauri_utils.dll`。
如果网络下载超时，可手动放到 Tauri 的缓存目录：

```
%LOCALAPPDATA%\tauri\NSIS\
├── makensis.exe / Bin\ / Stubs\ / Include\                ← nsis-3.11.zip 解包内容（去掉 nsis-3.11\ 前缀）
└── Plugins\x86-unicode\additional\nsis_tauri_utils.dll    ← nsis_tauri_utils-v0.5.3\nsis_tauri_utils.dll
```

放好后重跑 `npm run app:build` 即可，不会再触发下载。

## 已知限制

来自采集内核上游：

- 需要 **Windows 10 2004（build 19041）及以上**；
- 只能捕获**经由 Windows 音频引擎正常渲染**的声音，受保护内容与独占模式流抓不到；
- 进程回环按 **PID 的进程树**生效，目标进程的子进程声音也会被一并捕获；
- 交给调用方的一律是 **32-bit IEEE float 交错 PCM**，且格式固定为 48 kHz / 立体声；
- 回调不得在内部再次调用 `pac_start_capture` / `pac_stop_capture`。

来自本程序：

- 媒体信息（曲名 / 歌手）依赖播放器实现了 SMTC；没实现的播放器会退回窗口标题或占位文案；
- 「有声无窗」的进程只能靠音频会话发现，因此**必须正在出声**才会出现在列表里。

---

## 附录 A：采集内核的 ABI

内核导出 15 个 C ABI 符号，分三组（完整定义见内核的
`include/process_audio_capture.h`）：

| 分组 | 符号 |
| --- | --- |
| 采集 | `pac_start_capture`、`pac_stop_capture`、`pac_capture_format`、`pac_is_capturing`、`pac_capture_error` |
| 目标枚举 | `pac_enum_targets`、`pac_target_count`、`pac_target_at`、`pac_target_list_sessions_error`、`pac_free_target_list` |
| DSP | `pac_analyzer_create`、`pac_analyzer_process`、`pac_analyzer_destroy` |
| 杂项 | `pac_version`（当前 `3`）、`pac_strerror` |

### 内核内部用什么实现这些能力

| 能力 | 内核里的实现 |
| --- | --- |
| 枚举窗口 | `EnumWindows` + `IsWindowVisible` + `GetWindowTextW` + `GetWindowThreadProcessId` + `QueryFullProcessImageNameW`（过滤拥有者窗口与工具窗口，接近 Alt-Tab 语义） |
| 音频会话 | WASAPI：`IMMDeviceEnumerator` → `IAudioSessionManager2` 遍历会话，读 `GetState` 与 `GetPeakValue` |
| 媒体信息 | SMTC：`GlobalSystemMediaTransportControlsSessionManager` 读曲名 / 歌手 / 专辑 / 播放状态，按 AUMID 与进程名匹配 |
| 合并与排序 | 三者按 PID 合并；同进程多窗口取标题最长的；「只有音频会话」的进程补一条；最后按峰值 → 活跃 → 名称排序 |
| DSP | 降混单声道 + 峰谷包络（256 组）+ Hann 窗 2048 点 FFT 聚合成 128 根对数频率柱 + RMS / 峰值 |

## 附录 B：两处上游缺陷与修复

两处问题都在内核的 `src/capture.rs`，已在源码侧修复。官方二进制保留在
`src-tauri/binaries/official-beta/`，可以直接复现崩溃。

### 缺陷 1：`PROPVARIANT` 析构释放栈地址 → 宿主进程堆损坏

`windows` crate 为 `PROPVARIANT` 实现了 `Drop`，内部调用 `PropVariantClear`；
对 `VT_BLOB` 而言它会用 `CoTaskMemFree` 释放 `blob.pBlobData`。
而激活参数里 `pBlobData` 指向的是**栈上的局部变量**：

```rust
let mut property = PROPVARIANT::default();
value.Anonymous.blob = BLOB {
    cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
    pBlobData: &mut parameters as *mut _ as *mut u8,   // ← 栈地址
};
// activate_with_event 返回时 property 析构 → CoTaskMemFree(栈地址) → 堆损坏
```

现象：**任何非零 PID** 调用 `pac_start_capture`，宿主进程都会在 `activate_with_event`
返回时以 `STATUS_HEAP_CORRUPTION (0xC0000374)` 直接崩溃，连 `PAC_E_ACTIVATION_FAILED`
都返回不了。Rust 宿主与 .NET 宿主均可复现。

修复：这份 blob 是调用方自有的栈内存，本来就没有东西需要释放，跳过析构即可。

```rust
let mut property = std::mem::ManuallyDrop::new(PROPVARIANT::default());
// ...
let property_ptr: *const PROPVARIANT = &*property;
```

### 缺陷 2：进程回环客户端不支持 `IAudioClient2` / `GetMixFormat`

`stream()` 沿用了"普通回环采集"的写法，但 `VAD\Process_Loopback` 激活出来的客户端：

- `QueryInterface(IAudioClient2)` → `E_NOINTERFACE (0x80004002)`
- `GetMixFormat()` → `E_NOTIMPL (0x80004001)`

于是采集永远停在 `Initialize` 之前。另外 `is_float_format(&format)` 是拿
**18 字节的 `WAVEFORMATEX` 栈拷贝**去按 `WAVEFORMATEXTENSIBLE` 读 `SubFormat`，
属于越界读，即使前面的问题解决了也会误判格式。

修复：去掉 `IAudioClient2` / `SetClientProperties` / `GetMixFormat`，
像微软 ApplicationLoopback 示例那样**自己构造捕获格式**，并把声道数、采样率显式传给采集循环。

```rust
fn capture_format() -> WAVEFORMATEXTENSIBLE {
    // 48 kHz / 立体声 / 32-bit float，KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    // ...
}
```

修复后的实测结果（内核的 `cargo test`）：

```
pac_start_capture -> 0（成功）
收到 59040 帧 · 48000 Hz · 2 声道 · 峰值 0.3427
pac_stop_capture -> 0
```
