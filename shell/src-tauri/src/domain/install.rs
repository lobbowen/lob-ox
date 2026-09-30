//! 安装与下载进度的唯一语义层（事件形态见 ENV-TOOLCHAIN-INSTALL-STANDARD）。
//! 本模块只承认两种进度：可测分母（下载字节比）与如实的阶段/心跳文字。无分母时 `progress` 发 `null`，不猜。
//! 起因：`install_progress` 曾有两个发射点、`kind` 只枚举 node/npm 而内核与桌面壳用裸字符串过线，
//! 「哪些东西可被安装」在 Rust 与前端各有一份账；且没有真进度源 —— 阶段分数按代码顺序编出来，与真实进度无关。

use tauri::{Emitter, Manager};

/// 可被安装/下载的东西 —— 统一事件 `kind` 字面量的唯一来源（四类，冻结）。
/// 用枚举而非裸字符串：失败必须如实归给出问题的步骤（node 装不上 / npm 补不上），
/// 否则前端拿错文案前缀，把「缺 npm」显示成「装 Node 失败」。内核与桌面壳也不再各写一份字面量。
#[derive(Clone, Copy)]
pub(crate) enum InstallKind {
    Node,
    Npm,
    Kernel,
    Shell,
}

impl InstallKind {
  /// 事件 payload 里的 kind 字面量（与前端 `10-ui.js` 的 `INSTALL_TARGET` 键一一对应）。
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            InstallKind::Node => "node",
            InstallKind::Npm => "npm",
            InstallKind::Kernel => "kernel",
            InstallKind::Shell => "shell",
        }
    }

  /// 下载对象的名称（下载文案用；只有真的按字节下载的两类会读到）。
    fn dl_label(self) -> &'static str {
        match self {
            InstallKind::Node => "Node 官方归档",
            InstallKind::Shell => "桌面版本安装包",
            InstallKind::Kernel => "内核包",
            InstallKind::Npm => "npm 工具链",
        }
    }
}

/// 安装失败：携带**归属步骤**，供 IPC 边界发 `install_error { kind, error }`。
/// 只用裸 String 会让调用方丢失「失败在 node 还是 npm」这一事实。
pub(crate) struct InstallFailure {
    pub(crate) kind: InstallKind,
    pub(crate) message: String,
}

impl InstallFailure {
    fn node(message: impl Into<String>) -> Self {
        InstallFailure { kind: InstallKind::Node, message: message.into() }
    }

    fn npm(message: impl Into<String>) -> Self {
        InstallFailure { kind: InstallKind::Npm, message: message.into() }
    }
}

/// **唯一**的事件出口：三条安装事件（progress / done / error）的 payload 形态只能在这里成形。
fn emit_json(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}

/// 阶段行（无可测分母 -> `progress` 为 `null`）。
pub(crate) fn stage(app: &tauri::AppHandle, kind: InstallKind, status: &str) {
    push(app, kind, status.to_string(), None);
}

/// 带可测分母的下载行：文案与比值都由同一处从 `(done, total)` 算出 ——
/// 分两处写就会出现「文字说 12MB、比值说 30%」这类自相矛盾。
pub(crate) fn download(app: &tauri::AppHandle, kind: InstallKind, done: u64, total: Option<u64>) {
    let (text, ratio) = download_line(kind, done, total);
    push(app, kind, text, ratio);
}

/// 下载行的唯一渲染点（纯函数，可离线穷举）。`total` 为 None 或小于已取回量时只报已取回量、
/// 比值发 null：`into_reader()` 在 chunked 传输下会忽略 Content-Length 一路读到流结束，
/// 服务端声称的总量可能偏小。文案自相矛盾比少一根进度条糟糕得多。
pub(crate) fn download_line(kind: InstallKind, done: u64, total: Option<u64>) -> (String, Option<f32>) {
    let mb = |b: u64| b as f64 / 1048576.0;
    match total.filter(|t| *t > 0 && done <= *t) {
        Some(t) => {
            let ratio = (done as f32 / t as f32).min(1.0);
            (
                format!("正在下载 {}：{:.1} / {:.1} MB（{}%）…", kind.dl_label(), mb(done), mb(t), (ratio * 100.0) as u32),
                Some(ratio),
            )
        }
  // 服务端未给 Content-Length：只报已取回量（文字仍然可用），比值不猜。
        None => (format!("正在下载 {}：已取回 {:.1} MB…", kind.dl_label(), mb(done)), None),
    }
}

