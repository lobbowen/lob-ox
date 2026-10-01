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
