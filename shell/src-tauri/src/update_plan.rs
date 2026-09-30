//! 统一更新决策模型（桌面壳与内核同一形状）：artifact / current / latest / available / channel /
//! source / error，各侧特有键以 extra 附加。两侧旧实现返回不同 JSON，前端因此表现为两套流程。
//! 执行器按产物类型分派（壳 = Tauri updater，内核 = npm），但决策模型是一套。

use serde_json::{json, Map, Value};

/// 版本字面量 -> 发布通道词表（`-BETA.` / `-RC.`）。这是「版本号自己叫什么」，不是「被哪个 tag 选中」：
/// 后者由 `release_channel::Selected::via` 回答。回退目标 `0.1.5-BETA.6` 的名字是 beta 而通道是 rollback，
/// 混为一谈会让面板把「回退中」显示成「测试版」。`latest` / `rollback` 是通道身份、不出现在版本号里。
pub fn channel_of(version: Option<&str>) -> &'static str {
    match version {
        Some(v) if v.contains("-CANARY.") => "canary",
        Some(v) if v.contains("-BETA.") => "beta",
        Some(v) if v.contains("-RC.") => "rc",
        _ => "latest",
    }
}

/// 选版依据 -> 通道词。回答「这一版是怎么被选出来的」，故 `rollback` 只在显式回退 tag 生效时为真 ——
/// 这是「当前是否有回退在生效」唯一可靠的观测来源（版本号字面量回答不了）。
pub fn selected_channel_of(via: &str) -> &'static str {
    match via {
        "rollback" => "rollback",
        "canary" => "canary",
        "latest" => "latest",
  // versions 兜底不是"通道"，但作为**降级信号**必须可见（正常路径不该出现）。
        "versions" => "fallback",
        _ => "latest",
    }
}

/// 统一更新计划形状：公共键 + 各侧特有键（extra）。
pub fn unified(
    artifact: &str,
    current: Option<String>,
    latest: Option<String>,
    available: bool,
    source: Option<String>,
    error: Option<String>,
    extra: Map<String, Value>,
) -> Value {
  // 通道判定：有选版依据（extra.latestVia，由 latest_pick 带出）就用它，否则退回看版本名字
  // （桌面自更新等没有选版依据的场景）。版本号字面量答不了「当前是否回退中」。
    let via = extra.get("latestVia").and_then(|v| v.as_str());
    let channel = match via {
        Some(v) => selected_channel_of(v),
        None => channel_of(latest.as_deref().or(current.as_deref())),
    };
    let mut m = Map::new();
    m.insert("artifact".into(), json!(artifact));
    m.insert("current".into(), json!(current));
    m.insert("latest".into(), json!(latest));
    m.insert("available".into(), json!(available));
    m.insert("channel".into(), json!(channel));
    m.insert("source".into(), json!(source));
    m.insert("error".into(), json!(error));
    for (k, v) in extra {
        m.insert(k, v);
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_shape_is_stable() {
        let mut extra = Map::new();
        extra.insert("action".into(), json!("upgrade"));
        let v = unified(
            "kernel",
            Some("0.1.5-BETA.3".into()),
            Some("0.1.5-BETA.4".into()),
            true,
            Some("npm".into()),
            None,
            extra,
        );
        for k in ["artifact", "current", "latest", "available", "channel", "source", "error", "action"] {
            assert!(v.get(k).is_some(), "缺键 {}", k);
        }
        assert_eq!(v["artifact"], json!("kernel"));
        assert_eq!(v["channel"], json!("beta"));
        assert_eq!(v["available"], json!(true));
    }

    #[test]
    fn channel_of_is_single_vocabulary() {
        assert_eq!(channel_of(Some("0.1.5-BETA.4")), "beta");
        assert_eq!(channel_of(Some("1.1.0-RC.1")), "rc");
        assert_eq!(channel_of(Some("0.1.6-CANARY.1")), "canary");
        assert_eq!(channel_of(Some("1.1.0")), "latest");
        assert_eq!(channel_of(None), "latest");
  // rollback 是**通道身份**而非版本命名：版本字面量里不会出现它
  //  （见 selected_channel_of —— 那才是"回退是否生效"的判据）。
        assert_eq!(channel_of(Some("0.1.5-BETA.6")), "beta");
    }

  /// RELEASE-CHANNEL-CONTRACT 五通道词表：`selected_channel_of` 必须覆盖全部选版依据。
    #[test]
    fn selected_channel_covers_all_five_tags() {
        assert_eq!(selected_channel_of("rollback"), "rollback");
        assert_eq!(selected_channel_of("canary"), "canary");
        assert_eq!(selected_channel_of("latest"), "latest");
  // versions 兜底必须区别于 latest —— 否则面板会把"降级路径"显示成正常发布。
        assert_eq!(selected_channel_of("versions"), "fallback");
        assert_ne!(selected_channel_of("versions"), selected_channel_of("latest"));
  // 未知依据不得恐慌，回退到一个确定值
        assert_eq!(selected_channel_of("???"), "latest");
    }

  /// 反向（RC-G5 同族）：**回退中的版本**其 `channel_of` 仍是 beta，
  ///  但 `selected_channel_of` 必须是 rollback —— 二者不可互相替代。
    #[test]
    fn rollback_is_observable_even_when_version_name_looks_like_beta() {
        let v = Some("0.1.5-BETA.6");
        assert_eq!(channel_of(v), "beta");
        assert_eq!(selected_channel_of("rollback"), "rollback");
        assert_ne!(channel_of(v), selected_channel_of("rollback"));
    }
}
