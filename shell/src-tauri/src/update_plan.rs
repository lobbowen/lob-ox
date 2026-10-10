use serde_json::{json, Map, Value};

pub fn channel_of(version: Option<&str>) -> &'static str {
    match version {
        Some(v) if v.contains("-CANARY.") => "canary",
        Some(v) if v.contains("-BETA.") => "beta",
        Some(v) if v.contains("-RC.") => "rc",
        _ => "latest",
    }
}

pub fn selected_channel_of(via: &str) -> &'static str {
    match via {
        "rollback" => "rollback",
        "canary" => "canary",
        "latest" => "latest",
        "versions" => "fallback",
        _ => "latest",
    }
}

pub fn unified(
    artifact: &str,
    current: Option<String>,
    latest: Option<String>,
    available: bool,
    source: Option<String>,
    error: Option<String>,
    extra: Map<String, Value>,
) -> Value {
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
        assert_eq!(channel_of(Some("0.1.5-BETA.6")), "beta");
    }

    #[test]
    fn selected_channel_covers_all_five_tags() {
        assert_eq!(selected_channel_of("rollback"), "rollback");
        assert_eq!(selected_channel_of("canary"), "canary");
        assert_eq!(selected_channel_of("latest"), "latest");
        assert_eq!(selected_channel_of("versions"), "fallback");
        assert_ne!(selected_channel_of("versions"), selected_channel_of("latest"));
        assert_eq!(selected_channel_of("???"), "latest");
    }

    
    #[test]
    fn rollback_is_observable_even_when_version_name_looks_like_beta() {
        let v = Some("0.1.5-BETA.6");
        assert_eq!(channel_of(v), "beta");
        assert_eq!(selected_channel_of("rollback"), "rollback");
        assert_ne!(channel_of(v), selected_channel_of("rollback"));
    }
}
