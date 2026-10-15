/// 壳侧命令的唯一返回契约。
///
/// `ShellError` 已整体删除：它有 7 个 kind、三份 kind→字符串映射表（Serialize 字面量 /
/// Display 中文 / kind_label 英文）、七句硬编码 hint（probe 的 elapsed_ms、network 的 url
/// 都进不去），且与 LaunchError、裸 String、ok:false JSON 四套并存靠手工映射转换
/// —— 转换本身就会失真（KERNEL_MISSING 被映到 contract，提示「删除配置文件」，
/// 而内核缺失时无文件可删）。
///
/// 现在统一为 `Fault`（fault::Fault）：code 是稳定标识、level 决定消费侧处置、
/// hint 按码分支且参数化。
pub type ShellResult<T> = Result<T, crate::fault::Fault>;
