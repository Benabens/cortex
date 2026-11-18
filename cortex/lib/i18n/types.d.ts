import type { Locale } from "./locale";
import type { Messages } from "./messages";

// `use-intl/core` et non `use-intl` : l'index du paquet ne réexporte AppConfig que par
// `export *`, que l'augmentation de module ne traverse pas (clés et langue retombaient sur string).
declare module "use-intl/core" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
