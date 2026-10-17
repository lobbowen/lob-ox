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
        // 一次性凭据（J-2 第 3 项）：每次 spawn 新生成，失败即拒。
        // 不用进程级单例——同一个壳会 spawn 多次，单例会让第二次复用同一值。
        let token = crate::platform::spawn_token()?;
        let mut cmd = std::process::Command::new(&spec.shell);
        cmd.arg("--run-guard")
            // 变量名必须走 brand::env_state_root()：内核侧 state-root.js:12 读的是
            // 同一份 shared-constants.json 的同一个键。字面量写在这里 = 绕过单源，
            // 改一侧漏一侧时壳设的名字与内核读的名字不一致，内核读不到状态根，
            // 全套状态文件静默漂到默认位置且无任何信号。
            .env(crate::brand::env_state_root(), &spec.state_root)
            .env(crate::platform::spawn_token_env(), &token);
        crate::platform::guard_stdio(&mut cmd);
        crate::bounded::prepare(&mut cmd);
        cmd.spawn().map_err(|e| {
            format!("直接拉起内核失败: {}（{} --run-guard）", e, spec.shell.display())
        })
    }
}
