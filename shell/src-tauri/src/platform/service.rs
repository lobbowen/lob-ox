use std::path::PathBuf;

pub trait ServiceControl: Send + Sync {
    
    fn kind(&self) -> &'static str;

    
    fn definition_path(&self) -> PathBuf;

    
    
    fn is_defined(&self) -> bool {
        self.definition_path().is_file()
    }

    
    
    fn ensure_defined(&self, spec: &crate::platform::LaunchSpec) -> Result<String, String>;

    fn start(&self) -> Result<(), String>;

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
