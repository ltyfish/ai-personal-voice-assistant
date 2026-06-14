// Shared types for the embedded email-summarizer.

export type MailAccount = {
  label: string;
  email: string;
  refreshToken?: string;
  lastPoll?: string;
};

export type MailConfig = {
  accounts: MailAccount[];
  vipSenders: { name: string; email: string; global?: boolean }[];
  categories: string[];
  notifications: {
    telegram: { enabled: boolean; botToken: string; chatId: string };
    whatsapp: {
      enabled: boolean;
      twilioSid: string;
      twilioToken: string;
      userPhone: string;
    };
    digestTimes: string[];
    instantAlertThreshold: number;
  };
  pollingIntervalMin: number;
};

export type Summary = {
  emailId: string;
  account: string;
  from: string;
  subject: string;
  summary: string;
  urgency: number;
  urgencyReason: string;
  category: string;
  actionItems: string[];
  requiresReply: boolean;
  deadlineMentioned: string | null;
  gmailLink?: string;
  gmailWebLink?: string;
  receivedAt: string;
  processedAt?: string;
  reviewed: boolean;
};

export type PollState = {
  accounts: Record<string, { lastPoll: string }>;
};

export type DigestState = {
  sent: Record<string, string>;
};

export type GroqUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type ModelLimits = {
  limitTokens?: number;
  remainingTokens?: number;
  resetTokens?: string;
  limitRequests?: number;
  remainingRequests?: number;
  resetRequests?: string;
  // Authoritative per-DAY token usage — Groq only reveals this in a 429 message,
  // so it's populated when we hit the daily cap, not on every call.
  dailyTokensUsed?: number;
  dailyTokensLimit?: number;
  dailyResetAt?: string; // ISO; when the daily token bucket should allow a retry
  capturedAt: string;
};

export type GroqStats = {
  today: {
    date: string;
    tokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
  } | null;
  allTime: { tokens: number; calls: number; days: number; firstDate: string | null };
  // Today's usage split per model.
  byModel: Record<string, { date: string; tokens: number; calls: number }>;
  // Lifetime usage split per model.
  byModelAllTime: Record<string, { tokens: number; calls: number }>;
  // Rolling log of recent calls (last hour) for per-minute rate math.
  events: { ts: number; tokens: number }[];
  // Latest rate-limit ceilings seen per model, from response headers.
  limits: Record<string, ModelLimits>;
};

// Shape the Groq summarizer needs from a raw fetched email.
export type RawEmailLike = {
  id: string;
  from: string;
  subject: string;
  body?: string;
  account?: string;
};
