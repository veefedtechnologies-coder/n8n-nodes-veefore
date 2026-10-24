import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * The Veefore wire protocol, with no dependency on n8n.
 *
 * Kept free of n8n imports so it can be tested on its own and so the node is
 * a thin translation layer: it builds a `veefore.action/v1` request, signs the
 * agent's identity assertion, and reports what the gateway decided. It never
 * decides anything itself.
 *
 * Only `node:crypto` is used, which n8n permits for verified community nodes.
 */

/**
 * What the Veefore console hands out for n8n: the gateway, the agent key's ID
 * and its connection secret. The key identifies the agent, so no agent ID is
 * needed; the secret is the key's Ed25519 private half and never leaves n8n.
 */
export interface VeeforeCredentials {
  gatewayUrl: string;
  keyId: string;
  /** `vf_secret_…` from the console; a raw base64 PKCS#8 key or PEM also works. */
  secret: string;
}

/** Prefix the console puts on a connection secret, so it is recognisable. */
export const CONNECTION_SECRET_PREFIX = 'vf_secret_';
export const DEFAULT_GATEWAY_URL = 'https://gateway.veefore.com';

/** Reads the n8n credential's fields (`keyId`, `connectionSecret`, `gatewayUrl`). */
export function credentialsFromData(data: Record<string, unknown>): VeeforeCredentials {
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    gatewayUrl: text(data.gatewayUrl).trim() || DEFAULT_GATEWAY_URL,
    keyId: text(data.keyId),
    secret: text(data.connectionSecret),
  };
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type HttpFn = (request: {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}) => Promise<HttpResponse>;

/**
 * Where the call comes from. All of it is a claim: the gateway resolves the
 * runtime from its own binding for the authenticated agent and refuses a
 * connection id that does not match. Workflow and execution ids correlate the
 * action with the n8n execution in the audit trail.
 */
export interface RuntimeContext {
  connectionId: string | null;
  instance: string | null;
  workflowId: string | null;
  executionId: string | null;
  step: string | null;
}

export interface ActionInput {
  tool: string;
  action?: string;
  parameters: Record<string, unknown>;
  purpose?: string;
  idempotencyKey: string;
  approvalId?: string;
  authorizationId?: string;
  runtime: RuntimeContext;
  /** Decided with the other requests of this batch (one approval card). */
  batch?: ActionBatch;
}

/** The longest purpose the gateway takes. */
export const MAX_PURPOSE = 200;

/** Text cut to `max` characters, marked when cut. */
export function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

export class VeeforeGatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'VeeforeGatewayError';
  }
}

const TIMEOUT_MS = 30_000;
/**
 * An action can take a while on the gateway: renewing an OAuth token, the
 * provider's own call, and lookups before it (Gmail's reply reads the message
 * first). Waiting less than that reports a timeout for an action that is
 * still running.
 */
const ACTION_TIMEOUT_MS = 120_000;

/** Pauses between attempts of a call that is safe to repeat. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

/**
 * A failure that says nothing about the request itself: a timeout, a dropped
 * connection, or a 5xx with no Veefore answer (the network in front of the
 * gateway). Repeating a safe call is the right response.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof VeeforeGatewayError) {
    return error.code === 'GATEWAY_UNREACHABLE' || error.code === 'NETWORK';
  }
  const text = String((error as { message?: unknown })?.message ?? error);
  const code = String((error as { code?: unknown })?.code ?? '');
  return (
    /timeout|timed out|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|network|aborted/i.test(
      text,
    ) || /^(ECONN|ETIMEDOUT|EAI_AGAIN|EPIPE|ECONNABORTED|ERR_NETWORK)/.test(code)
  );
}

/** The error to report: the gateway's own, or a network failure as one. */
function asGatewayError(error: unknown): VeeforeGatewayError {
  if (error instanceof VeeforeGatewayError) return error;
  const message = String((error as { message?: unknown })?.message ?? error);
  if (!isTransient(error)) return new VeeforeGatewayError(message, 0, null);
  return new VeeforeGatewayError(
    `Could not reach the Veefore gateway (${message}). Check Actions in the Veefore console before retrying; do not assume it did or did not happen.`,
    0,
    'NETWORK',
  );
}

