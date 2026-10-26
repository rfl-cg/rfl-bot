export type CheckResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

export type ReadyResponse = {
  status: "ok" | "error";
  version: string;
  checks: Record<string, CheckResult>;
  worker: {
    lastHeartbeatAt: string | null;
    stale: boolean;
  };
};
