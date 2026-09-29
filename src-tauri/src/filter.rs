//! 窗口名单：白名单 / 黑名单。
//!
//! 「这个窗口能不能被采集」有两个入口 —— 左侧窗口列表，以及自动跟随（托盘菜单与悬浮球的
//! 「开始采集」走的都是同一套挑选逻辑 `monitor::pick_candidate`）。判定收在这一处，两边
//! 读同一份规则，免得列表里看不见的窗口却被自动跟随切了过去。
//!
//! 名单里存的是**进程名**（`chrome.exe`），不是完整路径：用户能看到的、好输入的、以及
//! 程序升级换目录后依然稳定的是它，而且一个程序的所有窗口本来就该一起管。统一按小写比较，
//! 用户填 `Chrome.EXE` 也能命中。

use std::sync::OnceLock;

use crate::prefs::Settings;
use crate::sessions::AudioWindowInfo;

/// 本应用自己的进程名（小写，带扩展名）。
///
/// 它在判定里**永远算黑名单成员**：采自己会形成回授，而用户也没有理由这么做，所以不做成
/// 可配置项 —— 界面把它显示成一条锁住的条目，删不掉。
pub fn self_process_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.file_name().map(|name| name.to_string_lossy().to_lowercase()))
            .unwrap_or_else(|| "process-audio-capture-ui.exe".to_string())
    })
}

/// 进程名是否允许出现在"可采集窗口"里。
///
/// * 黑名单命中（含本应用自己）→ 不允许，白名单也救不回来；
/// * 白名单为空 → 不限制，其余全部允许；
/// * 白名单非空 → 只有名单里的允许。
///
/// 读不到进程名（空串）的一律挡掉：不知道是什么的东西，宁可先不采。
pub fn is_allowed(process_name: &str, allow: &[String], block: &[String]) -> bool {
    let name = process_name.trim().to_lowercase();
    if name.is_empty() {
        return false;
    }
    if name == self_process_name() || block.iter().any(|entry| entry.eq_ignore_ascii_case(&name)) {
        return false;
    }
    allow.is_empty() || allow.iter().any(|entry| entry.eq_ignore_ascii_case(&name))
}

/// 从一份窗口列表里挑出允许采集的那些。
pub fn allowed_windows(
    windows: &[AudioWindowInfo],
    allow: &[String],
    block: &[String],
) -> Vec<AudioWindowInfo> {
    windows
        .iter()
        .filter(|window| is_allowed(&window.process_name, allow, block))
        .cloned()
        .collect()
}

/// 名单规范化：去空白、统一小写、去重，然后保证本应用自己永远在黑名单里。
///
/// 落盘前跑一遍，界面从后端拿到的就一定是干净且带锁定项的那份，前端不必再查一次自己在
/// 不在名单里。
pub fn normalize(settings: &mut Settings) {
    settings.window_allowlist = tidy(&settings.window_allowlist);
    settings.window_blocklist = tidy(&settings.window_blocklist);
    ensure_self_blocked(settings);
}

/// 把自己的进程名补进黑名单（已经有了就原样返回）。
pub fn ensure_self_blocked(settings: &mut Settings) {
    let me = self_process_name();
    if !settings
        .window_blocklist
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(me))
    {
        settings.window_blocklist.insert(0, me.to_string());
    }
}

fn tidy(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in list {
        let name = entry.trim().to_lowercase();
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn empty_lists_allow_everything_but_self() {
        assert!(is_allowed("chrome.exe", &[], &[]));
        // 自己是硬规则：名单里没写也不许采
        assert!(!is_allowed(self_process_name(), &[], &[]));
    }

    #[test]
    fn blocklist_wins_over_allowlist() {
        let allow = list(&["chrome.exe"]);
        let block = list(&["chrome.exe"]);
        assert!(!is_allowed("chrome.exe", &allow, &block));
    }

    #[test]
    fn allowlist_restricts_once_it_is_filled() {
        let allow = list(&["chrome.exe"]);
        assert!(is_allowed("chrome.exe", &allow, &[]));
        assert!(!is_allowed("msedge.exe", &allow, &[]));
    }

    #[test]
    fn matching_ignores_case_and_padding() {
        assert!(!is_allowed("Chrome.EXE", &[], &list(&["chrome.exe"])));
        assert!(is_allowed("  chrome.exe  ", &list(&["CHROME.EXE"]), &[]));
    }

    #[test]
    fn unknown_process_name_is_rejected() {
        assert!(!is_allowed("   ", &[], &[]));
    }

    #[test]
    fn normalizing_tidies_lists_and_pins_self_to_the_blocklist() {
        let mut settings = Settings {
            window_allowlist: list(&[" Chrome.exe ", "chrome.exe", "", "  "]),
            window_blocklist: list(&["MSEDGE.EXE", "msedge.exe"]),
            ..Settings::default()
        };
        normalize(&mut settings);

        assert_eq!(settings.window_allowlist, vec!["chrome.exe"]);
        assert_eq!(
            settings.window_blocklist.first().map(String::as_str),
            Some(self_process_name())
        );
        assert!(settings.window_blocklist.iter().any(|name| name == "msedge.exe"));

        // 再来一次不该重复插入
        normalize(&mut settings);
        assert_eq!(
            settings
                .window_blocklist
                .iter()
                .filter(|name| name.as_str() == self_process_name())
                .count(),
            1
        );
    }
}
