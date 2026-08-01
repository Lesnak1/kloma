export interface SchedulerControl {
  disable(): Promise<{ jobId: number; disabled: boolean }>;
}

interface CronJobSummary {
  jobId: number;
  title: string;
  url: string;
  enabled: boolean;
}

interface CronJobListResponse {
  jobs: CronJobSummary[];
  someFailed?: boolean;
}

interface CronJobDetailsResponse {
  jobDetails: CronJobSummary & { nextExecution?: number; lastStatus?: number; lastExecution?: number };
}

interface EnsureJobOptions {
  targetUrl: string;
  cronSecret: string;
  title?: string;
}

export class CronJobOrgError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CronJobOrgError";
  }
}

export class CronJobOrgClient implements SchedulerControl {
  static readonly title = "Loaf League Trader 24x7";
  private readonly baseUrl = "https://api.cron-job.org";

  constructor(
    private readonly apiKey: string,
    private readonly jobId?: number,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...init.headers,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      let message = `cron-job.org returned HTTP ${response.status}`;
      try {
        const payload = (await response.json()) as { error?: string; message?: string };
        message = payload.message ?? payload.error ?? message;
      } catch {
        // Status-only errors are intentionally safe to surface.
      }
      throw new CronJobOrgError(message, response.status);
    }
    if (response.status === 204) return {} as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async list(): Promise<CronJobSummary[]> {
    const result = await this.request<CronJobListResponse>("/jobs");
    return Array.isArray(result.jobs) ? result.jobs : [];
  }

  async details(jobId = this.jobId): Promise<CronJobDetailsResponse["jobDetails"]> {
    if (!jobId) throw new Error("CRONJOB_JOB_ID is required");
    const result = await this.request<CronJobDetailsResponse>(`/jobs/${jobId}`);
    return result.jobDetails;
  }

  async ensureMinuteJob(options: EnsureJobOptions): Promise<{ jobId: number; created: boolean }> {
    const title = options.title ?? CronJobOrgClient.title;
    const normalizedUrl = `${options.targetUrl.replace(/\/+$/, "")}/api/tick`;
    const jobs = await this.list();
    const existing =
      (this.jobId ? jobs.find((job) => job.jobId === this.jobId) : undefined) ??
      jobs.find((job) => job.title === title);
    const job = {
      title,
      url: normalizedUrl,
      enabled: true,
      saveResponses: false,
      requestMethod: 1,
      requestTimeout: 60,
      redirectSuccess: false,
      schedule: {
        timezone: "UTC",
        expiresAt: 0,
        hours: [-1],
        mdays: [-1],
        minutes: [-1],
        months: [-1],
        wdays: [-1],
      },
      notification: {
        onFailure: true,
        onFailureCount: 2,
        onSuccess: true,
        onDisable: true,
        onSslCertExpiry: true,
        onSslCertExpirySeconds: 604800,
      },
      extendedData: {
        headers: {
          Authorization: `Bearer ${options.cronSecret}`,
          "X-Bot-Compact": "1",
          "X-Scheduler": "cron-job.org",
        },
        body: "",
      },
    };

    if (existing) {
      await this.request<Record<string, never>>(`/jobs/${existing.jobId}`, {
        method: "PATCH",
        body: JSON.stringify({ job }),
      });
      return { jobId: existing.jobId, created: false };
    }

    const result = await this.request<{ jobId: number }>("/jobs", {
      method: "PUT",
      body: JSON.stringify({ job }),
    });
    return { jobId: result.jobId, created: true };
  }

  async disable(): Promise<{ jobId: number; disabled: boolean }> {
    if (!this.jobId) throw new Error("CRONJOB_JOB_ID is required for automatic shutdown");
    await this.request<Record<string, never>>(`/jobs/${this.jobId}`, {
      method: "PATCH",
      body: JSON.stringify({ job: { enabled: false } }),
    });
    return { jobId: this.jobId, disabled: true };
  }
}
