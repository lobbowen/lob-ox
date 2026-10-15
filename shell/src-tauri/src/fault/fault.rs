//! 故障类型：code + 上下文 + **参数化** hint。

use super::code::{self, Code};
use crate::telemetry::Level;

/// 一条故障。既能返回给 IPC 调用方，也能落成事件、也能渲染成人话 ——
/// 三种形态同源，不再各自拼字符串（旧 ShellError 三份 kind 映射表、前端 errText
/// 只在有 kind 时才拿得到 hint，这三处正是能力丢失的地方）。
#[derive(Debug, Clone)]
pub struct Fault {
    pub code: Code,
    /// 上下文，进入事件的 data 字段，也是 hint 的参数来源。
    pub detail: String,
    /// 附加的结构化数据（如 stage、exit_code、elapsed_ms）。
    pub data: serde_json::Value,
}

impl Fault {
    pub fn new(code: Code, detail: impl Into<String>) -> Fault {
        Fault {
            code,
            detail: detail.into(),
            data: serde_json::Value::Null,
        }
    }

    /// 附加一个上下文字段。链式可读：
    /// `Fault::new(code, msg).with("elapsed_ms", ms)`
    pub fn with(mut self, k: &str, v: serde_json::Value) -> Fault {
        if !self.data.is_object() {
            self.data = serde_json::json!({});
        }
        if let Some(o) = self.data.as_object_mut() {
            o.insert(k.to_string(), v);
        }
        self
    }

    pub fn level(&self) -> Level {
        self.code.level
    }

    /// 面向用户的处置建议。**参数化** —— 与旧 ShellError 的七句硬编码不同，
    /// 这里会把具体耗时、路径、原因带进去，用户不必自己去猜是哪一步。
    pub fn hint(&self) -> String {
        let d = self.detail.as_str();
        let num = |k: &str| self.data.get(k).and_then(|v| v.as_u64());
        match self.code.id {
            "env.runtime_missing" => format!("Node 运行环境不可用（{}）。可点「重试」重新获取，或手动安装 Node 官方分发包后重启。", d),
            "env.node_unusable" => "Node 存在但不可用于本产品。可手动安装官方 LTS 后重试。".to_string(),
            "env.npm_unusable" => "Node 可用，但其配套 npm 不可用；安装内核时可能受影响。可重新安装 Node 官方分发包（自带 npm）后重试。".to_string(),
            "kernel.missing" => "未找到已安装的内核。请在引导页完成内核安装，或手动安装后重启。".to_string(),
            "kernel.launch_spec_failed" => format!("启动规格组装失败（{}）。这通常是环境契约损坏，可删除状态目录后重启自动重建。", d),
            "kernel.spawn_failed" => format!("无法拉起内核进程（{}）。请检查是否有安全软件拦截。", d),
            "kernel.exited" => match (self.data.get("exit").and_then(|v| v.as_i64()), num("elapsed_ms")) {
                (Some(c), Some(ms)) => format!("内核启动后即退出（退出码 {}，{} ms）。其输出见 guard.log。", c, ms),
                _ => "内核启动后即退出。其输出见 guard.log。".to_string(),
            },
            "kernel.daemon_exited_unready" => "内核进程已退出但从未就绪（可能正常 detach 后退出，仍需等待）。可查看 guard.log 末段确认。".to_string(),
            "kernel.ready_timeout" => match num("elapsed_ms") {
                Some(ms) => format!("内核在 {} ms 内未就绪（{}）。端口可能未打开，或 /healthz 未响应。", ms, d),
                None => format!("内核未就绪（{}）。", d),
            },
            "kernel.join_error" => format!("守卫启动任务异常：{}", d),
            "net.probe_timeout" => match num("elapsed_ms") {
                Some(ms) => format!("探测超时（>{} ms，阶段：{}）。可检查网络与代理设置后重试。", ms, d),
                None => format!("探测超时（阶段：{}）。可检查网络与代理设置后重试。", d),
            },
            "net.failed" => format!("网络请求失败（{}）。可切换镜像源后重试。", d),
            "net.transfer_failed" => format!("取件失败（{}）。已依次尝试各镜像源，可稍后重试或切换镜像。", d),
            "install.failed" => format!("安装失败（{}）。若为权限问题，请按系统提示完成授权后重试。", d),
            "contract.invalid" => format!("契约文件不可用（{}）。可删除对应文件后重启，系统会自动重建。", d),
            "ipc.param_invalid" => "前后端版本不一致导致的调用错误。请更新桌面壳到最新版本。".to_string(),
            "acl.denied" => format!("该能力未获授权（{}）。功能不可用，但不影响其余部分。", d),
            "platform.unsupported" => format!("当前平台不支持该能力（{}）。", d),
            _ => format!("{}", d),
        }
    }
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}（{}）", self.code.id, self.detail, self.hint())
    }
}

