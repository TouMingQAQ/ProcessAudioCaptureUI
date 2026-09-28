# ProcessAudioCapture 测试台

基于 **Tauri 2 + Rust + TypeScript** 的桌面应用，用来验证
[`TouMingQAQ/ProcessAudioCapture`](https://github.com/TouMingQAQ/ProcessAudioCapture)
提供的 `ProcessAudioCapture.dll`。

实现的功能：

1. **主动选择可捕获音频的窗口** —— 枚举当前所有可见顶层窗口，并标注它是否正在经由系统音频引擎播放声音；
2. **捕获音频并实时可视化** —— 波形（峰谷包络）、对数频谱、RMS / 峰值电平表；
3. 附加：可把捕获到的音频同时录制为 16-bit PCM WAV，便于验证采集链路。

> ⚠️ **重要**：官方 `v0.0.1_beta` 的 DLL 存在两处会直接导致宿主进程崩溃 / 采集失败的缺陷（详见下文）。
> 本仓库 `src-tauri/binaries/ProcessAudioCapture.dll` 是**修复后重新编译**的产物，
> 原始官方二进制保留在 `src-tauri/binaries/official-beta/` 以便对比。

---

## 一、发现的 DLL 缺陷与修复

两处问题都在 `src/capture.rs`，已在源码侧修复并实测通过（`G:\Project\Rust\ProcessAudioCapture`）。

### 缺陷 1：`PROPVARIANT` 析构释放栈地址 → 宿主进程堆损坏崩溃

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

现象：**任何非零 PID** 调用 `pac_start_capture`，宿主进程都会在
`activate_with_event` 返回时以 `STATUS_HEAP_CORRUPTION (0xC0000374)` 直接崩溃，
连 `PAC_E_ACTIVATION_FAILED` 都返回不了。Rust 宿主与 .NET 宿主均可复现。

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

修复后的实测结果（`cargo test`，目标是一个正在播放声音的进程）：

```
pac_start_capture -> 0（成功）
收到 59040 帧 · 48000 Hz · 2 声道 · 峰值 0.3427
pac_stop_capture -> 0
```

---

## 二、DLL 的接口现状

`ProcessAudioCapture.dll` 只导出 **4 个 C ABI 符号**，全部只与「按 PID 采集」有关：

| 导出符号 | 说明 |
| --- | --- |
| `pac_start_capture(pid, callback, user_data, &handle)` | 激活进程回环并启动采集线程。**阻塞**直到激活成功或 **10 秒超时** |
| `pac_stop_capture(handle)` | 停止并等待采集线程退出。**句柄被消费，只能停一次** |
| `pac_version()` | 返回 `PAC_VERSION`（当前为 `2`） |
| `pac_strerror(code)` | 错误码转静态描述字符串 |

回调：`void cb(const float *samples, uint32_t frames, uint16_t channels, uint32_t sample_rate, void *user_data)`

### 缺少的接口（本项目在宿主侧补齐）

| 需求 | DLL | 本项目的实现 |
| --- | --- | --- |
| 枚举有哪些窗口 / 进程 | ❌ 无 | `EnumWindows` + `GetWindowThreadProcessId` + `GetWindowTextW` + `QueryFullProcessImageNameW` |
| 判断进程当前是否在出声 | ❌ 无 | WASAPI：`IAudioSessionManager2::GetSessionEnumerator` 遍历音频会话，读 `IAudioSessionControl2::GetState` 与 `IAudioMeterInformation::GetPeakValue` |
| 音频格式探测 | ⚠️ 只能在首帧回调里得知 | 起采集后轮询首帧回调，把真实 `sample_rate` / `channels` 回报给界面 |
| 降混 / 包络 / 频谱 | ❌ 无（原样输出交错 32-bit float） | Rust 侧降混单声道 + 峰谷包络 + Hann 窗 2048 点 FFT |
| 停止 / 异常结束的通知 | ❌ 无 | 会话管理器在 `stop` 时通过 Tauri 事件广播汇总信息 |

> 一句话：**"按窗口选进程"必须由宿主程序做**，因为 DLL 的 ABI 里只有 `pid`。
> 若上游后续加入 `pac_enum_audio_sessions()` 之类的接口，`src-tauri/src/sessions.rs` 可以直接换成薄封装。

---

## 三、目录结构

```
ProcessAudioCaptrueUI/
├── index.html                  # 界面骨架
├── scripts/
│   ├── with-msvc.mjs           # 注入 MSVC 环境后执行命令（本机必需，见第五节）
│   └── test-audio.ps1          # 循环播放系统 wav，用于验证采集链路
├── src/
│   ├── main.ts                 # UI 逻辑（窗口列表 / 采集控制 / 事件订阅）
│   ├── api.ts                  # 与 Rust 命令、事件的类型化封装
│   ├── visualizer.ts           # Canvas 波形 + 频谱 + 电平表渲染
│   └── styles.css              # 深色主题样式
└── src-tauri/
    ├── binaries/
    │   ├── ProcessAudioCapture.dll          # 修复后重新编译的 DLL
    │   └── official-beta/ProcessAudioCapture.dll  # 官方 v0.0.1_beta 原版（有缺陷）
    ├── src/
    │   ├── pac.rs              # DLL 动态加载（libloading）与符号绑定
    │   ├── sessions.rs         # 窗口枚举 + WASAPI 音频会话探测
    │   ├── capture.rs          # 采集会话、缓冲队列、发射线程
    │   ├── dsp.rs              # 包络 / FFT / 电平
    │   ├── wav.rs              # 16-bit PCM WAV 写入
    │   └── lib.rs              # Tauri 命令与状态
    └── tauri.conf.json
```

---

## 四、Tauri 命令

| 命令 | 作用 |
| --- | --- |
| `dll_status()` | DLL 是否加载成功、版本号、已找到的候选路径、推荐放置目录 |
| `reload_dll()` | 手动重试加载 DLL |
| `list_audio_windows()` | 返回 `{ windows, warnings }`，含 PID / 标题 / 进程名 / 会话状态 / 会话峰值 |
| `start_capture(pid, processName, recordWav)` | 启动采集，返回真实采样率与声道数 |
| `stop_capture()` | 停止采集，返回帧数 / 时长 / WAV 路径 / 丢帧统计 |

事件：

| 事件名 | 负载 |
| --- | --- |
| `pac://audio-frame` | `{ pid, totalFrames, elapsedMs, waveform[512], spectrum[128], rms, peak, windowMs }` |
| `pac://stopped` | `StopReport` |
| `pac://error` | `string` |

`waveform` 是 256 组 `(min, max)` 对，`spectrum` 是 20 Hz → Nyquist 的 128 个对数频率柱。

---

## 五、构建与运行

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
npm run test:rust    # 跑 Rust 侧的 DLL 冒烟测试（会真实加载 DLL）
```

#### 打包产物

```
src-tauri/target/release/process-audio-capture-ui.exe            6.63 MB  主程序
src-tauri/target/release/bundle/nsis/
    └── ProcessAudioCaptureUI_0.1.0_x64-setup.exe                1.73 MB  NSIS 安装包
src-tauri/target/release/binaries/ProcessAudioCapture.dll        149 KB   随程序分发的 DLL
```

把 `process-audio-capture-ui.exe` 连同同目录的 `binaries\ProcessAudioCapture.dll` 一起拷走即可免安装运行。

#### 关于 NSIS 工具链

首次 `tauri build` 时 Tauri 会去 GitHub 下载 `nsis-3.11.zip` 与 `nsis_tauri_utils.dll`。
如果网络下载超时（本机首次就遇到了 `timeout: global`），可手动放到 Tauri 的缓存目录：

```
%LOCALAPPDATA%\tauri\NSIS\
├── makensis.exe / Bin\ / Stubs\ / Include\                ← nsis-3.11.zip 解包内容（去掉 nsis-3.11\ 前缀）
└── Plugins\x86-unicode\additional\nsis_tauri_utils.dll    ← nsis_tauri_utils-v0.5.3\nsis_tauri_utils.dll
```

放好后重跑 `npm run app:build` 即可，不会再触发下载。

### 验证采集链路

```powershell
# 另开一个终端，循环播放系统自带的 wav，让某个进程持续出声
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-audio.ps1 -Seconds 60

# 想用命令行验证采集，可以指定目标 PID：
$env:PAC_TEST_PID = '<上面输出的 pid>'
npm run test:rust
```

---

## 六、使用步骤

1. 启动应用，顶栏徽标显示 `DLL v2 已加载` 表示绑定成功；
2. 让目标程序（浏览器 / 播放器 / 游戏）**播放声音**；
3. 左侧列表会标出 `正在播放` 的窗口（5 秒自动刷新，也可手动刷新）；
4. 选中窗口 → 勾选是否需要录 WAV → 点「开始采集」；
5. 右侧实时显示波形与频谱；再点一次按钮停止，日志区给出帧数与文件路径。

---

## 七、已知限制（来自 DLL 上游）

- 需要 **Windows 10 2004（build 19041）及以上**；
- 只能捕获**经由 Windows 音频引擎正常渲染**的声音，受保护内容与独占模式流抓不到；
- 进程回环按 **PID 的进程树**生效，目标进程的子进程声音也会被一并捕获；
- 交给调用方的一律是 **32-bit IEEE float 交错 PCM**，且当前实现把格式固定为 48 kHz / 立体声；
- 回调不得在内部再次调用 `pac_start_capture` / `pac_stop_capture`。
