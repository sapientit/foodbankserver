/**
 * What the publish screen needs before it can read the configuration
 * workbook: the workbook itself and the OAuth client to ask Sheets consent
 * against — the same client the spreadsheet extract uses. Neither is a secret;
 * the server holds no Google credential and never reads the workbook.
 */
export interface WorkbookConfig {
  readonly spreadsheetId: string;
  readonly googleClientId: string;
}

export interface WorkbookConfigResponse extends Partial<WorkbookConfig> {
  /** False unless both are set; nothing can be published from the workbook. */
  readonly configured: boolean;
}

/**
 * All-or-nothing, as `extractConfig` is: a workbook with no OAuth client, or
 * the reverse, is a deployment that is not set up, and saying so beats letting
 * the browser fail at Google.
 */
export function toWorkbookConfigResponse(config: {
  readonly configurationSpreadsheetId: string | undefined;
  readonly googleClientId: string | undefined;
}): WorkbookConfigResponse {
  const { configurationSpreadsheetId, googleClientId } = config;
  if (configurationSpreadsheetId === undefined || googleClientId === undefined) {
    return { configured: false };
  }
  return {
    configured: true,
    spreadsheetId: configurationSpreadsheetId,
    googleClientId: googleClientId,
  };
}
