//! `ProcessAudioCapture.dll` 的动态绑定层。
//!
//! 该 DLL 只公开 4 个 C ABI 符号：
//!
//! ```c
//! int32_t pac_start_capture(uint32_t pid, pac_audio_callback cb, void *user, pac_capture_handle **out);
//! int32_t pac_stop_capture(pac_capture_handle *handle);
//! uint32_t pac_version(void);
//! const char *pac_strerror(int32_t code);
//! ```
//!
//! 注意点（来自官方头文件）：
//! * `pac_start_capture` 会**阻塞**直到流激活成功或 10 秒超时；
//! * 回调运行在采集线程上，`samples` 仅在本次调用期间有效，必须立刻拷贝；
//! * 回调内**不得**再调用 start/stop；
//! * 一个 handle 只能 `stop` 一次，stop 之后句柄被消费。

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::{Path, PathBuf};

use libloading::Library;

/// 不透明句柄，与 C 头文件中的 `pac_capture_handle` 对应。
#[repr(C)]
pub struct PacCaptureHandle {
    _private: [u8; 0],
}

/// 采集回调类型。`samples` 为 `frames * channels` 个交错 32-bit float 采样。
pub type PacAudioCallback = unsafe extern "C" fn(
    samples: *const f32,
    frames: u32,
    channels: u16,
    sample_rate: u32,
    user_data: *mut c_void,
);

pub const PAC_OK: i32 = 0;

type StartFn = unsafe extern "C" fn(
    pid: u32,
    callback: PacAudioCallback,
    user_data: *mut c_void,
    out_handle: *mut *mut PacCaptureHandle,
) -> i32;
type StopFn = unsafe extern "C" fn(handle: *mut PacCaptureHandle) -> i32;
type VersionFn = unsafe extern "C" fn() -> u32;
type StrErrorFn = unsafe extern "C" fn(code: i32) -> *const c_char;

/// 已加载的 DLL 及其导出符号。
pub struct PacLibrary {
    /// `Library` 必须在整个使用期间存活，否则符号指针悬空。
    _lib: Library,
    start: StartFn,
    stop: StopFn,
    version: Option<VersionFn>,
    strerror: Option<StrErrorFn>,
    /// DLL 所在路径，便于 UI 展示。
    pub path: PathBuf,
}

impl PacLibrary {
    /// 从指定路径加载 DLL 并解析导出符号。
    pub fn load(path: &Path) -> Result<Self, String> {
        // SAFETY: 我们只从该动态库解析约定的 C ABI 符号，并在库存活期间使用这些指针。
        unsafe {
            let lib = Library::new(path)
                .map_err(|e| format!("加载动态库失败 `{}`：{e}", path.display()))?;

            let start = *lib
                .get::<StartFn>(b"pac_start_capture\0")
                .map_err(|e| format!("未找到导出符号 `pac_start_capture`：{e}"))?;
            let stop = *lib
                .get::<StopFn>(b"pac_stop_capture\0")
                .map_err(|e| format!("未找到导出符号 `pac_stop_capture`：{e}"))?;
            let version = lib.get::<VersionFn>(b"pac_version\0").ok().map(|s| *s);
            let strerror = lib.get::<StrErrorFn>(b"pac_strerror\0").ok().map(|s| *s);

            Ok(Self {
                _lib: lib,
                start,
                stop,
                version,
                strerror,
                path: path.to_path_buf(),
            })
        }
    }

    /// 调用 `pac_start_capture`。**该调用会阻塞最多 10 秒**，请放在阻塞线程池里执行。
    ///
    /// 返回 `(返回码, 句柄)`。
    pub unsafe fn start_capture(
        &self,
        pid: u32,
        callback: PacAudioCallback,
        user_data: *mut c_void,
    ) -> (i32, *mut PacCaptureHandle) {
        let mut handle: *mut PacCaptureHandle = std::ptr::null_mut();
        let code = (self.start)(pid, callback, user_data, &mut handle);
        (code, handle)
    }

