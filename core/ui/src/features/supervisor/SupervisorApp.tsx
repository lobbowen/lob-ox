/** Supervisor App（dsh-supervisor 控制面板宿主）：以同源 supervisor HTTP API 为后端的 7 域面板。
 *  数据：supervisorStore 统一轮询快照，页面只读消费、动作经 supervisorApi；skiff 清理工具 App 是另一独立宿主，两者各自挂载（main.tsx 按宿主/路由选择）。 */
import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AppShell, AppLayout, AppSidebar, Toolbar, ContentArea, StatusBar,
  type SidebarItem,
} from "../../framework/layout";
import { CheckCircle2, Menu, Plus, Trash2 } from "lucide-react";
import { Button } from "../../framework/ui";
import skiffLogo from "../../assets/dsh-logo.svg";
import { toast } from "sonner";
import { supervisorStore, useSupervisorData } from "../../services/supervisor";
import { SUPERVISOR_NAV, type SupervisorViewKey } from "./nav";

// 功能页面按需分包（React.lazy），首包不含全部页面体积；
// 具名导出经 .then(m => ({ default: m.X })) 适配 lazy 的 default 契约。
const OverviewPage = lazy(() => import("./OverviewPage").then((m) => ({ default: m.OverviewPage })));
const InstancesPage = lazy(() => import("./InstancesPage").then((m) => ({ default: m.InstancesPage })));
const PluginsPage = lazy(() => import("./PluginsPage").then((m) => ({ default: m.PluginsPage })));
const RouterPage = lazy(() => import("./RouterPage").then((m) => ({ default: m.RouterPage })));
const TasksPage = lazy(() => import("./TasksPage").then((m) => ({ default: m.TasksPage })));
const LanPage = lazy(() => import("./LanPage").then((m) => ({ default: m.LanPage })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const PAGE_META: Record<SupervisorViewKey, { title: string; sub: string }> = {
  overview: { title: "控制面板", sub: "DeepSeek Harness 运行状态与升级" },
  instances: { title: "实例管理", sub: "管理本机的沙箱 DeepSeek Harness 实例" },
  plugins: { title: "插件商店", sub: "DeepSeek 生态插件商店与已装管理" },
  router: { title: "智能路由", sub: "多供应商 Key 轮换代理 · 按官方套餐规则自动判定额度" },
  tasks: { title: "任务中心", sub: "全部安装 / 升级 / 卸载 / 更新操作的任务状态与历史" },
  lan: { title: "远程控制", sub: "为本地 DeepSeek Harness 实例开启局域网反向代理访问" },
  settings: { title: "设置", sub: "开机行为与偏好" },
};

export function SupervisorApp() {
  const [view, setView] = useState<SupervisorViewKey>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [instancesActions, setInstancesActions] = useState<{ onAdd: () => void } | null>(null);
  const [routerActions, setRouterActions] = useState<{ onAdd: () => void; onDelete: () => void } | null>(null);
  const { snap } = useSupervisorData();
  const online = snap.online;
  const authFailed = snap.authFailed; // 401 鉴权被拒 != 离线，呈现可操作错误
  const status = snap.status;

  // 轮询生命周期与宿主绑定：start 只在装配层调用一次，卸载即 stop；
  // start->stop->start 幂等，兼容 React 19 StrictMode 开发双挂载。
  useEffect(() => {
    supervisorStore.start();
    return () => supervisorStore.stop();
  }, []);
  useEffect(() => { void supervisorStore.refresh(); }, [view]);

  const closeSidebar = () => setSidebarOpen(false);
  const items = useMemo<SidebarItem[]>(() => SUPERVISOR_NAV.map((n) => ({
    key: n.key,
    label: n.label,
    icon: n.icon,
    active: view === n.key,
    onClick: () => { setView(n.key); setSidebarOpen(false); },
  })), [view]);

  const meta = PAGE_META[view];
  const phase = status?.phase;
  const sessionState = status?.sessionState;
  const running = Boolean(status?.dshPid);

  // 共用壳架构：窗口栏唯一由壳框架 shell.html 提供；
  // 面板无论浏览器还是壳内 iframe 都统一 web 铺满纯内容，不自绘窗口栏。
  return (
    <AppShell mode="classic">
      <AppLayout
        sidebarOpen={sidebarOpen}
        onCloseSidebar={closeSidebar}
        sidebar={
          <AppSidebar
            brand={{ logo: skiffLogo, title: "DSH-SUP", slogan: "DeepSeek Harness 管家" }}
            items={items}
          />
        }
      >
        <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          <Toolbar
            title={meta.title}
            subtitle={meta.sub}
            actions={
              view === "instances" && instancesActions ? (
                <Button onClick={instancesActions.onAdd}>
                  <Plus className="size-4" />添加实例
                </Button>
              ) : view === "router" && routerActions ? (
                <>
                  {/* 添加/删除供应商: 小屏(<=640px)隐藏——供应商管理经卡片内操作(用户定稿) */}
                  <Button onClick={routerActions.onAdd} variant="outline" className="hidden md:inline-flex">
                    <Plus className="size-4" />添加供应商
                  </Button>
                  <Button className="hidden h-[34px] md:inline-flex" onClick={routerActions.onDelete} variant="destructive">
                    <Trash2 className="size-4" />删除供应商
                  </Button>
                </>
              ) : undefined
            }
            menuButton={
              <Button
                aria-label="打开导航"
                className="shrink-0 text-foreground"
                onClick={() => setSidebarOpen(true)}
                size="sm"
                variant="outline"
              >
                <Menu className="size-4" />
              </Button>
            }
          />
          <ContentArea className="flex-1">
            <div className="min-w-0">
              <Suspense fallback={<PageFallback />}>
                <PageErrorBoundary key={view}>
                  {view === "overview" ? <OverviewPage /> : null}
                  {view === "instances" ? <InstancesPage onRegisterActions={setInstancesActions} /> : null}
                  {view === "plugins" ? <PluginsPage /> : null}
                  {view === "router" ? <RouterPage onRegisterActions={setRouterActions} /> : null}
                  {view === "tasks" ? <TasksPage /> : null}
                  {view === "lan" ? <LanPage /> : null}
                  {view === "settings" ? <SettingsPage /> : null}
                </PageErrorBoundary>
              </Suspense>
            </div>
          </ContentArea>
          <StatusBar
            left={
              <>
                <CheckCircle2 className="size-3.5 text-muted-foreground" />
                <span className="font-mono text-xs leading-tight">{status?.guardVersion ?? "—"}</span>
              </>
            }
            right={
              // 安装标识（UUID）：灰度名单按它匹配（RELEASE-CHANNEL-CONTRACT），需完整可读、可复制上报。
              // StatusBar right 容器 overflow-hidden 且各页共用，故让 UUID 自身 shrink-0 不被截断；
              // 极窄窗口下被压缩的是运行状态文字（可读摘要，缩窄时整体转纵向布局）。
              <span className="inline-flex min-w-0 items-center gap-2">
                {status?.installId ? (
                  <button
                    type="button"
                    onClick={() => {
                      const id = String(status.installId);
                      // 127.0.0.1 属 secure context，clipboard 通常可用；
                      // 面板也可能经局域网别名/非常规来源打开，故保留回退路径。
                      const fallback = () => {
                        try {
                          const ta = document.createElement("textarea");
                          ta.value = id;
                          ta.style.position = "fixed";
                          ta.style.opacity = "0";
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand("copy");
                          document.body.removeChild(ta);
                          toast.success("已复制 UUID");
                        } catch {
                          toast.error("复制失败，请手动选择");
                        }
                      };
                      if (navigator.clipboard?.writeText) {
                        navigator.clipboard.writeText(id).then(() => toast.success("已复制 UUID"), fallback);
                      } else {
                        fallback();
                      }
                    }}
                    className="shrink-0 font-mono text-xs leading-tight text-muted-foreground transition-colors hover:text-foreground"
                    title={"本机安装标识（灰度测试用）：" + String(status.installId) + "\n点击复制"}
                  >
                    {String(status.installId)}
                  </button>
                ) : null}
                {
                  // 会话生命周期优先（INV-S4）：stopping/stopped 是整个服务链的运行相位，
                  // 比单看 main phase 准确（退出中 main 可能已 STOPPED），须明确呈现「退出中/已退出」。
                  sessionState === "stopping" ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                  管家正在退出（停止全部服务）…
                </span>
              ) : sessionState === "stopped" ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  管家已退出（服务已全部停止）
                </span>
              ) : online && running ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-status-ok" />
                  DSH 管家运行中{phase ? " · " + phase : ""}
                </span>
              ) : online ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-muted-foreground/50" />
                  DSH 管家已停止{phase ? " · " + phase : ""}
                </span>
              ) : authFailed ? (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-destructive" title="管家在运行，但本机未缓存有效访问密钥。请用带 ?access_key= 的链接重新进入，或在本机 127.0.0.1 面板更新密钥。">
                  <span className="size-1.5 rounded-full bg-destructive" />
                  访问密钥缺失或错误
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs leading-tight text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-destructive" />
                  管家离线
                </span>
              )
                }
              </span>
            }
          />
        </section>
      </AppLayout>
    </AppShell>
  );
}

function PageFallback() {
  return (
    <div className="grid min-h-[320px] place-items-center" aria-busy="true" role="status">
      <div className="flex flex-col items-center gap-2">
        <span className="size-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <span className="text-xs text-muted-foreground">加载中…</span>
      </div>
    </div>
  );
}

/** 页面级错误边界：lazy chunk 加载失败 / 页面运行时异常时兜底，不白屏 */
class PageErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[page] 渲染失败", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-[320px] place-items-center" role="alert">
          <div className="grid max-w-md justify-items-center gap-2 text-center">
            <strong className="text-sm font-semibold text-destructive">页面加载失败</strong>
            <p className="text-xs leading-relaxed text-muted-foreground">
              该页面组件未能加载。请刷新面板重试；若持续出现请联系排查。
            </p>
            <Button className="mt-1 h-8" size="sm" variant="outline" onClick={() => window.location.reload()}>
              刷新面板
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
