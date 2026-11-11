/** The paths the forms post to. Each one is a route in the manifest with its own permission. */
export const ENDPOINTS = {
  createTemplate: "/documents/templates/create",
  updateTemplate: "/documents/templates/update",
  archiveTemplate: "/documents/templates/archive",
  saveProfile: "/documents/settings/save",
  testEngine: "/documents/settings/test-engine",
  createDocument: "/documents/create",
  send: "/documents/send",
  clearSend: "/documents/send/clear",
  refresh: "/documents/refresh",
} as const;
