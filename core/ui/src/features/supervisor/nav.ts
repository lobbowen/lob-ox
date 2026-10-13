import {
  Activity, Boxes, LayoutDashboard, ListChecks, Package, Settings, Wifi,
  type LucideIcon,
} from "lucide-react";

export type SupervisorViewKey =
  | "overview" | "instances" | "plugins" | "router" | "tasks" | "lan" | "settings";

export const SUPERVISOR_NAV: Array<{
  key: SupervisorViewKey;
  label: string;
  icon: LucideIcon;
}> = [
  { key: "overview", label: "控制面板", icon: LayoutDashboard },
  { key: "instances", label: "实例管理", icon: Boxes },
  { key: "plugins", label: "插件商店", icon: Package },
  { key: "router", label: "智能路由", icon: Activity },
  { key: "lan", label: "远程控制", icon: Wifi },
  { key: "tasks", label: "任务中心", icon: ListChecks },
  { key: "settings", label: "设置", icon: Settings },
];

export type Tone = "ok" | "warn" | "err" | "boot" | "off";
export const SUP_PHASE_META: Record<string, { label: string; tone: Tone }> = {
  RUNNING: { label: "运行中", tone: "ok" },
  STOPPED: { label: "已停止", tone: "off" },
  STARTING: { label: "启动中", tone: "boot" },
  OBSERVED: { label: "运行中（未监控）", tone: "ok" },
};

export function instancePhaseMeta(lp?: string, running?: boolean): { label: string; tone: Tone } {
  if (running) return { label: "运行中", tone: "ok" };
  if (lp === "INSTALLING") return { label: "安装中…", tone: "warn" };
  if (lp === "STARTING") return { label: "启动中…", tone: "boot" };
  if (lp === "FAILED") return { label: "失败", tone: "err" };
  return { label: "已停止", tone: "off" };
}

export const TASK_KIND_LABEL: Record<string, string> = {
  native: "原生 DSH", instance: "沙箱实例", plugin: "插件", "proxy-app": "反代应用",
};
export const TASK_ACTION_LABEL: Record<string, string> = {
  install: "安装", upgrade: "升级", uninstall: "卸载", update: "更新",
};
export const TASK_STATE_META: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "排队中", tone: "warn" },
  running: { label: "进行中", tone: "boot" },
  succeeded: { label: "成功", tone: "ok" },
  failed: { label: "失败", tone: "err" },
  skipped: { label: "已跳过", tone: "off" },
  canceled: { label: "已取消", tone: "off" },
};

const FAILURE_META: Record<string, string> = {
  manual: "手动重启", child_exit: "进程退出", adopted_exit: "实例退出",
  spawn_error: "启动失败", spawn_failed: "启动失败", desired_stopped: "按需停止", upgrade: "升级停服",
};
export function friendlyFailure(reason?: string | null): string {
  if (!reason) return "—";
  const r = String(reason);
  if (FAILURE_META[r]) return FAILURE_META[r];
  const mExit = /^exit:(.+)$/.exec(r);
  if (mExit) return /^sig/i.test(mExit[1]) ? "进程被终止" : "进程异常退出";
  if (/^spawn_error:/.test(r)) return "启动失败";
  return "异常";
}

export interface EventMeta { label: string; tone?: Tone; noise?: boolean }

