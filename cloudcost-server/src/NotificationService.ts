import { NotificationsClient } from "@devopsplaybook.io/common-utils";
import { Config } from "./Config";
import { CLOUDS, cost } from "./CloudDefinitions";
import { LLM_BALANCE_SOURCES } from "./Metrics";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("notification-service");

let notificationClient: NotificationsClient | null = null;
let config: Config;

// Track the last notified threshold level to avoid spamming
// When cost crosses a threshold multiple (e.g., $10, $20, $30), notify once per multiple
let lastNotifiedThresholdMultiple = 0;

/**
 * Initialize the notification service.
 *
 * The shared client logs the integration status (enabled or disabled) once
 * at construction and never throws on partially configured settings.
 */
export function NotificationInit(configIn: Config): void {
  config = configIn;
  notificationClient = new NotificationsClient({
    apiEndpoint: config.NOTIFICATIONS_API,
    apiToken: config.NOTIFICATIONS_TOKEN,
    logger,
  });
}

/**
 * Check if the total cost has crossed a threshold and send a notification.
 * Notifies once per threshold multiple (e.g., $10, $20, $30) to avoid spam.
 */
export async function NotificationCheckThreshold(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  // Calculate total cost across all enabled clouds
  let totalCost = 0;
  for (const cloud of CLOUDS) {
    if (config[cloud.configFlag]) {
      totalCost += cost[cloud.key].total;
    }
  }

  const threshold = config.COST_NOTIFICATION_THRESHOLD;
  if (threshold <= 0) {
    return;
  }

  // Calculate which threshold multiple we've crossed
  const currentMultiple = Math.floor(totalCost / threshold);

  // Only notify if we've crossed a new threshold multiple
  if (currentMultiple > lastNotifiedThresholdMultiple && currentMultiple > 0) {
    lastNotifiedThresholdMultiple = currentMultiple;

    const thresholdAmount = currentMultiple * threshold;
    const breakdown = CLOUDS.filter((c) => config[c.configFlag])
      .map((c) => `${c.label}: $${cost[c.key].total.toFixed(2)}`)
      .join(", ");

    const title = `Cloud cost threshold reached: $${thresholdAmount.toFixed(2)}`;
    const body = `Total month-to-date cost has reached $${totalCost.toFixed(2)} (${breakdown})`;

    const response = await notificationClient.warning(
      title,
      body,
      "cloudcost",
    );
    if (response) {
      logger.info(`Threshold notification sent: ${title}`);
    }
  }
}

/**
 * Reset the threshold tracking (useful for testing or month rollover).
 */
export function NotificationResetThreshold(): void {
  lastNotifiedThresholdMultiple = 0;
}

const formatUsd = (amount: number): string => `$${amount.toFixed(2)}`;

/**
 * Build the Markdown body of the monthly cost summary from the latest known
 * in-memory metrics (the same data the OTel gauges in Metrics.ts expose).
 */
export function NotificationBuildSummaryBody(): string {
  const lines: string[] = [];
  const enabledClouds = CLOUDS.filter((cloud) => config[cloud.configFlag]);

  lines.push("## Month-to-date cloud costs", "");
  lines.push("| Cloud | Cost |", "| --- | --- |");
  let totalCost = 0;
  for (const cloud of enabledClouds) {
    totalCost += cost[cloud.key].total;
    lines.push(`| ${cloud.label} | ${formatUsd(cost[cloud.key].total)} |`);
  }
  lines.push(`| **Total** | **${formatUsd(totalCost)}** |`, "");

  lines.push("## Cost by service", "");
  for (const cloud of enabledClouds) {
    lines.push(`### ${cloud.label}`, "");
    lines.push("| Service | Cost |", "| --- | --- |");
    const serviceEntries = Object.entries(cost[cloud.key].services);
    if (serviceEntries.length === 0) {
      lines.push("| (none) | |");
    } else {
      for (const [service, amount] of serviceEntries) {
        lines.push(`| ${service} | ${formatUsd(amount)} |`);
      }
    }
    lines.push("");
  }

  lines.push("## LLM remaining credits", "");
  const currencies = new Set<string>();
  for (const source of LLM_BALANCE_SOURCES) {
    if (config[source.configFlag]) {
      for (const currency of Object.keys(source.balances)) {
        currencies.add(currency);
      }
    }
  }
  const currencyList = Array.from(currencies).sort();
  if (currencyList.length === 0) {
    lines.push("No LLM credit tracking enabled.");
  } else {
    lines.push(
      `| Provider | ${currencyList.join(" | ")} |`,
      `| ${currencyList.map(() => "---").join(" | ")} |`,
    );
    for (const source of LLM_BALANCE_SOURCES) {
      if (!config[source.configFlag]) {
        continue;
      }
      const cells = currencyList.map((currency) => {
        const value = source.balances[currency];
        return value !== undefined && value > 0 ? value.toFixed(2) : "-";
      });
      lines.push(`| ${source.provider} | ${cells.join(" | ")} |`);
    }
    const totalCells = currencyList.map((currency) => {
      let currencyTotal = 0;
      let hasCredit = false;
      for (const source of LLM_BALANCE_SOURCES) {
        if (!config[source.configFlag]) {
          continue;
        }
        const value = source.balances[currency];
        if (value !== undefined && value > 0) {
          currencyTotal += value;
          hasCredit = true;
        }
      }
      return hasCredit ? `**${currencyTotal.toFixed(2)}**` : "-";
    });
    lines.push(`| **Total** | ${totalCells.join(" | ")} |`);
  }

  return lines.join("\n");
}

/**
 * Send a Markdown summary of the latest known cost metrics for the month:
 * per-cloud month-to-date totals, per-service breakdown and LLM credits.
 * No-op when the notifications integration is disabled.
 */
export async function NotificationSendSummary(): Promise<void> {
  if (!notificationClient || !notificationClient.isEnabled()) {
    return;
  }

  const title = "Cloud cost monthly summary";
  const response = await notificationClient.info(
    title,
    NotificationBuildSummaryBody(),
    "cloudcost",
  );
  if (response) {
    logger.info("Monthly cost summary notification sent");
  }
}