    /// 调用 `pac_stop_capture`。句柄被消费，之后不可复用。
    pub unsafe fn stop_capture(&self, handle: *mut PacCaptureHandle) -> i32 {
        (self.stop)(handle)
    }

    /// `pac_version()`；若 DLL 未导出则返回 0。
    pub fn version(&self) -> u32 {
        self.version.map(|f| unsafe { f() }).unwrap_or(0)
    }

    /// `pac_strerror()`；若 DLL 未导出则回退到内置的中文描述。
    pub fn strerror(&self, code: i32) -> String {
        if let Some(f) = self.strerror {
            let ptr = unsafe { f(code) };
            if !ptr.is_null() {
                let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
                if !text.is_empty() {
                    return format!("{text} ({code})");
                }
            }
        }
        format!("{} ({code})", builtin_strerror(code))
    }

    /// 把返回码转换为可读文本（不依赖 DLL）。
    pub fn describe(&self, code: i32) -> String {
        if code == PAC_OK {
            return "成功".to_string();
        }
        self.strerror(code)
    }
}

/// `pac_strerror` 的等价内置实现，用于 DLL 缺失该符号时的兜底。
pub fn builtin_strerror(code: i32) -> &'static str {
    match code {
        0 => "PAC_OK：成功",
        -1 => "PAC_E_INVALID_ARGUMENT：参数无效（pid 为 0 / 回调为空 / 句柄为空）",
        -2 => "PAC_E_UNSUPPORTED_PLATFORM：系统不支持进程回环，需 Windows 10 2004 (build 19041) 及以上",
        -3 => "PAC_E_ACTIVATION_FAILED：激活失败，目标进程可能已退出、静音或受保护",
        -4 => "PAC_E_UNSUPPORTED_FORMAT：回环流不是 32-bit IEEE float PCM",
        -5 => "PAC_E_TIMEOUT：音频客户端未在 10 秒内完成激活",
        -6 => "PAC_E_INTERNAL：无法创建 Win32/COM 资源",
        _ => "未知返回码",
    }
}

/// DLL 可能的文件扩展名（官方 release 提供 `-x64` / `-x86` 后缀版本）。
const DLL_NAMES: [&str; 2] = ["ProcessAudioCapture.dll", "ProcessAudioCapture-x64.dll"];

