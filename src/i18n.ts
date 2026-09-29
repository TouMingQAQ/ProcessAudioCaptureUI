/**
 * 界面文案的中英文对照。
 *
 * 用法：
 * * 静态文本在 HTML 上标 `data-i18n="key"`（属性类用 `data-i18n-title` /
 *   `data-i18n-placeholder`），启动时 [`applyI18n`] 扫一遍全部替换；
 * * 动态文本直接 `t("key")`，需要插值就写 `t("key", { n: 3 })`，模板里用 `{n}`。
 *
 * 新增文案一律两边都加，缺哪边就显示哪边的原文（键名），一眼能看出来漏了。
 */

import type { Bi } from "./theme";

export type Language = "zh-CN" | "en-US";

type Dict = Record<string, string>;

const ZH: Dict = {
  "app.title": "进程音频监听",
  "app.tagline": "挑一个正在出声的程序 · 实时可视化 · 悬浮球与托盘常驻",
  "app.brandMark": "♪",

  "ball.toggle.on": "悬浮球 开",
  "ball.toggle.off": "悬浮球 关",
  "ball.shown": "悬浮球已显示",
  "ball.hidden": "悬浮球已隐藏",
  "ball.toggleFailed": "切换悬浮球失败：{err}",

  "list.head": "♪ 可捕获音频的窗口",
  "list.search": "按窗口标题 / 进程名过滤…",
  "list.refresh": "刷新",
  "list.onlyAudio": "只看有音频会话的窗口",
  "list.enumerating": "正在枚举窗口…",
  "list.none": "没有找到可捕获的窗口",
  "list.noMatch": "没有匹配的窗口",
  "list.enumerateFailed": "枚举窗口失败",
  "list.count": "{shown} / {total}",
  "list.enumerated": "枚举到 {n} 个可见窗口",
  "list.enumerateFailedLog": "枚举窗口失败：{err}",
  "list.unknownProcess": "未知进程",
  "list.trayBadge": "托盘",
  "list.trayBadgeTitle": "该进程没有可见窗口，标题来自系统媒体信息（SMTC）",
  "list.stopFirst": "请先停止当前采集再切换窗口",

  "session.active": "正在播放",
  "session.inactive": "会话空闲",
  "session.expired": "会话已失效",
  "session.none": "无音频会话",
  "session.idle": "未采集",
  "session.live": "采集进行中",
  "session.failed": "采集失败",

  "view.head": "♫ 实时音频可视化",
  "view.pickTitle": "还没有选择窗口",
  "view.pickSub": "从左侧挑一个正在播放声音的窗口，然后点「开始采集」",
  "view.pickedSub": "PID {pid} · {state} · 会话峰值 {peak}%",
  "view.selected": "尚未选择窗口",
  "view.selectedSub": "从左侧列表选择一个正在播放声音的窗口，然后点击「开始采集」",
  "view.nowPlaying": "正在监听",
  "view.capture": "开始采集",
  "view.capturing": "激活中…",
  "view.stop": "停止采集",
  "view.stopping": "停止中…",
  "view.recordWav": "顺便录成 WAV（存到「下载」目录）",
  "view.autoFollow": "自动跟随最响的窗口",
  "view.waveHead": "波形（峰谷包络）",
  "view.specHead": "频谱（20 Hz → Nyquist，对数轴）",
  "view.metaWave": "{n} 点包络",
  "view.metaSpec": "{n} 柱",
  "view.rms": "RMS 平均",
  "view.peak": "峰值",

  "capture.started": "开始采集 {name} (PID {pid})，格式 {rate} Hz / {channels} 声道",
  "capture.recording": "录制中：{path}",
  "capture.startFailed": "启动采集失败：{err}",
  "capture.stopFailed": "停止采集失败：{err}",
  "capture.nothing": "没有正在进行的采集",
  "capture.stopped": "已停止：{name} · 共 {frames} 帧 / {seconds} 秒 · {rate} Hz {channels}ch",
  "capture.dropped": "因缓冲溢出丢弃了 {n} 个采样",
  "capture.wavSaved": "WAV 已保存：{path}",
  "capture.wavMissing": "未生成 WAV（可能未收到任何音频数据）",
  "capture.tickSub": "{who} · PID {pid} · {rate} Hz / {channels} 声道",
  "capture.minimized": "窗口已最小化，读不到标题",

  "follow.on": "自动跟随已开启：当前窗口安静下来、别的窗口开始出声时会自动切过去",
  "follow.off": "自动跟随已关闭",
  "follow.failed": "设置自动跟随失败：{err}",
  "follow.chip": "自动跟随：当前窗口安静下来、别的窗口开始出声时，会自动切过去",
  "follow.turnedOn": "自动跟随已开启",
  "follow.turnedOff": "自动跟随已关闭",

  "kernel.ready": "采集内核 v{version} 已就绪",
  "kernel.missing": "采集内核未就绪",
  "kernel.detecting": "检测采集内核…",
  "kernel.reloaded": "采集内核已就绪：{path}（版本 {version}）",
  "kernel.notLoaded": "DLL 未加载",
  "kernel.placeHint": "请把 ProcessAudioCapture.dll 放到：{dir}",
  "kernel.queryFailed": "查询 DLL 状态失败：{err}",

  "log.ready": "就绪。先让目标窗口播放声音，再从左侧选择它。",
  "log.switched": "{msg}",

  "settings.open": "设置",
  "settings.close": "关闭",
  "settings.tab.general": "通用",
  "settings.tab.theme": "主题",
  "settings.tab.ball": "悬浮球",
  "settings.tab.kernel": "内核",

  "settings.general.language": "语言",
  "settings.general.languageHint": "主界面、悬浮球与托盘菜单的语言。",
  "settings.general.autoFollow": "启动时自动跟随最响的窗口",
  "settings.general.autoFollowHint": "开启后，当前窗口安静下来、别的窗口开始出声时会自动切过去。",
  "settings.general.recordWav": "采集时默认录制 WAV",
  "settings.general.recordWavHint": "主界面上的「顺便录成 WAV」会跟着这个开关走，文件存在「下载」目录。",
  "settings.general.behaviour": "行为",
  "settings.general.trayNote": "主界面点 × 只会收进托盘，采集与悬浮球继续在后台跑；要彻底退出请用托盘菜单的「退出」。",
  "settings.general.saved": "设置已保存",

  "settings.theme.mode": "深色模式",
  "settings.theme.modeHint": "只决定应用主题用白天还是黑夜的那一份；悬浮球不跟着变，固定用浅色那份。",
  "settings.theme.mode.light": "浅色",
  "settings.theme.mode.dark": "深色",
  "settings.theme.mode.system": "跟随系统",
  "settings.theme.app": "应用主题",
  "settings.theme.appHint": "每张卡片左边是浅色、右边是深色，点一下立即生效。",
  "settings.ball.colors": "配色",
  "settings.ball.colorsHint": "小球与悬停面板的用色，自己排。样式按顺序往下取，颜色给少了就复用最后一个。",
  "settings.ball.colorAdd": "添加颜色",
  "settings.ball.presets": "快捷预设",
  "settings.ball.slotRemove": "删除这个颜色",
  "settings.ball.style": "律动样式",
  "settings.ball.styleHint": "分内外两层，各选一个叠在一起，各绑各的数据源。",
  "settings.ball.inner": "内圈",
  "settings.ball.outer": "外圈",
  "settings.ball.motion": "尺寸与律动",
  "settings.ball.motionHint": "调小球多大、数据放大多少倍，以及要不要跟着音乐「点头」。",
  "settings.ball.size": "悬浮球大小",
  "settings.ball.gain": "显示倍率",
  "settings.ball.pulse": "随音频律动缩放",
  "settings.ball.pulseHint": "不是直接按音量缩放：算法看鼓点与响度算出一个「点头」的幅度，再作用到小球大小上。",
  "settings.ball.pulseAmount": "缩放幅度",
  "settings.ball.algorithm": "缩放算法",
  "settings.theme.current": "当前",
  "settings.theme.previewLight": "浅色",
  "settings.theme.previewDark": "深色",
  "settings.theme.reset": "恢复默认",

  "settings.kernel.status": "状态",
  "settings.kernel.version": "内核版本",
  "settings.kernel.path": "当前加载",
  "settings.kernel.expected": "期望目录",
  "settings.kernel.candidates": "候选路径（按优先级）",
  "settings.kernel.reload": "重新加载内核",
  "settings.kernel.reloaded2": "已重新加载",
  "settings.kernel.none": "没有找到任何候选文件",
  "settings.kernel.hint":
    "采集内核（ProcessAudioCapture.dll）需要 v3 及以上；换成旧版会提示版本过旧，目标枚举会直接报错。",

  "ballWindow.kicker": "♫ 正在监听",
  "ballWindow.openMain": "打开主界面",
  "ballWindow.idleTitle": "还没有开始采集",
  "ballWindow.idleSub": "点下方按钮，小球会自动挑一个正在出声的窗口",
  "ballWindow.idleState": "待机中",
  "ballWindow.capturing": "采集中",
  "ballWindow.volume": "音量",
  "ballWindow.starting": "启动中…",
  "ballWindow.stopping": "停止中…",
  "ballWindow.candidateSwitch": "「{name}」也在出声，若当前窗口安静下来会自动切过去",
  "ballWindow.candidateStart": "「{name}」正在出声，可以开始采集",
  "ballWindow.stopped": "已停止：{name} · {frames} 帧 / {seconds}s{wav}",
  "ballWindow.stoppedWav": " · WAV：{path}",
  "ballWindow.started": "已开始采集 {name} · {rate} Hz / {channels} 声道",
  "ballWindow.follow": "自动跟随",
  "ballWindow.capture": "开始采集",
  "ballWindow.stop": "停止采集",
  "ballWindow.mediaPlaying": "正在播放",
  "ballWindow.mediaPaused": "已暂停",
  "ballWindow.mediaStopped": "已停止",
  "ballWindow.mediaSession": "媒体会话",

  /* 悬浮球的律动样式（名字与说明都由 ball-style.ts 的 id 拼出来） */
  "ballStyle.source.spectrum": "频谱",
  "ballStyle.source.wave": "波形",
  "ballStyle.source.adaptive": "自适应",
  "ballStyle.source.level": "响度",
  "ballStyle.source.peak": "峰值",
  "ballStyle.source.hint.spectrum": "跟频谱：128 柱对数频率，低音在左、高音在右。",
  "ballStyle.source.hint.wave": "跟波形：256 点峰谷包络，跟整体起伏与鼓点冲击力。",
  "ballStyle.source.hint.adaptive": "自适应：每帧比较频谱与波形谁更活跃，谁活跃就用谁。",
  "ballStyle.source.hint.level": "跟响度（RMS）：整帧一个数，各位置一起涨落，像一圈音量环。",
  "ballStyle.source.hint.peak": "跟峰值：整帧一个数，鼓点一到就顶上去，比响度更跳。",

  /* 内圈 */
  "ballStyle.core": "球芯",
  "ballStyle.hint.core": "一颗静态的渐变球，什么都不跟，安静地待在那里。",
  "ballStyle.pulse": "脉冲",
  "ballStyle.hint.pulse": "球芯之外再放几圈随音量涨落的同心圈。",
  "ballStyle.particles": "粒子",
  "ballStyle.hint.particles": "一圈细小光点被音乐推开，安静时轻轻呼吸。",
  "ballStyle.ripple": "涟漪",
  "ballStyle.hint.ripple": "声压一圈圈荡开，响度越大涟漪越密越亮。",
  "ballStyle.none": "无",
  "ballStyle.hint.none": "这一圈什么都不画 —— 只想要另一圈时用它。",

  /* 外圈 */
  "ballStyle.ring": "环柱",
  "ballStyle.hint.ring": "经典环形频谱：一圈柱子的长度就是各频段的能量。",
  "ballStyle.bars": "柱阵",
  "ballStyle.hint.bars": "球体正面一列均衡器柱，低音在左、高音在右。",
  "ballStyle.wave": "示波",
  "ballStyle.hint.wave": "把波形卷成一圈，直接描出峰谷包络的起伏。",
  "ballStyle.laser": "激光",
  "ballStyle.hint.laser": "两道细长的激光线扫过球体，鼓点越强转得越快。",

  /* 随音频律动缩放的算法（id 来自 ball-pulse.ts） */
  "ballPulse.none": "不缩放",
  "ballPulse.hint.none": "小球始终是原大小。",
  "ballPulse.nod": "点头",
  "ballPulse.hint.nod": "低频一冲击就往下压一下再弹回来，像听歌时跟着点头。",
  "ballPulse.breathe": "呼吸",
  "ballPulse.hint.breathe": "跟着整体响度慢慢起伏，没有冲击感。",
  "ballPulse.pulse": "脉冲",
  "ballPulse.hint.pulse": "峰值越线时放大一下；阻尼小，所以会弹两下才停。",
  "ballPulse.sway": "摆动",
  "ballPulse.hint.sway": "低频越强摆得越快、幅度越大，像跟着节拍轻轻晃。",
};

