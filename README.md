# Refund Guard

**Refund Guard** is a Millennium plugin for Steam that monitors recent purchases for meaningful price drops and helps you evaluate them against configurable refund-rule thresholds.

It compares what you actually paid with the current Steam Store price whenever reliable purchase data is available, while keeping price-drop detection separate from refund-rule eligibility.

> Refund Guard provides decision support only. Valve/Steam makes the final refund eligibility decision.

## Features

- Resolves **Actual Paid** from Steam purchase history when an exact match can be established.
- Detects **editions and packages** using active Steam license information.
- Avoids comparing an edition purchase against the cheaper base-game price.
- Supports **standalone DLC** with conservative playtime handling when exact post-purchase playtime cannot be proven.
- Separates the **refund-rule check** from the **price-drop check**.
- Supports both **manual scanning** and opt-in **automatic scanning**.
- Sends native Steam notifications only for meaningful qualifying price drops.
- Prevents duplicate notifications for the same active opportunity.
- Preserves the last successful result during temporary Steam Store or library outages.
- Never submits a refund request automatically.

## How It Works

Refund Guard evaluates recent Steam purchases in a few stages:

1. Identify the purchase and determine whether it is a base game, edition/package, or standalone DLC.
2. Resolve the amount actually paid from Steam purchase history when a reliable exact match is available.
3. Fetch the current matching Steam Store price.
4. Compare the paid price and current price using the configured minimum price-drop threshold.
5. Evaluate the configured purchase-age and playtime rules separately.
6. Notify only when the resulting state qualifies under the user's notification settings.

The Steam Store discount percentage itself is not treated as a refund opportunity. What matters is whether the current matching price is meaningfully lower than the price paid.

## Safety by Design

Refund Guard is intentionally conservative:

- Edition/package purchases are never compared against the base-game price as a fallback.
- Prices in different currencies are not converted or compared automatically.
- Free or unavailable Store listings do not become fake 100% price-drop opportunities.
- Historical purchase data is tied to the purchase identity to avoid stale data after a refund and re-purchase.
- Contradictory internal classifications are blocked from becoming notifications.
- Saved results retained during a failed refresh cannot trigger new notifications.
- Automatic scanning includes failure backoff to avoid repeatedly hammering unavailable Steam services.

## Privacy

Refund Guard does not use an external analytics or telemetry service.

To resolve purchase history, the plugin can use the Steam client's existing authenticated web session. Authentication cookie values are used only in memory for the request and are **never logged or persisted by Refund Guard**.

Purchase, price, configuration, and notification state required by the plugin is stored locally through Millennium's plugin configuration system.

## Requirements

- Steam desktop client
- [Millennium](https://steambrew.app/) **3.4.1 or newer**
- Refund Guard **1.0.0**

## Installation

### Millennium Plugin Store

Once Refund Guard is listed in the official Millennium Plugin Store, install it directly from Millennium's plugin interface.

### Build from Source

Refund Guard uses the Millennium Starlight toolchain.

Requirements:

- [Bun](https://bun.sh/)
- Millennium installed locally

From the repository root:

```bash
bun install
bun run prepare
bun run build
```

The release build uses Starlight's release packaging mode. With `output_path = "auto"`, Starlight detects the local Millennium installation and installs the built plugin automatically.

Restart Steam after installation if required.

## Configuration

Refund Guard exposes its settings from the plugin's **CONFIG** tab.

| Setting | Purpose |
| --- | --- |
| Automatic scanning | Enables background checks while Steam is running |
| Scan interval | Controls how often an automatic scan may run |
| Include standalone DLC | Includes separately purchased DLC candidates |
| Strict eligibility | Limits notifications to price drops that also appear within configured rules |
| Refund window | Configurable purchase-age threshold |
| Playtime limit | Configurable playtime threshold |
| Minimum price drop | Minimum percentage decrease required for a meaningful price drop |

Manual **SCAN NOW** remains available regardless of the automatic scanning setting.

## Result States

Refund Guard deliberately keeps two questions separate:

**Refund rule check**  
Shows whether the purchase appears within or outside the configured age/playtime rules.

**Price check**  
Shows the resolved paid price, current matching price, potential savings, and whether the configured minimum drop has been reached.

A positive rule check is not a guarantee that Steam will approve a refund.

## Standalone DLC

Steam's refund treatment for DLC can depend on playtime in the underlying title after the DLC purchase.

When Refund Guard cannot prove the exact amount of post-purchase playtime, it reports the playtime evidence as **uncertain** rather than guessing.

## Compatibility

Refund Guard verifies its frontend, backend API, persisted-state schema, and minimum Millennium version before scanning. A mismatched or partially updated installation is blocked instead of running with incompatible components.

Current release compatibility:

- Plugin: **1.0.0**
- Backend API: **1**
- State schema: **1**
- Millennium: **3.4.1+**

## Development

Refund Guard is built with:

- TypeScript / React
- Lua
- Millennium
- Starlight

Useful commands:

```bash
bun run dev
bun run prepare
bun run build
```

## Author

**scravonix**

## Issues and Contributions

Bug reports and contributions are welcome through the GitHub repository.

When reporting a problem, include the Refund Guard and Millennium versions, the relevant Refund Guard log lines, and clear reproduction steps. Do not post Steam authentication cookies or other account credentials.

## Disclaimer

Refund Guard is an independent community project and is not affiliated with, endorsed by, or sponsored by Valve Corporation.

Steam and Valve are trademarks of Valve Corporation.