/// 按优先级生成候选路径，覆盖 dev 与打包后的多种运行形态。
pub fn candidate_paths(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            dirs.push(dir.join("binaries"));
            dirs.push(dir.join("resources"));
            dirs.push(dir.join("resources").join("binaries"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.clone());
        dirs.push(cwd.join("binaries"));
        dirs.push(cwd.join("src-tauri").join("binaries"));
        dirs.push(cwd.join("src-tauri"));
    }

    if let Some(dir) = resource_dir {
        dirs.push(dir.to_path_buf());
        dirs.push(dir.join("binaries"));
    }

    // 开发期兜底：编译时记录的工程目录（`cargo run` / `tauri dev` 下一定存在）。
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));

    let mut out = Vec::new();
    for dir in dirs {
        for name in DLL_NAMES {
            let candidate = dir.join(name);
            if candidate.is_file() && !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// 便捷函数：把 Rust `&str` 转成 C 字符串（当前未使用，保留给后续扩展）。
#[allow(dead_code)]
pub fn to_cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    use super::*;

    /// 回调里累计的探针数据。
    #[derive(Default)]
    struct Probe {
        frames: AtomicU64,
        sample_rate: AtomicU32,
        channels: AtomicU32,
        peak_bits: AtomicU32,
    }

    unsafe extern "C" fn probe_callback(
        samples: *const f32,
        frames: u32,
        channels: u16,
        sample_rate: u32,
        user_data: *mut c_void,
    ) {
        if samples.is_null() || user_data.is_null() || frames == 0 || channels == 0 {
            return;
        }
        let probe = &*(user_data as *const Probe);
        probe.frames.fetch_add(frames as u64, Ordering::Relaxed);
        probe.sample_rate.store(sample_rate, Ordering::Relaxed);
        probe.channels.store(channels as u32, Ordering::Relaxed);

        let slice = std::slice::from_raw_parts(samples, frames as usize * channels as usize);
        let mut peak = f32::from_bits(probe.peak_bits.load(Ordering::Relaxed));
        for &value in slice {
            let abs = if value.is_finite() { value.abs() } else { 0.0 };
            if abs > peak {
                peak = abs;
            }
        }
        probe.peak_bits.store(peak.to_bits(), Ordering::Relaxed);
    }

    /// 优先挑一个确实在出声的进程，没有就退回本进程。
    ///
    /// 可以用环境变量 `PAC_TEST_PID=<pid>` 指定目标，方便手动排查。
    fn pick_target_pid() -> (u32, String) {
        if let Ok(raw) = std::env::var("PAC_TEST_PID") {
            if let Ok(pid) = raw.trim().parse::<u32>() {
                return (pid, format!("env PAC_TEST_PID={pid}"));
            }
        }
        let result = crate::sessions::list_audio_windows();
        if let Some(win) = result.windows.iter().find(|w| w.session_state == "active") {
            return (win.pid, win.process_name.clone());
        }
        (
            std::process::id(),
            format!("pid:{} (无活跃音频会话，使用本进程)", std::process::id()),
        )
    }

    #[test]
    fn finds_and_loads_bundled_dll() {
        let candidates = candidate_paths(None);
        println!("候选路径：{candidates:#?}");
        assert!(
            !candidates.is_empty(),
            "没找到 ProcessAudioCapture.dll，请确认 src-tauri/binaries/ 下有该文件"
        );

        let lib = PacLibrary::load(&candidates[0]).expect("加载 DLL 失败");
        println!("已加载：{}", lib.path.display());
        println!("pac_version() = {}", lib.version());
        assert!(lib.version() >= 1, "pac_version 返回值异常");

        for code in [0, -1, -2, -3, -4, -5, -6, 12345] {
            println!("describe({code}) = {}", lib.describe(code));
        }
    }

    /// 端到端冒烟测试：真的调一次 pac_start_capture / pac_stop_capture。
    #[test]
    fn captures_audio_through_the_dll() {
        let candidates = candidate_paths(None);
        assert!(!candidates.is_empty(), "没找到 DLL");
        let lib = PacLibrary::load(&candidates[0]).expect("加载 DLL 失败");

        let (pid, name) = pick_target_pid();
        println!("目标进程：{name} (pid={pid})");

        let probe = Probe::default();
        let probe_ptr = &probe as *const Probe as *mut c_void;

        // SAFETY: probe 在整个采集期间都活在栈上；回调只做原子累加，不会 panic。
        let (code, handle) = unsafe { lib.start_capture(pid, probe_callback, probe_ptr) };
        println!("pac_start_capture -> {code}（{}）", lib.describe(code));

        if code != PAC_OK || handle.is_null() {
            // -3 = 目标进程没有在渲染音频（例如本进程压根不播声音），属于可接受结果
            assert_eq!(code, -3, "非预期的返回码：{}", lib.describe(code));
            println!("跳过：目标进程当前没有渲染音频");
            return;
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        while probe.frames.load(Ordering::Relaxed) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        // 再多采 1.2 秒，让峰值和格式有代表性（目标进程需真的在出声）
        std::thread::sleep(Duration::from_millis(1200));

        let stop_code = unsafe { lib.stop_capture(handle) };
        let frames = probe.frames.load(Ordering::Relaxed);
        let peak = f32::from_bits(probe.peak_bits.load(Ordering::Relaxed));

        println!(
            "收到 {frames} 帧 · {} Hz · {} 声道 · 峰值 {peak:.4}",
            probe.sample_rate.load(Ordering::Relaxed),
            probe.channels.load(Ordering::Relaxed),
        );
        println!("pac_stop_capture -> {stop_code}");

        assert_eq!(stop_code, PAC_OK, "stop 返回异常");
        assert!(frames > 0, "激活成功但一个采样都没收到");
        assert!(peak <= 1.0, "峰值超出 [-1, 1]：{peak}");
    }
}
