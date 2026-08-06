// Typed API client — one function per route in docs/04-api-spec.md, each
// validated against the Zod schema from @vyzus/shared that IS the contract.
//
// Contract gaps/notes found while building (see final report for detail):
//  - `GET /stats` and the WS `stats.updated` event are Phase 7 scope per
//    docs/06-implementation-plan.md and don't exist in apps/api yet. The
//    header's stats query and the realtime handler degrade gracefully
//    (stats simply stay absent) until that phase lands.
//  - `GET/PATCH /settings` is implemented in apps/api but is not documented in
//    docs/04-api-spec.md at all; used here since it exists and Phase 6 needs it.
import {
  loginResponseSchema,
  refreshResponseSchema,
  logoutResponseSchema,
  setupStatusResponseSchema,
  userSchema,
  userListSchema,
  userAppAccessSchema,
  appListSchema,
  appDetailSchema,
  enqueuedRunResponseSchema,
  checkListSchema,
  checkSchema,
  dryRunResultSchema,
  runSchema,
  runListResponseSchema,
  appRunListResponseSchema,
  incidentListSchema,
  incidentPageResponseSchema,
  channelListSchema,
  channelSchema,
  testChannelResponseSchema,
  alertDeliveryListSchema,
  settingsSchema,
  statsSchema,
  type LoginBody,
  type SetupBody,
  type User,
  type CreateUserBody,
  type UserAppAccess,
  type UpdateUserBody,
  type AppSummary,
  type AppDetail,
  type CreateAppBody,
  type UpdateAppBody,
  type Check,
  type CreateCheckBody,
  type UpdateCheckBody,
  type DryRunBody,
  type DryRunResult,
  type Run,
  type AppRun,
  type RunStatus,
  type Incident,
  type IncidentPageResponse,
  type Channel,
  type CreateChannelBody,
  type UpdateChannelBody,
  type AlertDelivery,
  type Settings,
  type UpdateSettingsBody,
  type Stats,
  type AppStatus,
} from '@vyzus/shared';
import { z } from 'zod';
import { apiRequest, apiRequestVoid } from './http';

// ---- Auth ----

export const authApi = {
  login: (body: LoginBody) => apiRequest('/auth/login', loginResponseSchema, { method: 'POST', body, anonymous: true }),
  refresh: () => apiRequest('/auth/refresh', refreshResponseSchema, { method: 'POST', anonymous: true }),
  logout: () => apiRequest('/auth/logout', logoutResponseSchema, { method: 'POST' }),
  me: () => apiRequest('/auth/me', userSchema),
  setupStatus: () => apiRequest('/auth/setup-status', setupStatusResponseSchema, { anonymous: true }),
  setup: (body: SetupBody) => apiRequest('/auth/setup', loginResponseSchema, { method: 'POST', body, anonymous: true }),
};

// ---- Users ----

export const usersApi = {
  list: () => apiRequest<User[]>('/users', userListSchema),
  create: (body: CreateUserBody) => apiRequest<User>('/users', userSchema, { method: 'POST', body }),
  update: (id: string, body: UpdateUserBody) => apiRequest<User>(`/users/${id}`, userSchema, { method: 'PATCH', body }),
  remove: (id: string) => apiRequestVoid(`/users/${id}`, { method: 'DELETE' }),
  getApps: (id: string) => apiRequest<UserAppAccess>(`/users/${id}/apps`, userAppAccessSchema),
  setApps: (id: string, appIds: string[]) =>
    apiRequest<UserAppAccess>(`/users/${id}/apps`, userAppAccessSchema, { method: 'PUT', body: { appIds } }),
};

// ---- Apps ----

