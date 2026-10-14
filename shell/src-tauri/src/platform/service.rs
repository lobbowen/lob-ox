use std::path::PathBuf;

pub trait ServiceControl: Send + Sync {
    
    fn kind(&self) -> &'static str;

    
    fn definition_path(&self) -> PathBuf;

    
    
    fn is_defined(&self) -> bool {
        self.definition_path().is_file()
    }

    
    
    fn ensure_defined(&self, spec: &crate::platform::LaunchSpec) -> Result<String, String>;

    // 注：此处曾有一个 fn start(&self) 契约。三个平台实现全仓零调用方
    // （所有启动路径统一走 spawn_daemon / ensure_defined），且三份实现彼此逐行雷同，
    // 却与 spawn_daemon 的语义重叠——保留它等于留一条谁都不用、语义又不唯一的启动路径。
    // 契约与实现一并删除，让「启动只有 spawn_daemon 一条路」成为结构性事实。

    fn stop(&self) -> Result<(), String>;

    
    
    fn spawn_daemon(&self, spec: &crate::platform::LaunchSpec) -> Result<std::process::Child, String> {
        let mut cmd = std::process::Command::new(&spec.shell);
        cmd.arg("--run-guard")
            .env("DSH_SUPERVISOR_HOME", &spec.state_root);
        crate::platform::guard_stdio(&mut cmd);
        crate::bounded::prepare(&mut cmd);
        cmd.spawn().map_err(|e| {
            format!("直接拉起守卫失败: {}（{} --run-guard）", e, spec.shell.display())
        })
    }
}
