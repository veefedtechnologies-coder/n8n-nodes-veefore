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
  VeeforeGateway,
  identityFingerprint,
  type HttpFn,
  type VeeforeCredentials,
} from '../lib/veefore';

function identityFrom(credentials: ICredentialDataDecryptedObject): VeeforeCredentials {
  return {
    gatewayUrl: String(credentials.gatewayUrl ?? ''),
    agentId: String(credentials.agentId ?? ''),
    keyId: String(credentials.keyId ?? ''),
    privateKey: String(credentials.privateKey ?? ''),
  };
}

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
 * The agent's identity, held by n8n's encrypted credential store.
 *
 * This is an *agent* credential: an Ed25519 private key that lets the
 * workflow prove it is one specific Veefore agent. It grants no authority of
 * its own — every request it signs still goes through the agent's
 * capabilities, policy, risk and approvals at the Veefore gateway — and it is
 * never a Veefore administrator credential. Provider secrets (Gmail, Stripe,
 * a database) stay in the Veefore credential broker and never reach n8n.
 */
export class VeeforeApi implements ICredentialType {
  name = 'veeforeApi';

  displayName = 'Veefore Agent API';

  documentationUrl = 'https://docs.veefore.com/build/n8n';

  icon = { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' } as const;

  properties: INodeProperties[] = [
    {
      displayName: 'Gateway URL',
      name: 'gatewayUrl',
      type: 'string',
      default: '',
      placeholder: 'https://gateway.veefore.com',
      required: true,
      description: 'The Veefore gateway (enforcement plane), not the console.',
    },
    {
      displayName: 'Agent ID',
      name: 'agentId',
      type: 'string',
      default: '',
      placeholder: 'agt_…',
      required: true,
    },
    {
      displayName: 'Key ID',
      name: 'keyId',
      type: 'string',
      default: '',
      placeholder: 'key_…',
      required: true,
      description: 'The identity key ID shown when the agent key was created or rotated.',
    },
    {
      displayName: 'Private Key',
      name: 'privateKey',
      type: 'string',
      typeOptions: { password: true, rows: 4 },
      default: '',
      required: true,
      description:
        'Ed25519 private key: base64 PKCS#8 as Veefore shows it, or PEM. Used only to sign a two-minute identity assertion.',
    },
    {
      displayName: 'Runtime Connection ID',
      name: 'runtimeConnectionId',
      type: 'string',
      default: '',
      placeholder: 'rtc_…',
      description:
        'The Veefore runtime this instance is registered as. Sent with each action so Veefore can check it matches the agent’s binding.',
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
   * Signs a two-minute identity assertion with the agent key and exchanges it
   * at the gateway for a session token. A wrong key, agent or gateway fails
   * here, so the credential test proves the identity, not just reachability.
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
   * Presents the stored session token only if it was issued for the identity
   * currently in the form. After an edit (another agent, key or gateway) the
   * gateway gets no valid token, answers 401, and n8n runs preAuthentication
   * again with the new values, so the test checks what was actually entered.
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

  /** An authenticated read: lists the tools this agent may attempt. */
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.gatewayUrl.replace(/\\/+$/, "")}}',
      url: '/gateway/v1/tools',
      method: 'GET',
    },
  };
}
