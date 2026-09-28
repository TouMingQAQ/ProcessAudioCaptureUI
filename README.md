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
| **悬浮球** | 收起时是一枚环形频谱小球，悬停展开操作面板：当前曲目、音量表、开始/停止、自动跟随。可拖到任意位置 |
| **系统托盘** | 左键显示 / 隐藏主界面；右键菜单复用悬浮球的功能 |
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
| `capture.rs` | 一次采集会话：回调缓冲队列、发射线程（每 20 ms 出帧）、WAV 落盘 |
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
│   ├── orb.ts                  # 悬浮球画布渲染（环形频谱 + 呼吸光晕）
│   ├── visualizer.ts           # 主界面 Canvas 波形 + 频谱 + 电平表渲染
│   ├── api.ts                  # 与 Rust 命令、事件的类型化封装
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
| `set_ball_visible(visible)` / `set_ball_expanded(expanded)` | 悬浮球显示隐藏 / 展开收起 |
| `show_main_window()` | 唤起主窗口 |

| 事件名 | 负载 |
| --- | --- |
| `pac://audio-frame` | `{ pid, totalFrames, elapsedMs, waveform[512], spectrum[128], rms, peak, windowMs }` |
| `pac://stopped` | `StopReport` |
| `pac://error` | `string` |
| `pac://monitor` | `MonitorTick`：每 1.2 s 广播一次采集源信息（标题 / 状态 / 峰值 / 媒体信息）与候选源 |
| `pac://capture-changed` | `CaptureChanged`：自动跟随切换、托盘快捷操作、异常中断的结果提示 |

`waveform` 是 256 组 `(min, max)` 对，`spectrum` 是 20 Hz → Nyquist 的 128 个对数频率柱，两者都由内核算出。

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

## 构建与运行

### 前置：采集内核

`src-tauri/binaries/ProcessAudioCapture.dll` 必须是**内核 v3 及以上**（提供目标枚举与 DSP）。
如果换成旧版 DLL，界面会在日志里提示"采集内核版本过旧"，目标枚举会直接报错。

内核源码在本机 `G:\Project\Rust\ProcessAudioCapture`，重新编译后覆盖上面那个文件即可：

```powershell
cd G:\Project\Rust\ProcessAudioCapture
node G:\Project\Rust\ProcessAudioCaptrueUI\scripts\with-msvc.mjs cargo build --release
Copy-Item target\release\ProcessAudioCapture.dll `
          G:\Project\Rust\ProcessAudioCaptrueUI\src-tauri\binaries\ -Force
```

### 本机特殊情况（必读）

本机的 Visual Studio Build Tools 装在 **`D:\VSBuildTools`**，而且没有注册到 rustc 能自动发现的
位置，所以直接 `cargo build` 会报 `linker link.exe not found`。

`scripts/with-msvc.mjs` 会从 VS 安装器的实例清单里读出 `vcvars64.bat`、导入它的环境变量，
再执行目标命令。`npm run app:dev` / `app:build` / `test:rust` 都已经接好了它。

> 如果你的机器上 MSVC 能被 rustc 自动找到，可以直接 `npx tauri dev`，不会受影响。

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