/** Runs a call that is safe to repeat (a read, or a request carrying its idempotency key). */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  sleep?: (ms: number) => Promise<void>,
): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    let failure: unknown;
    try {
      return await attempt();
    } catch (error) {
      failure = error;
    }
    if (tries >= RETRY_DELAYS_MS.length || !isTransient(failure)) throw asGatewayError(failure);
    await sleep?.(RETRY_DELAYS_MS[tries]!);
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Same canonical form the gateway uses: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return 'null';
}

export function loadPrivateKey(raw: string): KeyObject {
  let value = raw.trim();
  if (value.startsWith('-----BEGIN')) return createPrivateKey({ key: value, format: 'pem' });
  if (value.startsWith(CONNECTION_SECRET_PREFIX))
    value = value.slice(CONNECTION_SECRET_PREFIX.length);
  let key: KeyObject | null = null;
  try {
    // Node's base64 decoder reads both the standard and the URL-safe alphabet.
    key = createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    key = null;
  }
  if (!key) {
    throw new VeeforeGatewayError(
      'The connection secret is not valid. Copy it again from the Veefore console.',
      0,
      'INVALID_CONNECTION_SECRET',
    );
  }
  return key;
}

/**
 * A compact EdDSA JWS over the identity assertion, valid for two minutes.
 * The subject is the key: the gateway resolves the agent from it.
 */
