//! 业务层（平台无关）。分层与依赖方向是硬约束：commands -> domain -> platform -> infra。`domain` 不得出现平台分支（差异一律经 platform 层），也不得依赖 `commands`（命令层只做校验与委托）。
pub(crate) mod cli;
pub(crate) mod coreloc;
pub(crate) mod guardctl;
pub(crate) mod install;
pub(crate) mod localhttp;
pub(crate) mod probes;
pub(crate) mod windowing;
