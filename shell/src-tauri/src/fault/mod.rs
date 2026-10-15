//! 统一故障模型。
//!
//! 此前壳侧并存四套：ShellError（7 kind + hint）/ LaunchError（code + message）/
//! 裸 String（平台层全部返回）/ ok:false JSON（7 处绕过 Result）。四套之间靠手工映射
//! 转换，且转换会丢失语义 —— 例如 KERNEL_MISSING 被映到 Contract 的
//! 「删除该文件后重启」，而内核缺失时根本没有配置文件可删。
//!
//! 本模块的形态：**一套类型同时承载 code、level、hint**。
//!  - code   机器可判定的稳定标识（如 `kernel.not_ready`），跨版本不变；
//!  - level  消费侧处置依据（fatal 终止 / warn 降级继续）；
//!  - hint   面向用户的处置建议，**参数化** —— 旧 ShellError 的 hint 是七句
//!          硬编码常量，probe 的 elapsed_ms、network 的 url 都进不去。
//!
//! 内部沿用 ShellError 的 7 个 kind 与 LaunchError 的 8 个 code 作为 code 词表，
//! **不合并、不重命名** —— 它们是排障时的既有词汇表。
//!
pub mod code;
pub mod fault;
pub mod probe;

// 重导出：模块内另有 code / fault / probe 三个子模块，
// 不重导出的话调用方只能写 crate::fault::fault::Fault（同名嵌套），
// 反而比原来四套并存更难用。这里让 Fault / Probe 留在 fault:: 命名空间下。
pub use fault::Fault;
pub use probe::Probe;