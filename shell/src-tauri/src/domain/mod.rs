//! 业务层（平台无关）。分层与依赖方向是硬约束：commands -> domain -> platform -> infra。
//! `domain` 不得出现平台分支（门禁 G1，差异一律经 platform 层），也不得依赖 `commands`
//! （命令层只做校验与委托）。每个模块可独立测试，不与 Tauri 的 AppHandle 纠缠。
pub(crate) mod cli;
pub(crate) mod coreloc;
pub(crate) mod guardctl;
pub(crate) mod install;
pub(crate) mod localhttp;
pub(crate) mod probes;
pub(crate) mod windowing;