/// 事件 + 快照状态一起更新（`node_status` 读的就是这份快照）。
pub(crate) fn push(app: &tauri::AppHandle, kind: InstallKind, status: String, progress: Option<f32>) {
    {
        let state = app.state::<std::sync::Mutex<crate::RunState>>();
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.status = status.clone();
  // None = 无可测分母：快照里保持 null，而不是退化成 0（0 会被读成「还没开始」）。
        s.progress = progress;
        s.logs.push(status.clone());
    }
    emit_json(
        app,
        "install_progress",
        serde_json::json!({ "kind": kind.as_str(), "status": status, "progress": progress }),
    );
}

/// 完成播报（按 kind 各一条）：`version` 就是**该 kind 自己的**版本。
/// 旧实现发过一条 `kind=npm` 却带 node 版本 —— 同一句话有两个作者时就没人能对账。
/// 未回读到版本号时发 `null`：事实层不写「未知」的文案变体，怎么念由 UI 唯一出口决定。
pub(crate) fn done(app: &tauri::AppHandle, kind: InstallKind, version: serde_json::Value) {
    emit_json(app, "install_done", serde_json::json!({ "kind": kind.as_str(), "version": version }));
}

/// 失败播报：归属步骤 + 原文（前端据 kind 决定前缀，不在此拼文案）。
pub(crate) fn fail(app: &tauri::AppHandle, kind: InstallKind, error: &str) {
    emit_json(app, "install_error", serde_json::json!({ "kind": kind.as_str(), "error": error }));
}

/// npm 安装期心跳文案的唯一渲染点。`npm install` 不吐百分比，输出又重定向到临时文件（不经管道，
/// 见 bounded::run），所以能如实说的只有「已等多久 + 它自己写了多少行」——真实现场，不是编的阶段分数。
pub(crate) fn npm_heartbeat(elapsed: std::time::Duration, lines: usize, last_line: &str) -> String {
    let last = if last_line.is_empty() { String::new() } else { format!(" · 最后一行「{}」", last_line) };
    format!("npm 安装中 · 已用 {}s · 输出 {} 行{}", elapsed.as_secs(), lines, last)
}

/// 内核安装的开工行：把「在装什么、有几个源、上限多久」一次说清。耗时上界是已知的（单源
/// `core::NPM_INSTALL_TIMEOUT` 与 `bridge::KERNEL_UPDATE_BUDGET_MS`），写进文案用户才能判断该继续等还是换源。
/// 为什么数字从常量算而不是手写：预算的第二份文字账改一处就会出现「说的是 15 分钟、干的是 20 分钟」，
///  而那正是这条文案要防的事。
pub(crate) fn kernel_begin(app: &tauri::AppHandle, version: &str, origins: usize) {
    let per_source_min = crate::core::NPM_INSTALL_TIMEOUT.as_secs() / 60;
    let total_min = crate::bridge::KERNEL_UPDATE_BUDGET_MS / 60_000;
    stage(
        app,
        InstallKind::Kernel,
        &format!(
            "正在安装内核 v{}：共 {} 个镜像源，逐源尝试（单源上限 {} 分钟 · 总上限 {} 分钟）",
            version, origins, per_source_min, total_min
        ),
    );
}

/// 内核安装的**逐源行**（换源这件事必须可见：否则慢源看起来就像整体卡住）。
pub(crate) fn kernel_source(app: &tauri::AppHandle, tried: usize, total: usize, origin: &str) {
    stage(
        app,
        InstallKind::Kernel,
        &format!("正在安装内核 · 第 {}/{} 个源 {}", tried, total, origin),
    );
}

