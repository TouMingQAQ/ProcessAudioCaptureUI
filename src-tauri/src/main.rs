// Windows 发布版不额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    process_audio_capture_ui_lib::run()
}
