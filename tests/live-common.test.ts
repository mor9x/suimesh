import { afterEach, describe, expect, test } from "bun:test";
import { liveNetwork, resolveSealServerConfigs, resolveSealThreshold } from "../scripts/live/live-common.ts";

const originalEnv = {
  SUIMESH_NETWORK: process.env.SUIMESH_NETWORK,
  SUIMESH_SEAL_SERVER_CONFIGS: process.env.SUIMESH_SEAL_SERVER_CONFIGS,
  SUIMESH_SEAL_THRESHOLD: process.env.SUIMESH_SEAL_THRESHOLD
};

afterEach(() => {
  restoreEnv("SUIMESH_NETWORK", originalEnv.SUIMESH_NETWORK);
  restoreEnv("SUIMESH_SEAL_SERVER_CONFIGS", originalEnv.SUIMESH_SEAL_SERVER_CONFIGS);
  restoreEnv("SUIMESH_SEAL_THRESHOLD", originalEnv.SUIMESH_SEAL_THRESHOLD);
});

describe("live common helpers", () => {
  test("rejects invalid live network values", () => {
    process.env.SUIMESH_NETWORK = "bogus";

    expect(() => liveNetwork()).toThrow("Invalid SUIMESH_NETWORK");
  });

  test("validates custom Seal server configs and thresholds", () => {
    process.env.SUIMESH_SEAL_SERVER_CONFIGS = JSON.stringify([
      { objectId: "0x1", weight: 1 },
      { objectId: "0x2", weight: 2 }
    ]);
    process.env.SUIMESH_SEAL_THRESHOLD = "3";

    const configs = resolveSealServerConfigs("testnet");

    expect(configs).toHaveLength(2);
    expect(resolveSealThreshold(configs)).toBe(3);
  });

  test("rejects impossible Seal thresholds", () => {
    process.env.SUIMESH_SEAL_THRESHOLD = "99";

    expect(() => resolveSealThreshold([{ objectId: "0x1", weight: 1 }])).toThrow("exceeds total Seal server weight");
  });
});

function restoreEnv(name: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
