import { Config } from "./Config";
import { OTelLogger } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("provider-config");

function missingEnvKeys(keys: string[]): string[] {
  return keys.filter((key) => !process.env[key]);
}

const PROVIDER_CHECKS: {
  label: string;
  configFlag: keyof Config;
  missing: (config: Config) => string[];
}[] = [
  {
    label: "Azure",
    configFlag: "COST_ENABLED_AZURE",
    missing: () =>
      missingEnvKeys([
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
      ]).concat(
        process.env.AZURE_SUBSCRIPTION_ID || process.env.AZURE_COST_SCOPE
          ? []
          : ["AZURE_SUBSCRIPTION_ID or AZURE_COST_SCOPE"],
      ),
  },
  {
    label: "AlibabaCloud",
    configFlag: "COST_ENABLED_ALIBABACLOUD",
    missing: () =>
      missingEnvKeys(["ALIBABACLOUD_ACCESS_KEY_ID", "ALIBABACLOUD_SECRET_KEY"]),
  },
  {
    label: "GoogleCloud",
    configFlag: "COST_ENABLED_GOOGLECLOUD",
    missing: () =>
      missingEnvKeys([
        "GOOGLECLOUD_BILLING_PROJECT_ID",
        "GOOGLECLOUD_BILLING_DATASET",
        "GOOGLECLOUD_BILLING_TABLE",
      ]),
  },
  {
    label: "Cloudflare",
    configFlag: "COST_ENABLED_CLOUDFLARE",
    missing: () =>
      missingEnvKeys(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]),
  },
  {
    label: "GitHub",
    configFlag: "COST_ENABLED_GITHUB",
    missing: (config) =>
      missingEnvKeys(["GITHUB_TOKEN"]).concat(
        process.env.GITHUB_ACCOUNT || config.GITHUB_ACCOUNT
          ? []
          : ["GITHUB_ACCOUNT"],
      ),
  },
  {
    label: "DeepSeek",
    configFlag: "COST_ENABLED_DEEPSEEK",
    missing: () => missingEnvKeys(["DEEPSEEK_API_KEY"]),
  },
  {
    label: "Moonshot AI",
    configFlag: "COST_ENABLED_MOONSHOTAI",
    missing: () => missingEnvKeys(["MOONSHOTAI_API_KEY"]),
  },
  {
    label: "Z.AI",
    configFlag: "COST_ENABLED_ZAI",
    missing: () => missingEnvKeys(["ZAI_API_KEY"]),
  },
];

/**
 * Log a consolidated report of enabled providers with missing credentials at
 * startup so a misconfiguration is visible immediately instead of being
 * discovered one failed fetch at a time.
 * AWS is not checked: it relies on the SDK default credential chain.
 */
export function ValidateProviderConfigs(config: Config): void {
  const incomplete = PROVIDER_CHECKS.filter((check) => config[check.configFlag])
    .map((check) => ({ label: check.label, missing: check.missing(config) }))
    .filter(({ missing }) => missing.length > 0);

  if (incomplete.length === 0) {
    logger.info("All enabled providers have their required configuration");
    return;
  }
  for (const { label, missing } of incomplete) {
    logger.warn(
      `Provider ${label} is enabled but missing configuration: ${missing.join(", ")}`,
    );
  }
}