impl From<Fault> for String {
    fn from(x: Fault) -> String {
        x.to_string()
    }
}

impl serde::Serialize for Fault {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(5))?;
        m.serialize_entry("code", self.code.id)?;
        m.serialize_entry("level", self.code.level.tag())?;
        m.serialize_entry("detail", &self.detail)?;
        m.serialize_entry("hint", &self.hint())?;
        m.serialize_entry("data", &self.data)?;
        m.end()
    }
}

/// 从 LaunchError 归一。
///
/// LaunchError 的 8 个 code 是核心里程碑级的可操作性区分
///（读内核日志 / 重试 / 重装各不相同），全部并入 Fault 词表，不合并、不重命名。
/// 此前由调用方手工映射到 ShellError 的 kind，产生话术错配
///（KERNEL_MISSING 被映到 contract，提示「删除配置文件」，而无文件可删）。
impl From<crate::domain::guardctl::LaunchError> for Fault {
    fn from(e: crate::domain::guardctl::LaunchError) -> Fault {
        let c = match e.code {
            "RUNTIME_MISSING" => code::RUNTIME_MISSING,
            "KERNEL_MISSING" => code::KERNEL_MISSING,
            "LAUNCH_SPEC_FAILED" => code::LAUNCH_SPEC_FAILED,
            "KERNEL_SPAWN_FAILED" => code::KERNEL_SPAWN_FAILED,
            "KERNEL_EXITED" => code::KERNEL_EXITED,
            "DAEMON_EXITED_UNREADY" => code::DAEMON_EXITED_UNREADY,
            "READY_TIMEOUT" => code::READY_TIMEOUT,
            _ => code::JOIN_ERROR,
        };
        Fault::new(c, e.message)
    }
}
// ── 通用转换 ──────────────────────────────────────────────────────
//
// 壳内大量路径返回裸 String（platform/*.rs 全部如此），并在命令层用 `?` 直接上抛。
// 此前这些 `?` 落到 ShellError（它有 From<String>），换到 Fault 后必须补齐同样能力，
// 否则每个平台错误都要手写 map_err —— 那正是要消除的散落转换。
impl From<String> for Fault {
    fn from(detail: String) -> Fault {
        Fault::new(code::UNKNOWN, detail)
    }
}

impl From<&str> for Fault {
    fn from(detail: &str) -> Fault {
        Fault::new(code::UNKNOWN, detail)
    }
}

impl From<std::io::Error> for Fault {
    fn from(e: std::io::Error) -> Fault {
        Fault::new(code::CONTRACT_INVALID, format!("文件系统 · {}", e))
    }
}

impl From<tauri::Error> for Fault {
    fn from(e: tauri::Error) -> Fault {
        let msg = e.to_string();
        if msg.contains("not allowed by ACL") || msg.contains("not in the allowlist") {
            Fault::new(code::CAPABILITY_DENIED, msg)
        } else {
            Fault::new(code::IPC_PARAM_INVALID, msg)
        }
    }
}