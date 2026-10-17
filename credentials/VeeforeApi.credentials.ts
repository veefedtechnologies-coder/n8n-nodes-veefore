import type {
  ICredentialDataDecryptedObject,
  ICredentialTestRequest,
  ICredentialType,
  IDataObject,
  IHttpRequestHelper,
  IHttpRequestOptions,
  INodeProperties,
} from 'n8n-workflow';
import {
  DEFAULT_GATEWAY_URL,
  VeeforeGateway,
  credentialsFromData as identityFrom,
  identityFingerprint,
  type HttpFn,
} from '../lib/veefore';

/** Adapts the helper n8n hands to `preAuthentication` to the protocol's HttpFn. */
function httpFrom(helper: IHttpRequestHelper): HttpFn {
  return async (request) => {
    const response = (await helper.helpers.httpRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body as IDataObject | undefined,
      json: true,
      timeout: request.timeoutMs,
      returnFullResponse: true,
      ignoreHttpStatusErrors: true,
    })) as { statusCode: number; headers: Record<string, string>; body: unknown };
    return { status: response.statusCode, headers: response.headers, body: response.body };
  };
}

/**
 * The agent's connection, held by n8n's encrypted credential store.
 *
 * Created in the Veefore console under Integrations → n8n, which shows the Key
 * ID and the connection secret once. The secret is the agent key's Ed25519
 * private half: it signs a two-minute identity assertion and grants nothing
 * else. Every action still goes through the agent's tools, policy, risk and
 * approvals at the gateway. Provider secrets (Gmail, Stripe, a database) stay
 * in the Veefore credential broker and never reach n8n.
 */
export class VeeforeApi implements ICredentialType {
  name = 'veeforeApi';

  displayName = 'Veefore API';

  documentationUrl = 'https://docs.veefore.com/build/n8n';

  icon = { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' } as const;

  properties: INodeProperties[] = [
    {
      displayName:
        'Create these in the Veefore console: Integrations → n8n → Connect n8n. The connection secret is shown once.',
      name: 'notice',
      type: 'notice',
      default: '',
    },
    {
      displayName: 'Key ID',
      name: 'keyId',
      type: 'string',
      default: '',
      placeholder: 'key_…',
      required: true,
      description: 'Identifies the Veefore agent this n8n acts as',
    },
    {
      displayName: 'Connection Secret',
      name: 'connectionSecret',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      placeholder: 'vf_secret_…',
      required: true,
      description: 'Proves this n8n holds the key. Never sent to Veefore: it only signs requests.',
    },
    {
      displayName: 'Gateway URL',
      name: 'gatewayUrl',
      type: 'string',
      default: DEFAULT_GATEWAY_URL,
      required: true,
      description: 'Change only for a self-hosted or regional Veefore',
    },
    {
      // Short-lived gateway session token, minted by `preAuthentication`.
      displayName: 'Session Token',
      name: 'sessionToken',
      type: 'hidden',
      typeOptions: { expirable: true, password: true },
      default: '',
    },
    {
      // Fingerprint of the identity fields the session token was issued for.
      displayName: 'Session Identity',
      name: 'sessionIdentity',
      type: 'hidden',
      default: '',
    },
  ];

  /**
   * Signs a two-minute identity assertion with the connection secret and
   * exchanges it at the gateway for a session token. A wrong Key ID, secret or
   * gateway fails here, so the credential test proves the connection, not
   * just that the gateway is reachable.
   */
  async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
    const identity = identityFrom(credentials);
    const gateway = new VeeforeGateway(identity, httpFrom(this));
    return {
      sessionToken: await gateway.token(true),
      sessionIdentity: identityFingerprint(identity),
    };
  }

  /**
   * Presents the stored session token only if it was issued for the values
   * currently in the form. After an edit the gateway gets no valid token,
   * answers 401, and n8n runs preAuthentication again with the new values, so
   * the test checks what was actually entered.
   */
  async authenticate(
    credentials: ICredentialDataDecryptedObject,
    requestOptions: IHttpRequestOptions,
  ): Promise<IHttpRequestOptions> {
    const current = identityFingerprint(identityFrom(credentials));
    const token =
      credentials.sessionToken && credentials.sessionIdentity === current
        ? String(credentials.sessionToken)
        : 'stale';
    return {
      ...requestOptions,
      headers: { ...(requestOptions.headers ?? {}), Authorization: `Bearer ${token}` },
    };
  }

  /** An authenticated read: lists the tools this agent may use. */
  test: ICredentialTestRequest = {
    request: {
      baseURL: `={{($credentials.gatewayUrl || "${DEFAULT_GATEWAY_URL}").replace(/\\/+$/, "")}}`,
      url: '/gateway/v1/tools',
      method: 'GET',
    },
  };
}
