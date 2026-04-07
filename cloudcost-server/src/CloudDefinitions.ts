import { Span } from "@opentelemetry/sdk-trace-base";
import { AlibabaCloudGetMonthCurrent } from "./cloud/AlibabaCloudCost";
import { AWSGetMonthCurrent } from "./cloud/AWSCost";
import { AzureGetMonthCurrent } from "./cloud/AzureCost";
import { Config } from "./Config";

export type CloudCost = { total: number; services: Record<string, number> };

export type CloudDefinition = {
  key: string;
  label: string;
  configFlag: keyof Config;
  fetcher: (span: Span) => Promise<CloudCost>;
};

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
];

export const cost: Record<string, CloudCost> = {
  aws: { total: 0, services: {} },
  azure: { total: 0, services: {} },
  alibabacloud: { total: 0, services: {} },
};