export function createAssertion(credentials: VeeforeCredentials, now = new Date()): string {
  const keyId = credentials.keyId.trim();
  const header = { alg: 'EdDSA', kid: keyId, typ: 'veefore-assertion+jwt' };
  const payload = {
    sub: keyId,
    aud: normalizeGateway(credentials.gatewayUrl),
    purpose: 'agent_authentication',
    nonce: randomBytes(16).toString('hex'),
    iat: now.toISOString(),
    exp: new Date(now.getTime() + 120_000).toISOString(),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(canonicalJson(payload))}`;
  const signature = sign(null, Buffer.from(signingInput), loadPrivateKey(credentials.secret));
  return `${signingInput}.${b64url(signature)}`;
}

export function normalizeGateway(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Which identity a session token was issued for. Changing the gateway, agent,
 * key ID or private key changes it, so a token minted for the old values is
 * never presented for the new ones.
 */
export function identityFingerprint(credentials: Partial<VeeforeCredentials>): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        gateway: normalizeGateway(String(credentials.gatewayUrl ?? '')),
        key: String(credentials.keyId ?? '').trim(),
        secret: createHash('sha256')
          .update(String(credentials.secret ?? '').trim())
          .digest('hex'),
      }),
    )
    .digest('hex');
}

/** The idempotency key for replaying an approved action (must differ from the original). */
export function approvalReplayKey(original: string, approvalId: string): string {
  const composed = `${original}:approved:${approvalId}`;
  if (composed.length <= 200) return composed;
  return `${createHash('sha256').update(composed).digest('hex')}:approved`;
}

export interface IdempotencyScope {
  /** n8n's instance id: execution ids only count up within one instance. */
  instanceId: string | null;
  workflowId: string | null;
  executionId: string | null;
  node: string;
  itemIndex: number;
  tool: string;
  action?: string;
  parameters: Record<string, unknown>;
}

/**
 * The default idempotency key: the same request from the same step, item and
 * execution on the same n8n instance gets the same key, so a retried step
 * cannot act twice. A different instance, workflow or execution, or different
 * arguments (an AI agent calling the tool again with new ones), gets a new key.
 * Without an execution id there is nothing to dedupe against, so the key is
 * unique per call.
 */
export function itemIdempotencyKey(scope: IdempotencyScope, override?: string): string {
  if (override && override.trim().length > 0) return override.trim().slice(0, 200);
  const material = canonicalJson({
    instance: scope.instanceId,
    workflow: scope.workflowId,
    execution: scope.executionId ?? `none:${randomBytes(16).toString('hex')}`,
    node: scope.node,
    item: scope.itemIndex,
    tool: scope.tool,
    action: scope.action ?? null,
    parameters: scope.parameters,
  });
  return `n8n:${createHash('sha256').update(material).digest('hex')}`;
}

/** Requests decided together: one batch, its size, and which one this is. */
export interface ActionBatch {
  id: string;
  size: number;
  index: number;
  /** What this item is, for the person approving (a draft's subject). */
  label?: string;
}

/**
 * The batch of one action in one run: every request of the same action from
 * the same step of the same execution is shown to the approver as one card
 * and decided at once ("delete every draft"). Without an execution id, the
 * call is a batch of its own.
 */
export function runBatchId(scope: {
  instanceId: string | null;
  workflowId: string | null;
  executionId: string | null;
  node: string;
  tool: string;
}): string {
  const material = canonicalJson({
    instance: scope.instanceId,
    workflow: scope.workflowId,
    execution: scope.executionId ?? `none:${randomBytes(16).toString('hex')}`,
    node: scope.node,
    tool: scope.tool,
  });
  return `n8n_${createHash('sha256').update(material).digest('hex').slice(0, 32)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Session tokens per agent and gateway, reused until a minute before expiry. */
const tokenCache = new Map<string, CachedToken>();
const toolsCache = new Map<string, { at: number; tools: Array<Record<string, unknown>> }>();
const toolsInFlight = new Map<string, Promise<Array<Record<string, unknown>>>>();

/** How long the editor reuses the agent's tool list. */
export const EDITOR_TOOLS_MAX_AGE_MS = 60_000;

export class VeeforeGateway {
  private readonly base: string;

  constructor(
    private readonly credentials: VeeforeCredentials,
    private readonly http: HttpFn,
    /** How retries wait; n8n's own sleep in the node. */
    private readonly sleep?: (ms: number) => Promise<void>,
  ) {
    this.base = normalizeGateway(credentials.gatewayUrl);
    if (!this.credentials.keyId?.trim() || !this.credentials.secret?.trim()) {
      throw new VeeforeGatewayError(
        'Enter the Key ID and connection secret from the Veefore console.',
        0,
        'INVALID_REQUEST',
      );
    }
    if (!/^https?:\/\//.test(this.base)) {
      throw new VeeforeGatewayError(
        'The gateway URL must start with http:// or https://.',
        0,
        'INVALID_REQUEST',
      );
    }
  }

  private cacheKey(): string {
    return `${this.base}|${this.credentials.keyId.trim()}`;
  }

  async token(force = false): Promise<string> {
    const cached = tokenCache.get(this.cacheKey());
    if (!force && cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
    const response = await this.http({
      method: 'POST',
      url: `${this.base}/gateway/v1/token`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: {
        key_id: this.credentials.keyId.trim(),
        assertion: createAssertion(this.credentials),
        sdk: { name: 'n8n-nodes-veefore', runtime: 'n8n' },
      },
      timeoutMs: TIMEOUT_MS,
    });
    const data = unwrap(response) as { token?: string; expires_at?: string };
    if (!data?.token)
      throw new VeeforeGatewayError(
        'The gateway did not issue a session token.',
        response.status,
        null,
      );
    tokenCache.set(this.cacheKey(), {
      token: data.token,
      expiresAt: data.expires_at ? new Date(data.expires_at).getTime() : Date.now() + 600_000,
    });
    return data.token;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    timeoutMs = TIMEOUT_MS,
  ): Promise<HttpResponse> {
    let token = await this.token();
    const send = () =>
      this.http({
        method,
        url: `${this.base}${path}`,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body,
        timeoutMs,
      });
    let response = await send();
    // A token can expire or be superseded by a key rotation between calls.
    if (response.status === 401) {
      tokenCache.delete(this.cacheKey());
      token = await this.token(true);
      response = await send();
    }
    return response;
  }

  private actionBody(input: ActionInput): Record<string, unknown> {
    return {
      tool: input.tool,
      action: input.action || undefined,
      parameters: input.parameters,
      // A longer purpose is refused by the gateway: the start says enough.
      purpose: input.purpose?.trim() ? clip(input.purpose, MAX_PURPOSE) : undefined,
      idempotency_key: input.idempotencyKey,
      approval_id: input.approvalId,
      authorization_id: input.authorizationId,
      metadata: {
        via: 'n8n',
        runtime: {
          platform: 'n8n',
          connection_id: input.runtime.connectionId,
          instance: input.runtime.instance,
          workflow_id: input.runtime.workflowId,
          execution_id: input.runtime.executionId,
          step: input.runtime.step,
        },
        ...(input.batch
          ? {
              batch: {
                id: input.batch.id,
                size: input.batch.size,
                index: input.batch.index,
                ...(input.batch.label ? { label: clip(input.batch.label, 120) } : {}),
              },
            }
          : {}),
      },
    };
  }

  /** Dry run: nothing executes. ALLOW comes with a single-use authorization. */
  async authorize(input: ActionInput): Promise<Record<string, unknown>> {
    // Nothing executes, so there is nothing to make idempotent.
    const body = this.actionBody(input);
    delete body.idempotency_key;
    const response = await this.call('POST', '/gateway/v1/authorize', body);
    return unwrapDecision(response);
  }

  /** Executes through the full pipeline. A non-2xx means the action did not happen. */
  /**
   * Executes through the full pipeline. A non-2xx means the action did not happen.
   *
   * Every attempt carries the same idempotency key, so a call that timed out
   * after the gateway acted is not acted on twice: the repeat gets the
   * recorded result.
   */
  async execute(input: ActionInput): Promise<Record<string, unknown>> {
    const path = input.approvalId ? '/gateway/v1/actions/retry' : '/gateway/v1/actions';
    const body = this.actionBody(input);
    return withRetries(
      async () => unwrapDecision(await this.call('POST', path, body, ACTION_TIMEOUT_MS)),
      this.sleep,
    );
  }

  async approvalStatus(approvalId: string): Promise<Record<string, unknown>> {
    return withRetries(async () => {
      const response = await this.call(
        'GET',
        `/gateway/v1/approvals/${encodeURIComponent(approvalId)}`,
      );
      return unwrap(response) as Record<string, unknown>;
    }, this.sleep);
  }

  /**
   * Hands a held request over to Veefore: it carries it out itself if a
   * person approves it before the approval expires. Refused (409/422) for an
   * action Veefore does not perform.
   */
  async handOver(approvalId: string, input: ActionInput): Promise<Record<string, unknown>> {
    const body = this.actionBody({ ...input, approvalId: undefined });
    return withRetries(async () => {
      const response = await this.call(
        'POST',
        `/gateway/v1/approvals/${encodeURIComponent(approvalId)}/handover`,
        body,
      );
      return unwrap(response) as Record<string, unknown>;
    }, this.sleep);
  }

  /**
   * Reports what happened to an action n8n performed after Veefore allowed
   * it, so Veefore's Actions shows a failure instead of "allowed". Reported
   * once; repeating the same report is harmless.
   */
  async reportResult(
    actionId: string,
    result: { status: 'SUCCEEDED' | 'FAILED'; error?: string | null },
  ): Promise<Record<string, unknown>> {
    return withRetries(async () => {
      const response = await this.call(
        'POST',
        `/gateway/v1/actions/${encodeURIComponent(actionId)}/result`,
        { status: result.status, error: result.error ?? null },
      );
      return unwrap(response) as Record<string, unknown>;
    }, this.sleep);
  }

  /**
   * The agent's tools. `maxAgeMs` reuses a recent answer for the same key:
   * the editor asks for the list for every dropdown and parameter list, and a
   * fresh round trip each time made them slow to open. Runs always ask fresh.
   */
  async tools(options: { maxAgeMs?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const key = this.cacheKey();
    const cached = toolsCache.get(key);
    if (options.maxAgeMs && cached && Date.now() - cached.at < options.maxAgeMs) {
      return cached.tools;
    }
    // Concurrent dropdowns share one request.
    const inFlight = options.maxAgeMs ? toolsInFlight.get(key) : undefined;
    if (inFlight) return inFlight;
    const pending = (async () => {
      const response = await this.call('GET', '/gateway/v1/tools');
      return unwrap(response) as Array<Record<string, unknown>>;
    })();
    if (options.maxAgeMs) toolsInFlight.set(key, pending);
    try {
      const tools = await pending;
      toolsCache.set(key, { at: Date.now(), tools });
      return tools;
    } finally {
      if (toolsInFlight.get(key) === pending) toolsInFlight.delete(key);
    }
  }
}

function errorOf(response: HttpResponse): VeeforeGatewayError {
  const body = response.body as { error?: { code?: string; message?: string } } | null;
  return new VeeforeGatewayError(
    body?.error?.message ?? `The Veefore gateway answered ${response.status}.`,
    response.status,
    body?.error?.code ?? null,
  );
}

function unwrap(response: HttpResponse): unknown {
  if (response.status < 200 || response.status >= 300) throw errorOf(response);
  return (response.body as { data?: unknown } | null)?.data ?? null;
}

/**
 * Decisions come back with a body on 202/403/424 too. Those are answers, not
 * transport errors: return them so the node can report exactly what happened.
 * A 5xx without Veefore's body was answered by something in front of the
 * gateway; nothing says whether the action ran, so it is reported as such.
 */
function unwrapDecision(response: HttpResponse): Record<string, unknown> {
  const data = (response.body as { data?: Record<string, unknown> } | null)?.data;
  if (data && typeof data === 'object') return { ...data, http_status: response.status };
  const hasVeefore = Boolean((response.body as { error?: unknown } | null)?.error);
  if (!hasVeefore && response.status >= 500) {
    throw new VeeforeGatewayError(
      `No decision came back from Veefore (HTTP ${response.status} from the network in front of the gateway). Check Actions in the Veefore console before retrying; do not assume it did or did not happen.`,
      response.status,
      'GATEWAY_UNREACHABLE',
    );
  }
  throw errorOf(response);
}

/**
 * How long an AI agent's tool call waits for a person before answering the
 * chat. Beyond this the request is handed to Veefore, which carries it out
 * when it is approved.
 */
export const TOOL_APPROVAL_WAIT_MS = 2 * 60 * 1000;

/** Longest the node keeps one execution open for a person to decide. */
export const MAX_APPROVAL_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Waits for a person to decide an approval in Veefore. There is no timeout to
 * configure: the approval's own expiry (set by the policy that asked for it)
 * ends the wait (24 hours by default), capped at a week, as approvals are, so one cannot hold an
 * execution open forever.
 */
export async function waitForApproval(
  gateway: VeeforeGateway,
  approvalId: string,
  sleep: (ms: number) => Promise<void>,
  now: () => number = Date.now,
  /** Stop waiting after this long and report 'PENDING' (an AI agent in a chat). */
  maxWaitMs?: number,
): Promise<string> {
  const started = now();
  let deadline = started + MAX_APPROVAL_WAIT_MS;
  const giveUp = maxWaitMs === undefined ? Infinity : started + maxWaitMs;
  for (;;) {
    const approval = await gateway.approvalStatus(approvalId);
    const status = String(approval.status ?? 'PENDING');
    if (status !== 'PENDING') return status;
    if (typeof approval.expires_at === 'string') {
      const expires = new Date(approval.expires_at).getTime();
      // A few seconds' grace so the gateway, not this clock, rules on expiry.
      if (Number.isFinite(expires)) deadline = Math.min(deadline, expires + 5_000);
    }
    if (now() >= deadline) return 'EXPIRED';
    if (now() >= giveUp) return 'PENDING';
    const pollAfter = Number(approval.poll_after_ms ?? 5_000);
    await sleep(
      Math.min(
        Math.max(pollAfter, 1_000),
        15_000,
        Math.max(0, deadline - now()),
        Math.max(0, giveUp - now()),
      ),
    );
  }
}

export type Outcome = 'allowed' | 'refused' | 'approval';

/** Which way an execute or authorize answer goes: done, refused, or waiting for a person. */
export function outcomeOf(decision: Record<string, unknown>): Outcome {
  if (decision.outcome === 'APPROVAL_REQUIRED' || decision.result === 'REQUIRE_APPROVAL')
    return 'approval';
  if (decision.allowed === true || decision.result === 'ALLOW') return 'allowed';
  return 'refused';
}