export const appsApi = {
  list: (params: { tag?: string | undefined; status?: AppStatus | undefined } = {}) =>
    apiRequest<AppSummary[]>('/apps', appListSchema, { query: params }),
  get: (id: string) => apiRequest<AppDetail>(`/apps/${id}`, appDetailSchema),
  create: (body: CreateAppBody) => apiRequest<AppDetail>('/apps', appDetailSchema, { method: 'POST', body }),
  update: (id: string, body: UpdateAppBody) =>
    apiRequest<AppDetail>(`/apps/${id}`, appDetailSchema, { method: 'PATCH', body }),
  remove: (id: string) => apiRequestVoid(`/apps/${id}`, { method: 'DELETE' }),
  screenshotNow: (id: string) =>
    apiRequest<{ runId: string }>(`/apps/${id}/screenshot`, enqueuedRunResponseSchema, { method: 'POST' }),
  incidents: (id: string) => apiRequest<Incident[]>(`/apps/${id}/incidents`, incidentListSchema),
  reorderChecks: (id: string, checkIds: string[]) =>
    apiRequest<Check[]>(`/apps/${id}/checks/order`, checkListSchema, { method: 'PUT', body: { checkIds } }),
  runs: (
    id: string,
    params: {
      cursor?: string | undefined;
      limit?: number | undefined;
      status?: RunStatus | undefined;
      checkId?: string | undefined;
    } = {},
  ) =>
    apiRequest<{ runs: AppRun[]; nextCursor: string | null }>(`/apps/${id}/runs`, appRunListResponseSchema, {
      query: params,
    }),
};

// ---- Checks ----

export const checksApi = {
  listForApp: (appId: string) => apiRequest<Check[]>(`/apps/${appId}/checks`, checkListSchema),
  get: (id: string) => apiRequest<Check>(`/checks/${id}`, checkSchema),
  create: (appId: string, body: CreateCheckBody) =>
    apiRequest<Check>(`/apps/${appId}/checks`, checkSchema, { method: 'POST', body }),
  update: (id: string, body: UpdateCheckBody) =>
    apiRequest<Check>(`/checks/${id}`, checkSchema, { method: 'PATCH', body }),
  remove: (id: string) => apiRequestVoid(`/checks/${id}`, { method: 'DELETE' }),
  runNow: (id: string) =>
    apiRequest<{ runId: string }>(`/checks/${id}/run`, enqueuedRunResponseSchema, { method: 'POST' }),
  dryRun: (body: DryRunBody) =>
    apiRequest<DryRunResult>('/checks/dry-run', dryRunResultSchema, { method: 'POST', body }),
  runs: (
    checkId: string,
    params: {
      cursor?: string | undefined;
      limit?: number | undefined;
      status?: RunStatus | undefined;
      hasScreenshot?: boolean | undefined;
    } = {},
  ) => apiRequest(`/checks/${checkId}/runs`, runListResponseSchema, { query: params }),
};

// ---- Runs ----

export const runsApi = {
  get: (id: string) => apiRequest<Run>(`/runs/${id}`, runSchema),
  screenshotUrl: (id: string) => `/api/v1/runs/${id}/artifacts/screenshot`,
  traceUrl: (id: string) => `/api/v1/runs/${id}/artifacts/trace`,
};

// ---- Incidents ----

export const incidentsApi = {
  list: (
    params: {
      open?: boolean | undefined;
      appId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    } = {},
  ) =>
    apiRequest<IncidentPageResponse>('/incidents', incidentPageResponseSchema, {
      query: {
        open: params.open !== undefined ? String(params.open) : undefined,
        appId: params.appId,
        cursor: params.cursor,
        limit: params.limit,
      },
    }),
};

// ---- Channels ----

export const channelsApi = {
  list: () => apiRequest<Channel[]>('/channels', channelListSchema),
  create: (body: CreateChannelBody) => apiRequest<Channel>('/channels', channelSchema, { method: 'POST', body }),
  update: (id: string, body: UpdateChannelBody) =>
    apiRequest<Channel>(`/channels/${id}`, channelSchema, { method: 'PATCH', body }),
  remove: (id: string) => apiRequestVoid(`/channels/${id}`, { method: 'DELETE' }),
  test: (id: string) =>
    apiRequest<{ ok: boolean; responseCode: number | null }>(`/channels/${id}/test`, testChannelResponseSchema, {
      method: 'POST',
    }),
  deliveries: (id: string) => apiRequest<AlertDelivery[]>(`/channels/${id}/deliveries`, alertDeliveryListSchema),
};

// ---- Settings ----

export const settingsApi = {
  get: () => apiRequest<Settings>('/settings', settingsSchema),
  update: (body: UpdateSettingsBody) => apiRequest<Settings>('/settings', settingsSchema, { method: 'PATCH', body }),
};

// ---- Stats ----

export const statsApi = {
  get: () => apiRequest<Stats>('/stats', statsSchema),
};

// ---- Health (unauthenticated) ----

const healthSchema = z.object({ status: z.enum(['ok', 'degraded']), db: z.boolean(), redis: z.boolean() });
export const healthApi = {
  get: () => apiRequest('/health', healthSchema, { anonymous: true }),
};