const EN: Dict = {
  "app.title": "Process Audio Monitor",
  "app.tagline": "Pick a program that is making sound · live visuals · orb and tray always on",
  "app.brandMark": "♪",

  "ball.toggle.on": "Orb on",
  "ball.toggle.off": "Orb off",
  "ball.shown": "Orb shown",
  "ball.hidden": "Orb hidden",
  "ball.toggleFailed": "Could not toggle the orb: {err}",

  "list.head": "♪ Capturable windows",
  "list.search": "Filter by window title / process…",
  "list.refresh": "Refresh",
  "list.onlyAudio": "Only windows with an audio session",
  "list.enumerating": "Enumerating windows…",
  "list.none": "No capturable window found",
  "list.noMatch": "No matching window",
  "list.enumerateFailed": "Window enumeration failed",
  "list.count": "{shown} / {total}",
  "list.enumerated": "Found {n} visible windows",
  "list.enumerateFailedLog": "Window enumeration failed: {err}",
  "list.unknownProcess": "Unknown process",
  "list.trayBadge": "Tray",
  "list.trayBadgeTitle": "This process has no visible window; the title comes from system media info (SMTC)",
  "list.stopFirst": "Stop the current capture before switching windows",

  "session.active": "Playing",
  "session.inactive": "Session idle",
  "session.expired": "Session expired",
  "session.none": "No audio session",
  "session.idle": "Idle",
  "session.live": "Capturing",
  "session.failed": "Capture failed",

  "view.head": "♫ Live audio visualisation",
  "view.pickTitle": "No window selected",
  "view.pickSub": "Pick a window that is playing sound on the left, then hit “Start capture”",
  "view.pickedSub": "PID {pid} · {state} · session peak {peak}%",
  "view.selected": "Nothing selected",
  "view.selectedSub": "Select a window that is playing sound, then click “Start capture”",
  "view.nowPlaying": "Now listening",
  "view.capture": "Start capture",
  "view.capturing": "Activating…",
  "view.stop": "Stop capture",
  "view.stopping": "Stopping…",
  "view.recordWav": "Also record a WAV (saved to Downloads)",
  "view.autoFollow": "Follow the loudest window",
  "view.waveHead": "Waveform (peak envelope)",
  "view.specHead": "Spectrum (20 Hz → Nyquist, log scale)",
  "view.metaWave": "{n}-point envelope",
  "view.metaSpec": "{n} bins",
  "view.rms": "RMS",
  "view.peak": "Peak",

  "capture.started": "Capturing {name} (PID {pid}), format {rate} Hz / {channels} ch",
  "capture.recording": "Recording to {path}",
  "capture.startFailed": "Could not start capture: {err}",
  "capture.stopFailed": "Could not stop capture: {err}",
  "capture.nothing": "No capture in progress",
  "capture.stopped": "Stopped: {name} · {frames} frames / {seconds}s · {rate} Hz {channels}ch",
  "capture.dropped": "Dropped {n} samples due to a buffer overflow",
  "capture.wavSaved": "WAV saved: {path}",
  "capture.wavMissing": "No WAV was written (maybe no audio arrived)",
  "capture.tickSub": "{who} · PID {pid} · {rate} Hz / {channels} ch",
  "capture.minimized": "Window is minimised, title unavailable",

  "follow.on": "Auto-follow is on: when the current window goes quiet and another starts playing, capture moves over",
  "follow.off": "Auto-follow is off",
  "follow.failed": "Could not set auto-follow: {err}",
  "follow.chip": "Auto-follow: switches over when the current window goes quiet and another starts playing",
  "follow.turnedOn": "Auto-follow on",
  "follow.turnedOff": "Auto-follow off",

  "kernel.ready": "Capture kernel v{version} ready",
  "kernel.missing": "Capture kernel unavailable",
  "kernel.detecting": "Looking for the capture kernel…",
  "kernel.reloaded": "Capture kernel ready: {path} (version {version})",
  "kernel.notLoaded": "DLL not loaded",
  "kernel.placeHint": "Put ProcessAudioCapture.dll into: {dir}",
  "kernel.queryFailed": "Could not query the DLL status: {err}",

  "log.ready": "Ready. Start playback in the target window, then pick it on the left.",
  "log.switched": "{msg}",

  "settings.open": "Settings",
  "settings.close": "Close",
  "settings.tab.general": "General",
  "settings.tab.theme": "Theme",
  "settings.tab.ball": "Orb",
  "settings.tab.kernel": "Kernel",

  "settings.general.language": "Language",
  "settings.general.languageHint": "Applies to the main window, the orb and the tray menu.",
  "settings.general.autoFollow": "Auto-follow the loudest window on startup",
  "settings.general.autoFollowHint":
    "When the current window goes quiet and another starts playing, capture moves over.",
  "settings.general.recordWav": "Record a WAV by default",
  "settings.general.recordWavHint":
    "The “Also record a WAV” switch in the main window follows this. Files go to Downloads.",
  "settings.general.behaviour": "Behaviour",
  "settings.general.trayNote":
    "Closing the main window only hides it to the tray — capture and the orb keep running. Use “Quit” in the tray menu to exit.",
  "settings.general.saved": "Settings saved",

  "settings.theme.mode": "Dark mode",
  "settings.theme.modeHint":
    "Chooses the light or dark variant for the app theme only — the orb is unaffected and always uses its light palette.",
  "settings.theme.mode.light": "Light",
  "settings.theme.mode.dark": "Dark",
  "settings.theme.mode.system": "System",
  "settings.theme.app": "App theme",
  "settings.theme.appHint": "Light preview on the left, dark on the right. Click to apply instantly.",
  "settings.ball.colors": "Colours",
  "settings.ball.colorsHint":
    "Your own shades for the ball and its hover panel. Styles take them in order and reuse the last one when you run out.",
  "settings.ball.colorAdd": "Add colour",
  "settings.ball.presets": "Quick presets",
  "settings.ball.slotRemove": "Remove this colour",
  "settings.ball.style": "Motion style",
  "settings.ball.styleHint":
    "Two layers — inner and outer. Pick one for each and they stack, with their own data sources.",
  "settings.ball.inner": "Inner",
  "settings.ball.outer": "Outer",
  "settings.ball.motion": "Size & motion",
  "settings.ball.motionHint":
    "How big the ball is, how much the data is amplified, and whether it nods along.",
  "settings.ball.size": "Ball size",
  "settings.ball.gain": "Display gain",
  "settings.ball.pulse": "Scale with the music",
  "settings.ball.pulseHint":
    "Not a plain volume follower: the algorithm reads beats and loudness to work out a “nod”, then applies it to the ball's size.",
  "settings.ball.pulseAmount": "Scaling amount",
  "settings.ball.algorithm": "Scaling algorithm",
  "settings.theme.current": "Current",
  "settings.theme.previewLight": "Light",
  "settings.theme.previewDark": "Dark",
  "settings.theme.reset": "Reset",

  "settings.kernel.status": "Status",
  "settings.kernel.version": "Kernel version",
  "settings.kernel.path": "Loaded from",
  "settings.kernel.expected": "Expected directory",
  "settings.kernel.candidates": "Candidate paths (by priority)",
  "settings.kernel.reload": "Reload kernel",
  "settings.kernel.reloaded2": "Reloaded",
  "settings.kernel.none": "No candidate file found",
  "settings.kernel.hint":
    "The capture kernel (ProcessAudioCapture.dll) must be v3 or newer; older builds make target enumeration fail outright.",

  "ballWindow.kicker": "♫ Listening",
  "ballWindow.openMain": "Open the app",
  "ballWindow.idleTitle": "Not capturing yet",
  "ballWindow.idleSub": "Hit the button below — the orb picks a window that is making sound",
  "ballWindow.idleState": "Idle",
  "ballWindow.capturing": "Capturing",
  "ballWindow.volume": "Volume",
  "ballWindow.starting": "Starting…",
  "ballWindow.stopping": "Stopping…",
  "ballWindow.candidateSwitch": "“{name}” is playing too — capture will move over once this one goes quiet",
  "ballWindow.candidateStart": "“{name}” is playing — you can start capturing",
  "ballWindow.stopped": "Stopped: {name} · {frames} frames / {seconds}s{wav}",
  "ballWindow.stoppedWav": " · WAV: {path}",
  "ballWindow.started": "Capturing {name} · {rate} Hz / {channels} ch",
  "ballWindow.follow": "Auto-follow",
  "ballWindow.capture": "Start capture",
  "ballWindow.stop": "Stop capture",
  "ballWindow.mediaPlaying": "Playing",
  "ballWindow.mediaPaused": "Paused",
  "ballWindow.mediaStopped": "Stopped",
  "ballWindow.mediaSession": "Media session",

  /* The orb's motion styles (ids come from ball-style.ts) */
  "ballStyle.source.spectrum": "Spectrum",
  "ballStyle.source.wave": "Waveform",
  "ballStyle.source.adaptive": "Adaptive",
  "ballStyle.source.level": "Loudness",
  "ballStyle.source.peak": "Peak",
  "ballStyle.source.hint.spectrum":
    "Spectrum: 128 log-spaced bins, bass on the left, treble on the right.",
  "ballStyle.source.hint.wave":
    "Waveform: a 256-point peak envelope, following overall movement and transients.",
  "ballStyle.source.hint.adaptive":
    "Adaptive: each frame compares spectrum and waveform and follows whichever is livelier.",
  "ballStyle.source.hint.level":
    "Loudness (RMS): one number per frame, so every position moves together — a volume ring.",
  "ballStyle.source.hint.peak":
    "Peak: one number per frame, jumping up on every beat — twitchier than loudness.",

  /* Inner layer */
  "ballStyle.core": "Core",
  "ballStyle.hint.core": "A plain gradient ball that follows nothing — just sits there.",
  "ballStyle.pulse": "Pulse",
  "ballStyle.hint.pulse": "The core plus a couple of rings that swell with the volume.",
  "ballStyle.particles": "Particles",
  "ballStyle.hint.particles": "A ring of specks pushed outward by the music, breathing when idle.",
  "ballStyle.ripple": "Ripple",
  "ballStyle.hint.ripple": "Pressure ripples outward; louder means denser and brighter.",
  "ballStyle.none": "None",
  "ballStyle.hint.none": "Draws nothing on this layer — pick it when you only want the other one.",

  /* Outer layer */
  "ballStyle.ring": "Ring bars",
  "ballStyle.hint.ring": "The classic: a ring of bars whose length is each band's energy.",
  "ballStyle.bars": "Bar stack",
  "ballStyle.hint.bars": "A flat equaliser across the ball: bass on the left, treble on the right.",
  "ballStyle.wave": "Oscilloscope",
  "ballStyle.hint.wave": "Wraps the envelope into a ring and traces it point by point.",
  "ballStyle.laser": "Laser",
  "ballStyle.hint.laser": "Two thin beams sweep across the ball, spinning faster on strong beats.",

  /* Scaling algorithms (ids come from ball-pulse.ts) */
  "ballPulse.none": "Off",
  "ballPulse.hint.none": "The ball keeps its size.",
  "ballPulse.nod": "Nod",
  "ballPulse.hint.nod":
    "A low-end hit presses it down and it springs back — like nodding along to the beat.",
  "ballPulse.breathe": "Breathe",
  "ballPulse.hint.breathe": "Slowly swells with overall loudness, no punch.",
  "ballPulse.pulse": "Pulse",
  "ballPulse.hint.pulse":
    "Flashes bigger whenever the peak crosses the line; low damping, so it bounces twice.",
  "ballPulse.sway": "Sway",
  "ballPulse.hint.sway":
    "The stronger the low end, the faster and wider it sways — a gentle rock on the beat.",
};

const DICTS: Record<Language, Dict> = { "zh-CN": ZH, "en-US": EN };

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en-US", label: "English" },
];

let current: Language = "zh-CN";

export function setLanguage(language: Language) {
  current = language in DICTS ? language : "zh-CN";
  document.documentElement.lang = current;
}

export function getLanguage(): Language {
  return current;
}

/** 取文案；`vars` 用来替换模板里的 `{name}`。 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const text = DICTS[current][key] ?? DICTS["zh-CN"][key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** 双语名称按当前语言挑一份。 */
export function bi(name: Bi): string {
  return current === "en-US" ? name.en : name.zh;
}

/**
 * 把 `data-i18n*` 属性上的文案刷一遍。
 * 主题网格、日志这类动态内容自己调 [`t`]，不走这里。
 */
export function applyI18n(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n ?? "");
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle ?? "");
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder ?? ""));
  });
}
