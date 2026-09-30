/** 设置容器页：只做排版拼接，不持有数据/状态。
 *  StartupCard(启动+访问) / RegistryCard(镜像源) / AboutCard(关于) 各为自治组件：各自加载、各自失败，互不拖累。 */
import { StartupCard } from "./settings/StartupCard";
import { RegistryCard } from "./settings/RegistryCard";
import { AboutCard } from "./settings/AboutCard";

export function SettingsPage() {
  return (
    <div className="grid content-start gap-4">
      <StartupCard />
      <RegistryCard />
      <AboutCard />
    </div>
  );
}