/// 内核包**取件前**的说明行：分母是该源自己声明的字节数，不是估的。
/// 「这个源没给校验值」也要上屏：只按字节数核对与按 SHA512 核对不是一回事，藏起来等于替源背书。
pub(crate) fn kernel_fetch(app: &tauri::AppHandle, version: &str, origin: &str, size: Option<u64>, verified: bool) {
    let size_txt = match size {
        Some(t) => format!("{:.1} MB", t as f64 / 1048576.0),
        None => "大小未知".to_string(),
    };
    stage(
        app,
        InstallKind::Kernel,
        &format!(
            "正在下载内核包 v{}（{} · 源 {} · {}）",
            version,
            size_txt,
            origin,
            if verified { "SHA512 核对" } else { "该源未给校验值，按字节数核对" }
        ),
    );
}

/// 取件完成行：进度条到此为止，后面是 npm 解包装链（没有字节分母，只能报心跳）。
/// 少了这一行就会留下「条走到 100% 后长时间不动」的观感，那与卡死无法区分。
pub(crate) fn kernel_fetched(app: &tauri::AppHandle, bytes: u64, verified: bool) {
    stage(
        app,
        InstallKind::Kernel,
        &format!(
            "内核包下载完成（{:.1} MB · {}）· npm 本地安装中…",
            bytes as f64 / 1048576.0,
            if verified { "SHA512 已核对" } else { "字节数已核对" }
        ),
    );
}

/// 真分母取件没成，退回 registry 直装：**降级原因必须上屏**，否则用户看到的是进度条凭空消失。
pub(crate) fn kernel_direct(app: &tauri::AppHandle, origin: &str, why: &str) {
    stage(
        app,
        InstallKind::Kernel,
        &format!("内核包未能直接下载（源 {} · {}）· 改用 npm registry 安装", origin, why),
    );
}