// 单一事件表：label / tone / noise 三处消费合并到一处书写。
// 死键已按「core/src 是否真有 emit 点」逐键核验后清除，核验口径与
// core/test/contract-assertions-test.js 的 emit 正则一致。
// 注意：labels 子对象刻意保持 `key: "中文"` 形态 —— 契约测试
// 「core emit 的事件类型都被 UI EVENT_LABELS 覆盖」按该文本形态抓取，
// 改成 { label: "中文" } 会让该正向断言误判为「零覆盖」。
const EVENT_TABLE = {
  labels: {
    access_key_changed                : "访问密钥变更",
    account_banned                    : "账号封禁",
    account_discarded                 : "账号作废",
    account_frozen                    : "账号冻结",
    account_ready                     : "账号就绪",
    account_recovered                 : "账号恢复",
    account_status                    : "账号状态变更",
    adopted                           : "接管已运行实例",
    adopted_observed                  : "观测到运行实例",
    api_error                         : "API 错误",
    api_listening                     : "API 监听",
    api_offline                       : "API 下线",
    api_port_skew                     : "API 端口顺延",
    autostart_changed                 : "自启变更",
    close_action_changed              : "关闭动作变更",
    daemon_identity_write_error       : "守护身份写入失败",
    daemon_spawn_error                : "守护拉起错误",
    daemon_stop_timeout               : "守护停止超时",
    desired_changed                   : "期望变更",
    dist_contract_unavailable         : "分发契约不可用",
    dist_registry_choice_migrated     : "镜像选择文档迁移",
    dist_registry_selected            : "分发源选定",
    dist_registry_unreachable         : "镜像源不可达",
    external_browser_changed          : "外部浏览器变更",
    frpc_install_failed               : "frpc 安装失败",
    frpc_installed                    : "frpc 安装完成",
    frpc_restart_gaveup               : "内网穿透重启放弃",
    frpc_started                      : "frpc 启动",
    frpc_stopped                      : "frpc 停止",
    guard_exit                        : "守卫退出",
    guard_self_update_checked         : "DSH 自更新已检查",
    guard_started                     : "守卫启动",
    harness_command_bound             : "DSH 命令已绑定",
    harness_command_missing           : "命令缺失",
    harness_exited                    : "DSH 退出",
    harness_not_installed             : "DSH 未安装",
    harness_token_captured            : "令牌捕获",
    inst_added                        : "实例添加",
    inst_failed                       : "实例失败",
    inst_remote_changed               : "实例远程变更",
    inst_remote_token_changed         : "实例令牌变更",
    inst_remove_data_preserved        : "实例数据已保留",
    inst_removed                      : "实例删除",
    inst_restarted                    : "实例重启",
    inst_running                      : "实例运行中",
    inst_start_failed                 : "实例启动失败",
    inst_start_refused                : "实例启动被拒",
    inst_started                      : "实例启动",
    inst_startup_fail                 : "实例启动失败",
    inst_startup_failed               : "实例启动反复失败",
    inst_startup_retry                : "实例启动重试",
    inst_stop_failed                  : "实例停止失败",
    inst_stopped                      : "实例停止",
    inst_update_check                 : "实例检查更新",
    inst_upgraded                     : "实例已升级",
    lan_binding_lost                  : "远程绑定丢失",
    lan_cookie_exchanged              : "远程会话刷新",
    lan_cookie_failed                 : "远程会话失败",
    lan_daemon_started                : "远程监控启动",
    lan_daemon_stopped                : "远程监控停止",
    lan_frp_blocked                   : "公网安全闸拦截",
    lan_harness_token_updated         : "远程令牌更新",
    lan_instance_added                : "远程代理添加",
    lan_instance_removed              : "远程代理移除",
    lan_instance_started              : "远程代理启动",
    lan_instance_stopped              : "远程代理停止",
    lan_panel_changed                 : "远程面板变更",
    lan_relay_listen_failed           : "局域网监听失败",
    lan_token_updated                 : "远程令牌更新",
    main_meta_migrated                : "元数据迁移",
    main_port_adopted                 : "主端口接管",
    main_startup_failed               : "主实例启动失败",
    manual_restart_requested          : "手动重启",
    native_install_failed             : "DSH 安装失败",
    native_installed                  : "DSH 安装完成",
    orphan_audit                      : "孤儿实例审计",
    plugin_install_done               : "插件安装完成",
    plugin_install_job_failed         : "插件安装失败",
    plugin_install_started            : "插件安装开始",
    plugin_restart_done               : "插件服务重启完成",
    plugin_restart_failed             : "插件服务重启失败",
    plugin_restart_started            : "插件服务重启",
    plugin_uninstall_done             : "插件卸载完成",
    plugin_uninstall_job_failed       : "插件卸载失败",
    plugin_uninstall_started          : "插件卸载开始",
    plugin_update_done                : "插件更新完成",
    plugin_update_job_failed          : "插件更新失败",
    plugin_update_started             : "插件更新开始",
    port_occupied_unhealthy           : "端口被占",
    provider_quota_refreshed          : "额度已刷新",
    proxy_instance_failed             : "实例失败",
    proxy_instance_hang_restart       : "反代挂起重启",
    proxy_instance_key_in_argv_refused: "凭据禁入 argv 已拒绝启动",
    proxy_instance_log                : "反代日志",
    proxy_instance_start_port_busy    : "反代端口占用",
    proxy_instance_started            : "实例启动",
    proxy_instance_stopped            : "实例停止",
    proxy_instance_survivor_reclaimed : "残留反代回收",
    proxy_update_applied              : "反代已更新",
    proxy_update_available            : "反代有新版本",
    restart_triggered                 : "触发重启",
    router_daemon_started             : "中转监控启动",
    router_daemon_stopped             : "中转监控停止",
    router_daemon_supervised          : "中转监控接管",
    router_pick                       : "路由选中",
    router_provider_activated         : "供应商激活",
    router_provider_activation_failed : "供应商激活失败",
    router_provider_deactivated       : "供应商停用",
    router_provider_endpoint          : "独立端点上线",
    router_started                    : "中转启动",
    router_stopped                    : "中转停止",
    router_stream_aborted             : "流式中断",
    router_usage                      : "Token 消耗",
    running                           : "运行中",
    session_state                     : "会话状态",
    session_stopped                   : "会话已停止",
    shell_halt_on_external_stop       : "外部停止致停机",
    shell_update_checked              : "壳更新已检查",
    shutdown_all                      : "停止全部",
    shutdown_daemon_stop_incomplete   : "守护停止未完成",
    shutdown_npm_aborted              : "npm 任务已中止",
    shutdown_sandbox_stop_incomplete  : "沙箱停止未完成",
    sigkill_sent                      : "SIGKILL",
    sigterm_sent                      : "SIGTERM",
    spawn                             : "拉起",
    spawn_error                       : "拉起错误",
    spawn_failed                      : "拉起失败",
    spawned                           : "已拉起",
    state_corrected                   : "状态已纠正",
    stop                              : "停止",
    stop_failed                       : "停止失败",
    systemd_template_moved_aside      : "systemd 模板已移开",
    upgrade_done                      : "升级完成",
    upgrade_failed                    : "升级失败",
    upgrade_fresh_install             : "全新安装",
    upgrade_installed                 : "安装完成",
    upgrade_rollback_failed           : "回滚失败",
    upgrade_rollback_started          : "开始回滚",
    upgrade_skipped                   : "无需升级",
    upgrade_started                   : "开始升级",
    upgrade_stopping_harness          : "停止以升级",
} as Record<string, string>,
  tones: {
    account_banned             : "err",
    account_discarded          : "off",
    account_frozen             : "err",
    account_ready              : "ok",
    account_recovered          : "ok",
    adopted                    : "ok",
    api_error                  : "err",
    api_listening              : "ok",
    api_offline                : "err",
    frpc_install_failed        : "err",
    frpc_installed             : "ok",
    frpc_started               : "ok",
    frpc_stopped               : "off",
    guard_exit                 : "warn",
    guard_self_update_checked  : "ok",
    harness_exited             : "err",
    harness_not_installed      : "warn",
    inst_added                 : "ok",
    inst_failed                : "err",
    inst_remote_changed        : "warn",
    inst_remote_token_changed  : "warn",
    inst_removed               : "off",
    inst_restarted             : "warn",
    inst_running               : "ok",
    inst_start_failed          : "err",
    inst_started               : "ok",
    inst_stopped               : "off",
    inst_upgraded              : "ok",
    lan_frp_blocked            : "warn",
    lan_instance_removed       : "off",
    lan_instance_started       : "ok",
    main_startup_failed        : "err",
    native_install_failed      : "err",
    native_installed           : "ok",
    plugin_install_done        : "ok",
    plugin_install_job_failed  : "err",
    plugin_uninstall_done      : "off",
    plugin_uninstall_job_failed: "err",
    plugin_update_done         : "ok",
    plugin_update_job_failed   : "err",
    proxy_instance_failed      : "err",
    proxy_instance_started     : "ok",
    proxy_instance_stopped     : "off",
    proxy_update_applied       : "ok",
    proxy_update_available     : "warn",
    restart_triggered          : "warn",
    router_provider_activated  : "ok",
    router_provider_deactivated: "off",
    router_provider_endpoint   : "ok",
    router_stopped             : "off",
    router_stream_aborted      : "err",
    running                    : "ok",
    sigkill_sent               : "err",
    sigterm_sent               : "warn",
    spawn_error                : "err",
    spawn_failed               : "err",
    spawned                    : "ok",
    state_corrected            : "warn",
    stop                       : "off",
    stop_failed                : "err",
    upgrade_done               : "ok",
    upgrade_failed             : "err",
    upgrade_installed          : "ok",
    upgrade_skipped            : "off",
    upgrade_started            : "warn",
    upgrade_stopping_harness   : "warn",
} as Record<string, Tone>,
  noise: [
    "dist_registry_selected",
    "autostart_changed",
    "lan_panel_changed",
    "lan_harness_token_updated",
] as string[],
};

export const EVENT_META: Record<string, EventMeta> = (() => {
  const out: Record<string, EventMeta> = {};
  for (const [k, label] of Object.entries(EVENT_TABLE.labels)) out[k] = { label };
  for (const [k, tone] of Object.entries(EVENT_TABLE.tones)) {
    if (out[k]) out[k].tone = tone;
  }
  for (const k of EVENT_TABLE.noise) {
    if (out[k]) out[k].noise = true;
  }
  return out;
})();
