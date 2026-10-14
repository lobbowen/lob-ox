use tauri::{Emitter, Manager};

#[derive(Clone, Copy)]
pub(crate) enum InstallKind {
    Node,
    Npm,
    Kernel,
    Shell,
}

impl InstallKind {
    
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            InstallKind::Node => "node",
            InstallKind::Npm => "npm",
            InstallKind::Kernel => "kernel",
            InstallKind::Shell => "shell",
        }
    }

    fn dl_label(self) -> &'static str {
        match self {
            InstallKind::Node => "Node 官方归档",
            InstallKind::Shell => "桌面版本安装包",
            InstallKind::Kernel => "内核包",
            InstallKind::Npm => "npm 工具链",
        }
    }
}

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

fn emit_json(app: &tauri::AppHandle, event: &str, payload: serde_json::Value) {
    let _ = app.emit(event, payload);
}

pub(crate) fn stage(app: &tauri::AppHandle, kind: InstallKind, status: &str) {
    push(app, kind, status.to_string(), None);
}

pub(crate) fn download(app: &tauri::AppHandle, kind: InstallKind, done: u64, total: Option<u64>) {
    let (text, ratio) = download_line(kind, done, total);
    push(app, kind, text, ratio);
}

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
        None => (format!("正在下载 {}：已取回 {:.1} MB…", kind.dl_label(), mb(done)), None),
    }
}

pub(crate) fn push(app: &tauri::AppHandle, kind: InstallKind, status: String, progress: Option<f32>) {
    {
        let state = app.state::<std::sync::Mutex<crate::RunState>>();
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.status = status.clone();
        s.progress = progress;
        s.logs.push(status.clone());
    }
    emit_json(
        app,
        "install_progress",
        serde_json::json!({ "kind": kind.as_str(), "status": status, "progress": progress }),
    );
}

pub(crate) fn done(app: &tauri::AppHandle, kind: InstallKind, version: serde_json::Value) {
    emit_json(app, "install_done", serde_json::json!({ "kind": kind.as_str(), "version": version }));
}

pub(crate) fn fail(app: &tauri::AppHandle, kind: InstallKind, error: &str) {
    emit_json(app, "install_error", serde_json::json!({ "kind": kind.as_str(), "error": error }));
}

pub(crate) fn npm_heartbeat(elapsed: std::time::Duration, lines: usize, last_line: &str) -> String {
    let last = if last_line.is_empty() { String::new() } else { format!(" · 最后一行「{}」", last_line) };
    format!("npm 安装中 · 已用 {}s · 输出 {} 行{}", elapsed.as_secs(), lines, last)
}

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

pub(crate) fn kernel_source(app: &tauri::AppHandle, tried: usize, total: usize, origin: &str) {
    stage(
        app,
        InstallKind::Kernel,
        &format!("正在安装内核 · 第 {}/{} 个源 {}", tried, total, origin),
    );
}

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

pub(crate) fn kernel_direct(app: &tauri::AppHandle, origin: &str, why: &str) {
    stage(
        app,
        InstallKind::Kernel,
        &format!("内核包未能直接下载（源 {} · {}）· 改用 npm registry 安装", origin, why),
    );
}

pub(crate) fn run_install(app: &tauri::AppHandle) -> Result<crate::runtime_contract::NodeRuntime, InstallFailure> {
    stage(app, InstallKind::Node, "获取官方最新 LTS 版本…");
    let choice = crate::node::latest_lts().map_err(InstallFailure::node)?;
    let version = choice.version.clone();
    let file = choice.file.clone();
    crate::mirror::save(&crate::mirror::Mirrors {
        selected_node: Some(choice.source.clone()),
        ..crate::mirror::load()
    })
    .ok();
    stage(app, InstallKind::Node, &format!("选用镜像 {}（{}ms）", choice.source, choice.latency_ms));
    stage(app, InstallKind::Node, &format!("官方最新 LTS: {}", version));
    let dl_dir = crate::env::supervisor_dir().join("dl");
    let a = app.clone();
    let on_bytes = move |done: u64, total: Option<u64>| download(&a, InstallKind::Node, done, total);
    let local = crate::node::download_verified(&version, &file, &dl_dir, Some(choice.source.as_str()), &on_bytes)
        .map_err(InstallFailure::node)?;
    stage(app, InstallKind::Node, "SHA256 校验通过，准备安装…");
    let node_bin = crate::node::install(&local).map_err(InstallFailure::node)?;
    super::probes::invalidate_all();
    stage(app, InstallKind::Npm, "正在校验 npm…");
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
    
        assert_eq!(download_line(InstallKind::Node, 20 * 1024 * 1024, Some(20 * 1024 * 1024)).1, Some(1.0));
    }

    #[test]
    fn download_line_without_content_length_has_no_ratio() {
        let (text, ratio) = download_line(InstallKind::Shell, 3 * 1024 * 1024, None);
        assert_eq!(ratio, None);
        assert!(text.contains("已取回 3.0 MB"), "{}", text);
        assert!(!text.contains('/'), "无分母却出现分数量形式: {}", text);
        assert_eq!(download_line(InstallKind::Node, 1024, Some(0)).1, None);
    }

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
        assert!(!npm_heartbeat(std::time::Duration::from_secs(5), 0, "").contains("「」"));
    }

    #[test]
    fn every_kind_has_its_own_labels() {
        let all = [InstallKind::Node, InstallKind::Npm, InstallKind::Kernel, InstallKind::Shell];
        let kinds: Vec<&str> = all.iter().map(|k| k.as_str()).collect();
        let labels: Vec<&str> = all.iter().map(|k| k.dl_label()).collect();
        assert_eq!(kinds, vec!["node", "npm", "kernel", "shell"], "kind 字面量是前端 INSTALL_TARGET 的键，不得改名");
        assert_eq!(labels.iter().collect::<std::collections::HashSet<_>>().len(), all.len(), "{:?}", labels);
    }
}
