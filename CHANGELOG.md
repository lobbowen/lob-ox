# Changelog

本文件的格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

> 说明：本文件由 `GET /guard/changelog` 直接读取并返回（见 `core/src/api/domains/guard.js`），
> 缺失会导致该接口运行时 404 —— 它是**运行时依赖**，不只是文档。

## [0.0.7] - 2026-10-09

> 修复轨迹：本版起让内核 CI（core-build-release）全绿——修复预存测试 flake 与两处真实回归、一处发布管线打包崩溃。

## [未发布]

### 修复（本轮架构整改）

本轮按根因重构，而非逐点打补丁。详见 `AUDIT_REPORT.md` 与 `REMEDIATION_DECISIONS.md`。

#### 加载与稳定性

- 修复 `platform/os/service.js` 引用未声明的 `NONE` —— 模块导出期即求值，
  导致任何平台 `require` 都抛 `ReferenceError`，内核与实例域无法加载
- 修复 `app/daemons/runtime.js` 的 `exitIntended` 回调引用未定义的 `host`
- 消除资源治理的**无限重启循环**：限额能力不支持时（`setLimits` 恒 false）只观测、不重启
- 消除实例域停止流程在 Windows 上"无法确认停止"导致的升级误判

#### 安全

- 令牌闸：未配置令牌不再放行（此前 `mode≠off` 且无令牌 ⇒ 无认证开放中继）
- 插件安装：禁用 npm 生命周期脚本（`--ignore-scripts`），且子进程不再继承父进程完整环境
- 插件 spec/name：接入与 `distribution/install.js` 一致的白名单校验
- 升级后健康校验：落到**身份匹配**（补传 pidFile/anchors），不再把"端口有人监听"当成实例在跑
- 远程访问令牌不再以明文写入日志

#### 数据与并发

- 引入 `Outcome` 三态与 `Lease`（归属/代际/验活）两个平台原语，
  修复"未知被当成成功"的一类缺陷（含 removeInstance 误报成功、instances.json 隔离误删新文件）
- 端口分配锁改为同步 test-and-set，锁回收前校验持锁进程存活
- 缓存的新鲜度/可写性/退避三维度解耦，修复用量计数被吞与索引永不刷新

### 变更

- 跨语言常量改为**单一数据文件** `shared/shared-constants.json`
  （Rust `include_str!` 编译期嵌入 + Node 运行时读取），不再双份镜像
- 进程构造收敛到 `ProcessSpec`（安全不变量内置于构造器）

## [0.0.6] - core / [1.0.8] - shell

- 产品更名：`dsh-supervisor` → `lobox`
- 服务管理器改为产品自身监控器，不再借 OS 通道（systemd / launchd / 任务计划程序）
