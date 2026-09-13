import type { AlertSummary } from './platform-stats.service.ts';
import type {
  CappedMeasure,
  CapReferenceMeasure,
  InformationalMeasure,
  PlatformStatsDay,
  UncappedMeasure,
} from './thresholds.ts';

/**
 * Response mappers are the output allowlist — see
 * `.claude/rules/api-contract.md`. Nothing here is personal data, but a
 * field added to `PlatformStatsDay` later still must not reach a client
 * without a deliberate change to this file.
 */

export interface CappedMeasureResponse {
  readonly value: number;
  readonly cap: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

export interface UncappedMeasureResponse {
  readonly value: number;
  readonly threshold: number;
  readonly exceeded: boolean;
}

export interface InformationalMeasureResponse {
  readonly value: number;
}

export interface CapReferenceMeasureResponse {
  readonly value: number;
  readonly cap: number;
}

export interface PlatformStatsDayResponse {
  readonly date: string;
  readonly workerRequestsAccountWide: CappedMeasureResponse;
  readonly workerRequestsThisApp: InformationalMeasureResponse;
  readonly workerErrorsThisApp: UncappedMeasureResponse;
  readonly workerCpuTimeP99Us: CapReferenceMeasureResponse;
  readonly workerSubrequestsAvgPerInvocation: CappedMeasureResponse;
  readonly workerWallTimeP99Ms: InformationalMeasureResponse;
  readonly d1RowsRead: CappedMeasureResponse;
  readonly d1RowsWritten: CappedMeasureResponse;
  readonly d1StorageBytes: CappedMeasureResponse;
}

export interface UsageReportResponse {
  readonly days: readonly PlatformStatsDayResponse[];
}

export interface AlertSummaryResponse {
  readonly windowDays: number;
  readonly daysWithExceededThreshold: number;
}

function toCapped(measure: CappedMeasure): CappedMeasureResponse {
  return {
    value: measure.value,
    cap: measure.cap,
    threshold: measure.threshold,
    exceeded: measure.exceeded,
  };
}

function toUncapped(measure: UncappedMeasure): UncappedMeasureResponse {
  return { value: measure.value, threshold: measure.threshold, exceeded: measure.exceeded };
}

function toInformational(measure: InformationalMeasure): InformationalMeasureResponse {
  return { value: measure.value };
}

function toCapReference(measure: CapReferenceMeasure): CapReferenceMeasureResponse {
  return { value: measure.value, cap: measure.cap };
}

export function toPlatformStatsDayResponse(day: PlatformStatsDay): PlatformStatsDayResponse {
  return {
    date: day.date,
    workerRequestsAccountWide: toCapped(day.workerRequestsAccountWide),
    workerRequestsThisApp: toInformational(day.workerRequestsThisApp),
    workerErrorsThisApp: toUncapped(day.workerErrorsThisApp),
    workerCpuTimeP99Us: toCapReference(day.workerCpuTimeP99Us),
    workerSubrequestsAvgPerInvocation: toCapped(day.workerSubrequestsAvgPerInvocation),
    workerWallTimeP99Ms: toInformational(day.workerWallTimeP99Ms),
    d1RowsRead: toCapped(day.d1RowsRead),
    d1RowsWritten: toCapped(day.d1RowsWritten),
    d1StorageBytes: toCapped(day.d1StorageBytes),
  };
}

export function toUsageReportResponse(days: readonly PlatformStatsDay[]): UsageReportResponse {
  return { days: days.map(toPlatformStatsDayResponse) };
}

export function toAlertSummaryResponse(summary: AlertSummary): AlertSummaryResponse {
  return {
    windowDays: summary.windowDays,
    daysWithExceededThreshold: summary.daysWithExceededThreshold,
  };
}
