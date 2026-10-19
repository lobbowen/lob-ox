import { StartupCard } from "./settings/StartupCard";
import { RegistryCard } from "./settings/RegistryCard";
import { AboutCard } from "./settings/AboutCard";
// E3：数据目录权限收口三态卡（product-manager 裁放设置页）。
import { DataAccessCard } from "./settings/DataAccessCard";

export function SettingsPage() {
  return (
    <div className="grid content-start gap-4">
      <StartupCard />
      <RegistryCard />
      <DataAccessCard />
      <AboutCard />
    </div>
  );
}