/// 完整工具链安装管线（ENV-TOOLCHAIN-INSTALL-STANDARD）：node 与 npm 顺序执行，缺一不可。返回运行期契约本身
/// （node 路径/版本 + npm 路径/参数/版本），外层每一条播报都从它取，「某个 kind 的版本」在管线里只存在一份事实。
/// npm 补不上时必须 Err：只校验 node 版本会把「node 在、npm 缺」判成成功，前端随后拿不存在的 npm 去装内核必然失败；
/// 失败经 `InstallFailure` 带上归属步骤，供 IPC 边界发 `install_error { kind, error }`。
pub(crate) fn run_install(app: &tauri::AppHandle) -> Result<crate::runtime_contract::NodeRuntime, InstallFailure> {
    stage(app, InstallKind::Node, "获取官方最新 LTS 版本…");
  // 1) 解析并安装/修复 node（latest_lts -> download_verified -> install 链路不变）。
    let choice = crate::node::latest_lts().map_err(InstallFailure::node)?;
    let version = choice.version.clone();
    let file = choice.file.clone();
  // 只记选用源：本轮实测延迟已随 stage 上屏，落盘再存一份时间戳就成了第二份「何时测的」事实
    crate::mirror::save(&crate::mirror::Mirrors {
        selected_node: Some(choice.source.clone()),
        ..crate::mirror::load()
    })
    .ok();
    stage(app, InstallKind::Node, &format!("选用镜像 {}（{}ms）", choice.source, choice.latency_ms));
    stage(app, InstallKind::Node, &format!("官方最新 LTS: {}", version));
    let dl_dir = crate::env::supervisor_dir().join("dl");
  // 归档**真的按块读**：每块把「已取回 / 总量」播报一次（无 Content-Length 时只报已取回量）。
    let a = app.clone();
    let on_bytes = move |done: u64, total: Option<u64>| download(&a, InstallKind::Node, done, total);
    let local = crate::node::download_verified(&version, &file, &dl_dir, Some(choice.source.as_str()), &on_bytes)
        .map_err(InstallFailure::node)?;
    stage(app, InstallKind::Node, "SHA256 校验通过，准备安装…");
    let node_bin = crate::node::install(&local).map_err(InstallFailure::node)?;
  // 安装后作废探测缓存：否则可能仍返回安装前记录的旧 Node（版本不一致，永不收敛）；
  //  校验/补 npm 的完整收尾在 node.rs（G3：main.rs 只做组装）。
  //  失效必须覆盖**全部**环境维度（B5）：只清 node 会留下旧 npm/前缀结论。
    super::probes::invalidate_all();
    stage(app, InstallKind::Npm, "正在校验 npm…");
  // 收尾返回**运行期契约**（node 与 npm 的路径/版本都出自一次真实探测）。
  //  这里不再自行拼「npm 已就绪（…）」：完成播报的唯一出口是 install_done，
  //  而该处曾把 Node 版本号当 npm 版本号念出去。
    let rt = crate::node::finalize_install(&node_bin, &version, &local)
        .map_err(|(is_npm, e)| if is_npm { InstallFailure::npm(e) } else { InstallFailure::node(e) })?;
    Ok(rt)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_line_with_denominator_reports_both_numbers_and_ratio() {
        let (text, ratio) = download_line(InstallKind::Node, 5 * 1024 * 1024, Some(20 * 1024 * 1024));
        assert!(text.contains("Node 官方归档"), "{}", text);
        assert!(text.contains("5.0 / 20.0 MB"), "{}", text);
        assert_eq!(ratio, Some(0.25));
  // 满额时比值必须恰好为 1（前端据此判断「取回完成」）。
        assert_eq!(download_line(InstallKind::Node, 20 * 1024 * 1024, Some(20 * 1024 * 1024)).1, Some(1.0));
    }

  /// 无分母 = **不发比值**。旧实现用 0.0 兼作「没有分母」，于是进度条要么不画、
  ///  要么在整段下载期间停在 0%（用户报的「看不到下载进度」之一就是它）。
    #[test]
    fn download_line_without_content_length_has_no_ratio() {
        let (text, ratio) = download_line(InstallKind::Shell, 3 * 1024 * 1024, None);
        assert_eq!(ratio, None);
        assert!(text.contains("已取回 3.0 MB"), "{}", text);
        assert!(!text.contains('/'), "无分母却出现分数量形式: {}", text);
  // 声称的总量为 0 同样视为无分母（否则比值会算出 inf）。
        assert_eq!(download_line(InstallKind::Node, 1024, Some(0)).1, None);
    }

  /// 服务端声称的总量**小于**已取回量（chunked 响应下 Content-Length 被忽略）：
  ///  退回无分母形态，绝不输出「12.0 / 8.0 MB」这种自相矛盾的进度。
    #[test]
    fn download_line_never_claims_more_than_the_denominator() {
        let (text, ratio) = download_line(InstallKind::Node, 12 * 1024 * 1024, Some(8 * 1024 * 1024));
        assert_eq!(ratio, None);
        assert!(text.contains("已取回 12.0 MB"), "{}", text);
    }

    #[test]
    fn npm_heartbeat_states_only_measurable_facts() {
        let s = npm_heartbeat(std::time::Duration::from_secs(95), 7, "npm http fetch GET 200");
        assert!(s.contains("已用 95s"), "{}", s);
        assert!(s.contains("输出 7 行"), "{}", s);
        assert!(s.contains("npm http fetch GET 200"), "{}", s);
  // 末行未知时不得留下空引号（那是 UI 层的破相，不是事实缺失）。
        assert!(!npm_heartbeat(std::time::Duration::from_secs(5), 0, "").contains("「」"));
    }

  /// 每个 kind 都必须有自己的下载名：否则新增一类可安装物时会静默复用别人的文案
  ///  （把「内核包」念成「npm 工具链」这类错，前端无从发现）。
    #[test]
    fn every_kind_has_its_own_labels() {
        let all = [InstallKind::Node, InstallKind::Npm, InstallKind::Kernel, InstallKind::Shell];
        let kinds: Vec<&str> = all.iter().map(|k| k.as_str()).collect();
        let labels: Vec<&str> = all.iter().map(|k| k.dl_label()).collect();
        assert_eq!(kinds, vec!["node", "npm", "kernel", "shell"], "kind 字面量是前端 INSTALL_TARGET 的键，不得改名");
        assert_eq!(labels.iter().collect::<std::collections::HashSet<_>>().len(), all.len(), "{:?}", labels);
    }
}
