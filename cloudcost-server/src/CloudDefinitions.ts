import { Span } from "@opentelemetry/sdk-trace-base";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { GoogleCloudGetMonthCurrent } from "./cloud/GoogleCloudCost";
import { CloudflareGetMonthCurrent } from "./cloud/CloudflareCost";
import { GitHubGetMonthCurrent } from "./cloud/GitHubCost";
import { Config } from "./Config";

export interface CloudCost {
  total: number;
  services: Record<string, number>;
}

export interface CloudDefinition {
  key: string;
  label: string;
  configFlag: keyof Config;
  fetcher: (span: Span, config?: Config) => Promise<CloudCost>;
}

export const CLOUDS: CloudDefinition[] = [
  {
    key: "aws",
    label: "AWS",
    configFlag: "COST_ENABLED_AWS",
    fetcher: AWSGetMonthCurrent,
  },
  {
    key: "azure",
    label: "Azure",
    configFlag: "COST_ENABLED_AZURE",
    fetcher: AzureGetMonthCurrent,
  },
  {
    key: "alibabacloud",
    label: "AlibabaCloud",
    configFlag: "COST_ENABLED_ALIBABACLOUD",
    fetcher: AlibabaCloudGetMonthCurrent,
  },
  {
    key: "googlecloud",
    label: "GoogleCloud",
    configFlag: "COST_ENABLED_GOOGLECLOUD",
    fetcher: GoogleCloudGetMonthCurrent,
  },
  {
    key: "cloudflare",
    label: "Cloudflare",
    configFlag: "COST_ENABLED_CLOUDFLARE",
    fetcher: CloudflareGetMonthCurrent,
  },
  {
    key: "github",
    label: "GitHub",
    configFlag: "COST_ENABLED_GITHUB",
    fetcher: GitHubGetMonthCurrent,
  },
];

export const deepseekBalances: Record<string, number> = {
  CNY: 0,
  USD: 0,
};

export const moonshotAIBalances: Record<string, number> = {
  USD: 0,
};

export const zaiBalances: Record<string, number> = {
  USD: 0,
};

export const cost: Record<string, CloudCost> = {
  aws: { total: 0, services: {} },
  azure: { total: 0, services: {} },
  alibabacloud: { total: 0, services: {} },
  googlecloud: { total: 0, services: {} },
  cloudflare: { total: 0, services: {} },
  github: { total: 0, services: {} },
};

export interface FetchStatus {
  success: boolean | null;
  lastSuccessTime: number | null;
}

// Latest fetch outcome per provider (`null` = no attempt yet), so staleness
// and repeated failures are visible in the metric stream.
export const fetchStatus: Record<string, FetchStatus> = {
  aws: { success: null, lastSuccessTime: null },
  azure: { success: null, lastSuccessTime: null },
  alibabacloud: { success: null, lastSuccessTime: null },
  googlecloud: { success: null, lastSuccessTime: null },
  cloudflare: { success: null, lastSuccessTime: null },
  github: { success: null, lastSuccessTime: null },
  deepseek: { success: null, lastSuccessTime: null },
  moonshotai: { success: null, lastSuccessTime: null },
  zai: { success: null, lastSuccessTime: null },
};

// GitHub currently has no documented API for a remaining raw-token balance.
// Keep the source extensible without substituting Copilot usage for a balance.
export const githubTokenBalance: { remaining: number | undefined } = {
  remaining: undefined,
};
