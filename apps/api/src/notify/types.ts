export type NotifyKind = 'DAILY' | 'ALERT';

export interface NotifyBinding {
  id: string;
  userId: string;
  kind: NotifyKind;
  provider: 'DISCORD';
  webhookUrl: string;
}

export interface DailyBriefPosition {
  fundCode: string;
  fundName: string;
  marketValue: number | null;
  dayReturn: number | null;
  navUpdated: boolean;
}

export interface DailyBrief {
  date: string;
  marketValue: number;
  dayReturn: number;
  holdingReturn: number;
  unavailableValueCount: number;
  positions: DailyBriefPosition[];
}

export interface AlertMessage {
  date: string;
  title: string;
  description: string;
}

export interface NotifyResult {
  ok: boolean;
  status: number | null;
  retried: boolean;
  error: string | null;
}

export interface Notifier {
  send(binding: NotifyBinding, brief: DailyBrief): Promise<NotifyResult>;
}
